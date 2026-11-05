import { settleOpenCalls } from './settle-stale.js';
import {
  REPOSITORY_KINDS,
  WRITE_KINDS,
  REASON_CODE_CATEGORY,
  newId,
  type AnalysisReportDraft,
  type ArtifactRef,
  type BoundaryContext,
  canonicalJson,
  type DefinitionRef,
  type GraphNodeRecord,
  type RunSubagentsArgs,
  type KernelToWorkflowEvent,
  type PinnedDefinitionRef,
  type ProtectedCapability,
  type ReasonCode,
  type SessionCommandFailure,
  type SessionLogRecord,
  type TemplateDefinition,
  type SubmitUnitRequest,
  type ThinkingEffort,
  type UnitInput,
  type WorkflowGatewayPort,
  type WorkflowInboxEvent,
  type WorkflowSessionEvent,
  type WorkflowSystemEvent,
} from '@multiagentos/contracts';
import {
  answerRecord,
  closeAgent,
  receiveAgentReport,
  resumeAfterRefusal,
  resumeAfterSpawn,
  startAgent,
  type AgentConfig,
  type AgentContext,
  type AgentDefinitions,
  type AgentEnding,
  type AgentState,
  type AgentTransition,
  type ControlSource,
  type EndAction,
} from '../domain/agent/agent-cycle.js';
import {
  analysisFacts,
  degradedReportBody,
  normalReportBody,
  type AgentRounds,
} from '../domain/agent/analysis-report.js';
import { instructionsToLoad } from '../domain/context/nested-instructions.js';
import { toolInputOf } from '../domain/context/tool-inputs.js';
import {
  projectHistory,
  type ProjectionScope,
  type TaskScope,
} from '../domain/context/history-projection.js';
import { readableArtifacts } from '../domain/spawn/readable-artifacts.js';
import {
  finishedOutcome,
  outcomeOf,
  resultOf,
  unansweredCriteria,
  type TaskOutcome,
} from '../domain/spawn/task-results.js';
import { validateSpawn, type SpawnError } from '../domain/spawn/validate-spawn.js';
import {
  advanceGraph,
  chatGrowthPoint,
  chatGrowthRevision,
  compileTemplate,
  initialChatRevision,
  projectGraph,
  spawnRevision,
  type GraphRevision,
} from '../domain/graph/session-graph.js';
import {
  SessionStoreFailure,
  type NewLogRecord,
  type SessionLogStore,
} from './session-log-store.js';

/**
 * Every run of a Session on top of the session log (Module/Workflow 4-6, 9): one event at a time,
 * log first, then the projection, then syscalls. Turn-chat and templates differ only in how the
 * graph grows; all Agents share one AgentRun cycle and one kind of projection.
 */
const READS_REPOSITORY: ReadonlySet<string> = new Set(REPOSITORY_KINDS);

export interface AgentBinding {
  readonly ref: PinnedDefinitionRef;
  readonly modelRef: DefinitionRef;
  readonly effort: ThinkingEffort;
  readonly allowedEfforts: readonly ThinkingEffort[];
  readonly requestedCapabilities: readonly ProtectedCapability[];
  readonly writeRoots: readonly string[];
  readonly toolsDigest: string;
  readonly definitions: AgentDefinitions;
}

export interface SessionRunnerDeps {
  readonly gateway: WorkflowGatewayPort;
  readonly store: SessionLogStore;
  /** Built-in Agents by id; `chat` runs the one named `main`. */
  readonly agents: ReadonlyMap<string, AgentBinding>;
  /** Built-in templates by id. */
  readonly templates: ReadonlyMap<string, TemplateDefinition>;
  readonly definitionsDigest: string;
  readonly definitionVersions: readonly string[];
  readonly config: AgentConfig;
  readonly runtime: () => { readonly sandbox: string; readonly currentDate: string };
  /** What the probe found, for `SESSION_STARTED`. */
  readonly sandbox?: Extract<SessionLogRecord, { type: 'SESSION_STARTED' }>['sandbox'];
  readonly now?: () => Date;
  readonly newAgentRunId?: () => string;
}

const MAIN = 'main';

type HumanContentRef = Extract<SessionLogRecord, { type: 'HUMAN_ANSWERED' }>['contentRef'];

const contextOf = (sessionId: string, workflowRunId?: string): BoundaryContext => ({
  correlationId: newId('cor'),
  tenantId: 'local',
  projectId: 'local',
  sessionId,
  ...(workflowRunId === undefined ? {} : { workflowRunId }),
});

const asHumanRequestId = (nodeId: string): string => `hrq_${nodeId.slice('nod_'.length)}`;

/** How a node ends once its AgentRun closed. */
interface NodeEnding {
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly result?: Record<string, unknown>;
  /** The run's result when this node is its output. */
  readonly runOutput: boolean;
}

const OVER_BUDGET: readonly string[] = ['BUDGET_WRAP_UP', 'BUDGET_EXHAUSTED'];

/** A `run_subagents` call whose tasks have not all ended: its caller waits (M2Design 3.6). */
interface Waiting {
  readonly toolCallId: string;
  readonly delegationId: string;
  /** In the order the caller wrote them. */
  readonly tasks: readonly {
    readonly name: string;
    readonly nodeId: string;
    readonly agent: string;
  }[];
}

interface ActiveAgent {
  readonly state: AgentState;
  readonly nodeId: string;
  readonly scope: ProjectionScope;
  readonly agentId: string;
  readonly nodeEnding?: NodeEnding;
  readonly waiting?: Waiting;
  /** The task this AgentRun was started for, when it is a SubAgent. */
  readonly task?: { readonly name: string; readonly criteria: readonly string[] };
  /** What the Kernel reported this AgentRun changed (M2Design 3.7). */
  readonly changed: readonly string[];
  /** Files changed after the last successful command: a worker should check its work. */
  readonly unchecked: boolean;
  readonly completionAsked: boolean;
}

/** The same AgentRun once its tasks are over. */
function withoutWaiting(active: ActiveAgent): ActiveAgent {
  return Object.fromEntries(
    Object.entries(active).filter(([key]) => key !== 'waiting'),
  ) as unknown as ActiveAgent;
}

export class SessionRunner {
  readonly #deps: SessionRunnerDeps;
  #sessionId: string | undefined;
  #repositoryRoot = '';
  #records: SessionLogRecord[] = [];
  #mode: 'CHAT' | 'ORCHESTRATION' = 'CHAT';
  #turnId: string | undefined;
  /** Every AgentRun that has not ended, by id: SubAgents run beside the AgentRun that spawned them. */
  readonly #agents = new Map<string, ActiveAgent>();
  /** What this Turn spawned so far (M2Design 3.6). */
  #spawned = { tasks: 0, calls: 0 };
  #orientPackRef: AgentState['orientPackRef'];
  /** A repository tool succeeded in the current run. */
  #readRepository = false;
  /** The run whose `AGENTS.md` was already asked for. */
  #instructionsRun: string | undefined;
  #rounds: AgentRounds[] = [];
  #runResult: ArtifactRef | undefined;
  #overBudget = false;
  /** The Kernel interrupted this run: the reply that says so is the last thing it publishes. */
  #interrupted = false;
  #advancing = false;
  #advanceAgain = false;
  #runFailure: string | undefined;

  public constructor(deps: SessionRunnerDeps) {
    this.#deps = deps;
  }

  get records(): readonly SessionLogRecord[] {
    return this.#records;
  }

  async #append(records: readonly NewLogRecord[]): Promise<void> {
    for (const record of records) this.#records.push(await this.#deps.store.append(record));
  }

  async handleSessionEvent(envelope: WorkflowSessionEvent): Promise<void> {
    const { sessionId, event } = envelope;
    const reply = (result: Parameters<WorkflowGatewayPort['reportSessionCommand']>[0]['result']) =>
      this.#deps.gateway.reportSessionCommand(
        { requestId: newId('req'), sessionId, commandId: event.commandId, result },
        contextOf(sessionId),
      );
    const fail = (failure: SessionCommandFailure) =>
      reply({ command: event.command, outcome: 'FAILED', failure });
    try {
      if (event.command === 'CLOSE') {
        await this.#deps.store.close();
        this.#reset();
        await reply({ command: 'CLOSE', outcome: 'DONE' });
      } else if (event.command === 'CREATE') {
        const started = await this.#deps.store.create({
          sessionId,
          repositoryRoot: event.repositoryRoot,
          definitionsDigest: this.#deps.definitionsDigest,
          definitionVersions: this.#deps.definitionVersions,
          ...(this.#deps.sandbox === undefined ? {} : { sandbox: this.#deps.sandbox }),
        });
        this.#adopt(sessionId, event.repositoryRoot, [started]);
        await reply({ command: 'CREATE', outcome: 'READY' });
      } else if (event.command === 'FORK') {
        const forked = await this.#deps.store.fork({
          sessionId,
          fromSessionId: event.fromSessionId,
          repositoryRoot: event.repositoryRoot,
        });
        this.#adopt(sessionId, event.repositoryRoot, forked.records);
        await reply({
          command: 'FORK',
          outcome: 'READY',
          inheritedArtifacts: [...forked.inheritedArtifacts],
          fromTurnCount: forked.fromTurnCount,
        });
      } else {
        const opened = await this.#deps.store.open(sessionId, this.#deps.definitionsDigest);
        this.#adopt(sessionId, event.repositoryRoot, opened.records);
        const lastTurn = [...opened.records].reverse().find((r) => r.type === 'TURN_STARTED');
        await reply({
          command: 'OPEN',
          outcome: 'READY',
          ...(lastTurn?.type === 'TURN_STARTED' && lastTurn.turnId !== undefined
            ? { lastTurnId: lastTurn.turnId }
            : {}),
        });
      }
    } catch (error) {
      if (!(error instanceof SessionStoreFailure)) throw error;
      await fail({ code: error.code });
    }
  }

  #adopt(sessionId: string, repositoryRoot: string, records: readonly SessionLogRecord[]): void {
    this.#sessionId = sessionId;
    this.#repositoryRoot = repositoryRoot;
    this.#records = [...records];
  }

  #reset(): void {
    this.#sessionId = undefined;
    this.#records = [];
    this.#turnId = undefined;
    this.#agents.clear();
    this.#clearRun();
  }

  #clearRun(): void {
    this.#orientPackRef = undefined;
    this.#readRepository = false;
    this.#rounds = [];
    this.#runResult = undefined;
    this.#overBudget = false;
    this.#interrupted = false;
    this.#runFailure = undefined;
  }

  async handleSystemEvent(envelope: WorkflowSystemEvent): Promise<void> {
    const { event } = envelope;
    if (event.type === 'SessionListQuery') {
      await this.#deps.gateway.reportSessionList(
        {
          requestId: newId('req'),
          queryId: event.queryId,
          sessions: await this.#deps.store.list(event.repositoryRoot),
        },
        { correlationId: newId('cor'), tenantId: 'local', projectId: 'local' },
      );
      return;
    }
    let result: Parameters<WorkflowGatewayPort['reportSessionCommand']>[0]['result'] = {
      command: 'DELETE',
      outcome: 'DONE',
    };
    try {
      await this.#deps.store.remove(event.sessionId);
    } catch (error) {
      if (!(error instanceof SessionStoreFailure)) throw error;
      result = { command: 'DELETE', outcome: 'FAILED', failure: { code: error.code } };
    }
    await this.#deps.gateway.reportSessionCommand(
      { requestId: newId('req'), sessionId: event.sessionId, commandId: event.commandId, result },
      contextOf(event.sessionId),
    );
  }

  async handleRunEvent(envelope: WorkflowInboxEvent): Promise<void> {
    const { event, workflowRunId } = envelope;
    switch (event.type) {
      case 'RunStart':
        await this.#onRunStart(workflowRunId, event);
        break;
      case 'HumanAnswered':
        await this.#onHumanAnswered(workflowRunId, event);
        break;
      case 'UnitReport':
        await this.#onUnitReport(workflowRunId, event);
        break;
      case 'TurnClosed':
        await this.#append([
          {
            type: 'TURN_ENDED',
            workflowRunId,
            turnId: event.turnId,
            reason: event.reason,
            usage: event.usage,
          },
        ]);
        await this.#deps.store.recordTurnClosed();
        break;
      case 'WorkspaceReverted':
        await this.#append([
          {
            type: 'WORKSPACE_REVERTED',
            workflowRunId,
            revertedTurnIds: event.revertedTurnIds,
            forced: event.forced,
            externalFiles: event.externalFiles,
            ...(event.backupSnapshot === undefined ? {} : { backupSnapshot: event.backupSnapshot }),
          },
        ]);
        break;
      case 'WorkspaceDiverged': {
        // Measured against the last Turn, so reopening without one finds the same files again.
        const said = [...this.#records]
          .reverse()
          .find((record) => record.type === 'WORKSPACE_DIVERGED' || record.type === 'TURN_STARTED');
        if (
          said?.type !== 'WORKSPACE_DIVERGED' ||
          canonicalJson(said.files) !== canonicalJson(event.files)
        )
          await this.#append([{ type: 'WORKSPACE_DIVERGED', workflowRunId, files: event.files }]);
        break;
      }
      case 'RunInterrupted':
        await this.#append([{ type: 'RUN_INTERRUPTED', workflowRunId, reason: event.reason }]);
        // Calls the cancelled work left without a result are answered before anything else.
        await this.#append([...settleOpenCalls(this.#records, workflowRunId)]);
        await this.#onInterrupted(workflowRunId, event.reason);
        break;
      case 'RunClosed':
        await this.#append([
          { type: 'WORKFLOW_RUN_ENDED', workflowRunId, closeReason: event.closeReason },
        ]);
        this.#agents.clear();
        this.#clearRun();
        break;
    }
  }

  #sessionIdOrThrow(): string {
    if (this.#sessionId === undefined) throw new Error('no Session is open');
    return this.#sessionId;
  }

  async #extend(
    workflowRunId: string,
    revision: number,
    source: 'TEMPLATE' | 'CHAT_GROWTH' | 'SPAWN',
    content: GraphRevision,
  ): Promise<void> {
    await this.#append([
      {
        type: 'GRAPH_EXTENDED',
        workflowRunId,
        revision,
        source,
        nodes: [...content.nodes],
        edges: [...content.edges],
      },
    ]);
  }

  #initialRevision(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEvent, { type: 'RunStart' }>,
  ): GraphRevision {
    if (event.mode === 'CHAT') return initialChatRevision(workflowRunId, this.#mainRef());
    const template = this.#deps.templates.get(event.templateRef.id);
    if (template === undefined) throw new Error(`unknown template ${event.templateRef.id}`);
    const compiled = compileTemplate(workflowRunId, template);
    if (compiled.errors.length > 0) throw new Error('a built-in template does not compile');
    return compiled.revision;
  }

  async #onRunStart(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEvent, { type: 'RunStart' }>,
  ): Promise<void> {
    this.#mode = event.mode;
    await this.#append([
      {
        type: 'WORKFLOW_RUN_STARTED',
        workflowRunId,
        mode: event.mode,
        ...(event.mode === 'ORCHESTRATION' ? { templateRef: event.templateRef } : {}),
        preset: event.preset,
        initialInput: event.initialInput,
      },
    ]);
    await this.#extend(workflowRunId, 1, 'TEMPLATE', this.#initialRevision(workflowRunId, event));
    if (!event.initialInput) await this.#advance(workflowRunId);
  }

  #mainRef(): DefinitionRef {
    const { id, version } = this.#binding(MAIN).ref;
    return { id, version };
  }

  #binding(agentId: string): AgentBinding {
    const binding = this.#deps.agents.get(agentId);
    if (binding === undefined) throw new Error(`unknown Agent ${agentId}`);
    return binding;
  }

  async #onHumanAnswered(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEvent, { type: 'HumanAnswered' }>,
  ): Promise<void> {
    const { graph, view } = projectGraph(this.#records, workflowRunId);
    const node =
      event.origin === 'initial'
        ? graph.nodes.find((candidate) => candidate.kind === 'HUMAN')
        : graph.nodes.find(
            (candidate) => asHumanRequestId(candidate.nodeId) === event.humanRequestId,
          );
    if (node === undefined) throw new Error('HumanAnswered names no HUMAN node');
    if (view.get(node.nodeId)?.status === 'SUCCEEDED') return;
    if (this.#turnId !== event.turnId) this.#spawned = { tasks: 0, calls: 0 };
    this.#turnId = event.turnId;
    await this.#append([
      {
        type: 'HUMAN_ANSWERED',
        workflowRunId,
        turnId: event.turnId,
        nodeId: node.nodeId,
        kind: 'prompt',
        origin: event.origin,
        inputId: event.inputId,
        contentRef: event.contentRef,
        ...(event.origin === 'requested' ? { humanRequestId: event.humanRequestId } : {}),
      },
      { type: 'TURN_STARTED', workflowRunId, turnId: event.turnId, promptNodeId: node.nodeId },
      {
        type: 'NODE_ENDED',
        workflowRunId,
        turnId: event.turnId,
        nodeId: node.nodeId,
        status: 'SUCCEEDED',
      },
    ]);
    if (event.origin === 'initial') await this.#deps.store.setTitle(event.contentRef);
    await this.#advance(workflowRunId);
  }

  /**
   * Starts what is ready. A node that ends while this runs asks for another pass instead of
   * starting a second one inside the first, which would start the same nodes twice.
   */
  async #advance(workflowRunId: string): Promise<void> {
    if (this.#advancing) {
      this.#advanceAgain = true;
      return;
    }
    this.#advancing = true;
    try {
      do {
        this.#advanceAgain = false;
        await this.#advanceOnce(workflowRunId);
      } while (this.#advanceAgain);
    } finally {
      this.#advancing = false;
    }
  }

  async #advanceOnce(workflowRunId: string): Promise<void> {
    if (this.#mode === 'CHAT') {
      const projected = projectGraph(this.#records, workflowRunId);
      const growth = chatGrowthPoint(projected);
      if (growth !== undefined) {
        const revision = projected.lastRevision + 1;
        await this.#extend(
          workflowRunId,
          revision,
          'CHAT_GROWTH',
          chatGrowthRevision(workflowRunId, revision, growth, this.#mainRef()),
        );
      }
    }
    const projected = projectGraph(this.#records, workflowRunId);
    const { skipped, ready } = advanceGraph(projected.graph, projected.view);
    await this.#append(
      skipped.map(({ node, reason }) => ({
        type: 'NODE_ENDED',
        workflowRunId,
        nodeId: node.nodeId,
        status: 'SKIPPED',
        skipReason: reason,
      })),
    );
    for (const node of ready) {
      const record = projected.nodes.get(node.nodeId);
      if (record === undefined) continue;
      await this.#append([
        {
          type: 'NODE_STARTED',
          workflowRunId,
          ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
          nodeId: node.nodeId,
          path: record.path,
        },
      ]);
      if (node.kind === 'HUMAN') {
        await this.#requestHuman(workflowRunId, node.nodeId);
      } else {
        await this.#startAgent(workflowRunId, record);
      }
    }
    await this.#joinFinished(workflowRunId);
    if (this.#advanceAgain) return;
    if (this.#mode === 'ORCHESTRATION' && ready.length === 0 && this.#agents.size === 0)
      await this.#closeFinishedRun(workflowRunId);
  }

  /** A template run ends when its graph has nothing left to start. */
  async #closeFinishedRun(workflowRunId: string): Promise<void> {
    if (this.#runFailure !== undefined) await this.#closeFailed(workflowRunId, this.#runFailure);
    else
      await this.#close(workflowRunId, this.#overBudget ? 'BUDGET' : 'COMPLETED', this.#runResult);
  }

  async #requestHuman(workflowRunId: string, nodeId: string): Promise<void> {
    const humanRequestId = asHumanRequestId(nodeId);
    await this.#append([
      { type: 'HUMAN_REQUESTED', workflowRunId, humanRequestId, nodeId, kind: 'prompt' },
    ]);
    const sessionId = this.#sessionIdOrThrow();
    const response = await this.#deps.gateway.requestHuman(
      { requestId: newId('req'), sessionId, workflowRunId, humanRequestId, nodeId, kind: 'prompt' },
      contextOf(sessionId, workflowRunId),
    );
    if (response.outcome === 'REJECTED' && response.reasonCode !== 'RUN_BLOCKED')
      throw new Error(`requestHuman refused: ${response.reasonCode}`);
  }

  #objectiveRef(workflowRunId: string): HumanContentRef {
    const prompt = [...this.#records]
      .reverse()
      .find((record) => record.type === 'HUMAN_ANSWERED' && record.workflowRunId === workflowRunId);
    if (prompt?.type !== 'HUMAN_ANSWERED') throw new Error('an Agent needs a prompt');
    return prompt.contentRef;
  }

  #context(workflowRunId: string, scope: ProjectionScope): AgentContext {
    return {
      objectiveRef: this.#objectiveRef(workflowRunId),
      // What a transition has not appended yet still counts: it may be the write this one follows.
      toolInput: (kind, args, notYetInLog = []) =>
        toolInputOf(kind, args, [...this.#records, ...(notYetInLog as SessionLogRecord[])], scope),
      assembleInput: (status, final, withdrawnTools) => {
        return {
          final,
          ...(withdrawnTools.length === 0 ? {} : { withdrawnTools: [...withdrawnTools] }),
          ...(this.#orientPackRef === undefined ? {} : { orientPackRef: this.#orientPackRef }),
          history: [...projectHistory(this.#records, scope)],
          status,
        };
      },
    };
  }

  /** The handoff a node takes as input: the latest one of this run. */
  #handoffInput(workflowRunId: string): Extract<ProjectionScope, { kind: 'NODE' }>['handoff'] {
    const ended = [...this.#records]
      .reverse()
      .find(
        (record) =>
          record.type === 'NODE_ENDED' &&
          record.workflowRunId === workflowRunId &&
          record.result?.['action'] === 'HANDOFF',
      );
    if (ended?.type !== 'NODE_ENDED' || ended.resultRef === undefined) return undefined;
    return { outputRef: ended.resultRef, toolCallId: String(ended.result?.['toolCallId']) };
  }

  async #startAgent(workflowRunId: string, node: GraphNodeRecord): Promise<void> {
    const sessionId = this.#sessionIdOrThrow();
    const turnId = this.#turnId;
    if (turnId === undefined) throw new Error('an AgentRun needs an open Turn');
    if (node.agentRef === undefined) throw new Error('an AGENT node names no Agent');
    const nodeId = node.nodeId;
    const agentId = node.agentRef.id;
    const { spawn } = node;
    const agentRunId = this.#deps.newAgentRunId?.() ?? newId('agr');
    const binding = this.#binding(agentId);
    const effort = spawn?.effort ?? binding.effort;
    await this.#append([
      {
        type: 'AGENT_RUN_REGISTERED',
        workflowRunId,
        turnId,
        agentRunId,
        nodeId,
        agentRef: binding.ref,
        effort,
        ...(spawn === undefined ? {} : { parentAgentRunId: spawn.parentAgentRunId }),
      },
      {
        type: 'REQUEST_CONTEXT',
        workflowRunId,
        turnId,
        agentRunId,
        modelRef: binding.modelRef,
        thinking: effort,
        toolsDigest: binding.toolsDigest,
        runtimeContext: { workingDirectory: this.#repositoryRoot, ...this.#deps.runtime() },
      },
    ]);
    const registered = await this.#deps.gateway.registerAgentRun(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        agentRunId,
        nodeId,
        agentRef: binding.ref,
        effort,
        workspaceViewId: 'main',
        display: {
          label:
            spawn === undefined
              ? binding.definitions.label
              : `${binding.definitions.label} ${node.name}`,
        },
        requestedCapabilities: [...binding.requestedCapabilities],
        writeRoots: spawn === undefined ? [...binding.writeRoots] : [...spawn.writeScope],
        ...(spawn === undefined
          ? {}
          : {
              parentAgentRunId: spawn.parentAgentRunId,
              delegationId: spawn.delegationId,
              taskName: node.name,
            }),
      },
      contextOf(sessionId, workflowRunId),
    );
    if (registered.outcome === 'REJECTED') {
      if (spawn !== undefined) {
        // The caller is told why this task did not start; tasks that wait for it are skipped.
        await this.#endNode(
          workflowRunId,
          turnId,
          nodeId,
          'FAILED',
          resultOf({
            status: 'FAILED',
            notes: [`could not be started: ${registered.reasonCode}`],
          }),
        );
        return this.#advance(workflowRunId);
      }
      await this.#endNode(workflowRunId, turnId, nodeId, 'FAILED');
      // This process is short of memory (Core 5c): no model is asked. The run closes as
      // interrupted, the user is told so, and the next message opens a new run instead of
      // waiting on one that has nothing left to do.
      if (registered.reasonCode === 'MEMORY_PRESSURE')
        await this.#close(workflowRunId, 'INTERRUPTED');
      return;
    }
    const handoff = node.inputFrom === 'HANDOFF' ? this.#handoffInput(workflowRunId) : undefined;
    const task = spawn === undefined ? undefined : this.#taskScope(workflowRunId, node, spawn);
    const scope: ProjectionScope =
      this.#mode === 'CHAT' && spawn === undefined
        ? { kind: 'MAIN' }
        : {
            kind: 'NODE',
            workflowRunId,
            agentRunId,
            ...(handoff === undefined ? {} : { handoff }),
            ...(task === undefined ? {} : { task }),
          };
    const transition = startAgent(
      {
        workflowRunId,
        sessionId,
        turnId,
        agentRunId,
        definitions: binding.definitions,
        ...(this.#orientPackRef === undefined ? {} : { orientPackRef: this.#orientPackRef }),
      },
      this.#context(workflowRunId, scope),
    );
    this.#agents.set(agentRunId, {
      state: transition.state,
      nodeId,
      scope,
      agentId,
      changed: [],
      unchecked: false,
      completionAsked: false,
      ...(spawn === undefined ? {} : { task: { name: node.name, criteria: spawn.acceptance } }),
    });
    await this.#apply(workflowRunId, transition);
  }

  /** What a SubAgent is given: its task, and the results of the tasks it waits for. */
  #taskScope(
    workflowRunId: string,
    node: GraphNodeRecord,
    spawn: NonNullable<GraphNodeRecord['spawn']>,
  ): TaskScope {
    const projected = projectGraph(this.#records, workflowRunId);
    const dependencies = projected.graph.edges
      .filter((edge) => edge.to === node.nodeId)
      .flatMap((edge) => {
        const before = projected.nodes.get(edge.from);
        if (before === undefined) return [];
        const outcome: TaskOutcome = outcomeOf(this.#records, workflowRunId, before.nodeId) ?? {
          status: 'FAILED',
          notes: [],
        };
        return [
          {
            seq: 0,
            category: 'PINNED' as const,
            kind: 'SUBAGENT_RESULT' as const,
            name: before.name,
            agent: before.agentRef?.id ?? 'unknown',
            status: outcome.status,
            notes: [...outcome.notes],
            ...(outcome.outputRef === undefined ? {} : { outputRef: outcome.outputRef }),
            ...(outcome.toolCallId === undefined ? {} : { toolCallId: outcome.toolCallId }),
          },
        ];
      });
    return {
      name: node.name,
      agent: node.agentRef?.id ?? 'unknown',
      goal: node.goal ?? '',
      acceptance: spawn.acceptance,
      writeScope: spawn.writeScope,
      inputs: spawn.inputs,
      dependencies,
    };
  }

  async #apply(workflowRunId: string, transition: AgentTransition): Promise<void> {
    const { agentRunId } = transition.state;
    await this.#append(transition.records);
    const current = this.#agents.get(agentRunId);
    if (current !== undefined)
      this.#agents.set(agentRunId, { ...current, state: transition.state });
    if (transition.activity !== undefined) {
      const sessionId = this.#sessionIdOrThrow();
      await this.#deps.gateway.updateActivity(
        {
          requestId: newId('req'),
          sessionId,
          workflowRunId,
          agentRunId,
          todos: transition.activity,
        },
        contextOf(sessionId, workflowRunId),
      );
    }
    if (transition.state.orientPackRef !== undefined)
      this.#orientPackRef = transition.state.orientPackRef;
    const sessionId = this.#sessionIdOrThrow();
    for (const planned of transition.submissions) {
      const request = await this.#withCurrentHistory(workflowRunId, planned);
      const response = await this.#deps.gateway.submitUnit(
        request,
        contextOf(sessionId, workflowRunId),
      );
      if (response.outcome === 'REJECTED' && response.reasonCode !== 'RUN_BLOCKED')
        throw new Error(`submitUnit refused: ${response.reasonCode}`);
    }
    if (transition.ending !== undefined)
      await this.#onEnding(workflowRunId, agentRunId, transition.ending);
  }

  /**
   * An assembly is planned before the records of its transition are appended, so its history is
   * taken again from the log: every tool result must be there, whether the tool succeeded or not.
   * `AGENTS.md` is read when the run first needs the repository, like any document, and joins
   * the context after the tool results of that round, because a result must directly follow its
   * call.
   */
  async #withCurrentHistory(
    workflowRunId: string,
    request: SubmitUnitRequest,
  ): Promise<SubmitUnitRequest> {
    const active = this.#agents.get(request.agentRunId);
    if (active === undefined || !('history' in request.input)) return request;
    if (this.#readRepository && this.#instructionsRun !== workflowRunId) {
      this.#instructionsRun = workflowRunId;
      const sessionId = this.#sessionIdOrThrow();
      const file = await this.#deps.gateway.readProjectFile(
        { requestId: newId('req'), sessionId, workflowRunId, path: 'AGENTS.md' },
        contextOf(sessionId, workflowRunId),
      );
      if (file.outcome === 'ACCEPTED' && file.exists && 'trusted' in file)
        await this.#append([
          {
            type: 'PROJECT_FILE_LOADED',
            workflowRunId,
            path: 'AGENTS.md',
            ref: file.ref,
            sha256: file.sha256,
            trusted: file.trusted,
          },
        ]);
    }
    await this.#loadNestedInstructions(workflowRunId, active.state.agentRunId, active.scope);
    return {
      ...request,
      input: { ...request.input, history: [...projectHistory(this.#records, active.scope)] },
    };
  }

  /** Done before the assembly, so the model sees them right after the read (M2Design 9.5). */
  async #loadNestedInstructions(
    workflowRunId: string,
    agentRunId: string,
    scope: ProjectionScope,
  ): Promise<void> {
    const sessionId = this.#sessionIdOrThrow();
    for (const { path, skip } of instructionsToLoad(
      this.#records,
      scope,
      workflowRunId,
      agentRunId,
      this.#deps.config.maxNestedInstructions,
    )) {
      if (skip) {
        await this.#append([
          { type: 'PROJECT_FILE_LOADED', workflowRunId, path, agentRunId, skipped: 'LIMIT' },
        ]);
        continue;
      }
      const file = await this.#deps.gateway.readProjectFile(
        { requestId: newId('req'), sessionId, workflowRunId, path },
        contextOf(sessionId, workflowRunId),
      );
      if (file.outcome === 'ACCEPTED' && file.exists && 'trusted' in file)
        await this.#append([
          {
            type: 'PROJECT_FILE_LOADED',
            workflowRunId,
            path,
            ref: file.ref,
            sha256: file.sha256,
            trusted: file.trusted,
            agentRunId,
          },
        ]);
    }
  }

  async #onUnitReport(
    workflowRunId: string,
    report: Extract<KernelToWorkflowEvent, { type: 'UnitReport' }>,
  ): Promise<void> {
    const found = this.#agents.get(report.agentRunId);
    if (found === undefined) return;
    if (report.status === 'OK' && READS_REPOSITORY.has(report.executionKind))
      this.#readRepository = true;
    let active = found;
    if (report.status === 'OK') {
      const ranClean =
        report.executionKind === 'COMMAND' &&
        (report.output as { readonly exitCode?: number }).exitCode === 0;
      active = {
        ...found,
        changed: [...new Set([...found.changed, ...(report.changedFiles ?? [])])],
        unchecked: ranClean
          ? false
          : found.unchecked || (WRITE_KINDS as readonly string[]).includes(report.executionKind),
      };
      this.#agents.set(report.agentRunId, active);
    }
    const transition = receiveAgentReport(
      active.state,
      report,
      this.#context(workflowRunId, active.scope),
      this.#deps.config,
    );
    await this.#apply(workflowRunId, transition);
  }

  async #endNode(
    workflowRunId: string,
    turnId: string,
    nodeId: string,
    status: 'SUCCEEDED' | 'FAILED',
    result?: Record<string, unknown>,
    resultRef?: ArtifactRef,
  ): Promise<void> {
    await this.#append([
      {
        type: 'NODE_ENDED',
        workflowRunId,
        turnId,
        nodeId,
        status,
        ...(result === undefined ? {} : { result }),
        ...(resultRef === undefined ? {} : { resultRef }),
      },
    ]);
  }

  async #endAgentRun(
    workflowRunId: string,
    active: ActiveAgent,
    outcome: AgentEnding['kind'],
  ): Promise<void> {
    const { agentRunId, turnId, wrapUpReason, round, definitions } = active.state;
    this.#agents.delete(agentRunId);
    if (active.task === undefined)
      this.#rounds.push({
        agentId: active.agentId,
        agentRunId,
        roundsUsed: round,
        maxRounds: definitions.limits.maxRounds,
      });
    await this.#append([
      {
        type: 'AGENT_RUN_ENDED',
        workflowRunId,
        turnId,
        agentRunId,
        outcome,
        ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
      },
    ]);
    const sessionId = this.#sessionIdOrThrow();
    await this.#deps.gateway.endAgentRun(
      { requestId: newId('req'), sessionId, workflowRunId, agentRunId },
      contextOf(sessionId, workflowRunId),
    );
  }

  async #closeWith(
    workflowRunId: string,
    active: ActiveAgent,
    input: UnitInput,
    source: ControlSource | undefined,
    nodeEnding: NodeEnding,
  ): Promise<void> {
    this.#agents.set(active.state.agentRunId, { ...active, nodeEnding });
    await this.#apply(workflowRunId, closeAgent(active.state, input, source));
  }

  #reportInput(workflowRunId: string, active: ActiveAgent) {
    const { round, agentRunId, definitions } = active.state;
    return {
      workflowRunId,
      facts: analysisFacts(this.#records, workflowRunId),
      agentRounds: [
        ...this.#rounds,
        {
          agentId: active.agentId,
          agentRunId,
          roundsUsed: round,
          maxRounds: definitions.limits.maxRounds,
        },
      ],
      createdAt: (this.#deps.now?.() ?? new Date()).toISOString(),
    };
  }

  async #close(
    workflowRunId: string,
    outcome: 'COMPLETED' | 'BUDGET' | 'INTERRUPTED',
    resultRef?: ArtifactRef,
  ): Promise<void> {
    const sessionId = this.#sessionIdOrThrow();
    await this.#deps.gateway.closeRun(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        outcome,
        ...(resultRef === undefined ? {} : { resultRef }),
      },
      contextOf(sessionId, workflowRunId),
    );
  }

  async #closeFailed(workflowRunId: string, reason: string): Promise<void> {
    const code: ReasonCode =
      reason in REASON_CODE_CATEGORY ? (reason as ReasonCode) : 'WORKFLOW_INTERNAL';
    const sessionId = this.#sessionIdOrThrow();
    await this.#deps.gateway.closeRun(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        outcome: 'FAILED',
        failure: { code, category: REASON_CODE_CATEGORY[code], source: 'WORKFLOW' },
      },
      contextOf(sessionId, workflowRunId),
    );
  }

  /** The one table of what follows each declared end action. */
  async #runEndAction(
    action: EndAction,
    workflowRunId: string,
    active: ActiveAgent,
    ending: Extract<AgentEnding, { kind: 'ENDED' }>,
  ): Promise<void> {
    const { label } = active.state.definitions;
    const { wrapUpReason } = active.state;
    switch (action) {
      case 'PUBLISH_REPLY':
        return this.#closeWith(
          workflowRunId,
          active,
          {
            kind: 'REPLY',
            agentLabel: label,
            source: {
              modelOutputRef: ending.source.modelOutputRef,
              toolCallId: ending.source.toolCallId,
            },
            ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
          },
          ending.source,
          { status: 'SUCCEEDED', runOutput: false },
        );
      case 'PUBLISH_REPORT':
        return this.#closeWith(
          workflowRunId,
          active,
          {
            goalRef: this.#objectiveRef(workflowRunId),
            report: normalReportBody({
              ...this.#reportInput(workflowRunId, active),
              draft: ending.arguments as AnalysisReportDraft,
              ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
            }),
          },
          ending.source,
          { status: 'SUCCEEDED', result: { action: 'FINISH' }, runOutput: true },
        );
      case 'HANDOFF':
        await this.#endAgentRun(workflowRunId, active, 'ENDED');
        await this.#endNode(
          workflowRunId,
          active.state.turnId,
          active.nodeId,
          'SUCCEEDED',
          { action: 'HANDOFF', toolCallId: ending.source.toolCallId },
          ending.source.modelOutputRef,
        );
        return this.#advance(workflowRunId);
      case 'FINISH_SUBAGENT':
        return this.#finishSubagent(workflowRunId, active, ending);
    }
  }

  /** The caller is told its finishing call is not accepted yet; it goes on with a new Round. */
  async #sendBack(
    workflowRunId: string,
    active: ActiveAgent,
    toolCallId: string,
    code: string,
    message: string,
  ): Promise<void> {
    const transition = resumeAfterRefusal(
      active.state,
      [answerRecord(active.state, code, toolCallId, message)],
      this.#context(workflowRunId, active.scope),
      this.#deps.config,
    );
    await this.#apply(workflowRunId, transition);
  }

  /** The result of a SubAgent: checked in form, then handed to whoever waits for it (M2Design 3.7). */
  async #finishSubagent(
    workflowRunId: string,
    active: ActiveAgent,
    ending: Extract<AgentEnding, { kind: 'ENDED' }>,
  ): Promise<void> {
    const { task } = active;
    if (task === undefined) throw new Error('only a SubAgent finishes with a result');
    const args = ending.arguments as Parameters<typeof finishedOutcome>[0];
    const { toolCallId } = ending.source;
    const missing = unansweredCriteria(args, task.criteria.length);
    if (missing.length > 0)
      return this.#sendBack(
        workflowRunId,
        active,
        toolCallId,
        'RESULT_INCOMPLETE',
        `Not accepted: answer every acceptance criterion by its index. Missing: ${missing.join(', ')}.`,
      );
    const canRun = active.state.definitions.tools.some((tool) => tool.executionKind === 'COMMAND');
    if (canRun && active.unchecked && !active.completionAsked) {
      this.#agents.set(active.state.agentRunId, { ...active, completionAsked: true });
      return this.#sendBack(
        workflowRunId,
        { ...active, completionAsked: true },
        toolCallId,
        'NOT_VERIFIED',
        'Not accepted yet: you changed files but have not run a command that checks them since. Run the tests, the build or the linter, then finish again.',
      );
    }
    const outcome = finishedOutcome(args, task.criteria, active.changed);
    await this.#endAgentRun(workflowRunId, active, 'ENDED');
    await this.#endNode(
      workflowRunId,
      active.state.turnId,
      active.nodeId,
      outcome.status === 'BLOCKED' ? 'FAILED' : 'SUCCEEDED',
      resultOf({ ...outcome, toolCallId }),
      ending.source.modelOutputRef,
    );
    return this.#advance(workflowRunId);
  }

  /** A SubAgent that stops without a result: whatever it has left is the caller's to read. */
  async #endTask(
    workflowRunId: string,
    active: ActiveAgent,
    kind: AgentEnding['kind'],
    outcome: TaskOutcome,
  ): Promise<void> {
    await this.#endAgentRun(workflowRunId, active, kind);
    await this.#endNode(
      workflowRunId,
      active.state.turnId,
      active.nodeId,
      outcome.status === 'PARTIAL' ? 'SUCCEEDED' : 'FAILED',
      resultOf(outcome),
    );
  }

  /**
   * The Kernel interrupts the run (Kernel/Core 5c): no model is called again. SubAgents stop where
   * they are; the AgentRun that spawned them ends with the one reply that says why, which needs no
   * model, and the run closes as INTERRUPTED. Whatever was in flight is no longer waited for.
   */
  async #onInterrupted(workflowRunId: string, reason: string): Promise<void> {
    this.#interrupted = true;
    const all = [...this.#agents.values()];
    if (all.length === 0) return this.#close(workflowRunId, 'INTERRUPTED');
    for (const active of all.filter((each) => each.task !== undefined))
      await this.#endTask(workflowRunId, active, 'FAILED', {
        status: 'FAILED',
        notes: ['stopped: the run was interrupted'],
      });
    for (const active of all.filter((each) => each.task === undefined)) {
      const rest = withoutWaiting(active);
      this.#agents.set(active.state.agentRunId, rest);
      await this.#onDegraded(workflowRunId, rest, reason);
    }
  }

  async #onDegraded(workflowRunId: string, active: ActiveAgent, reason: string): Promise<void> {
    if (OVER_BUDGET.includes(reason)) this.#overBudget = true;
    const { onDegraded } = active.state.definitions;
    if (onDegraded === 'RETURN_PARTIAL') {
      await this.#endTask(workflowRunId, active, 'DEGRADED', {
        status: 'PARTIAL',
        notes: [`stopped early: ${reason}`],
      });
      return this.#advance(workflowRunId);
    }
    if (onDegraded === 'PUBLISH_NOTICE') {
      const input = { kind: 'DEGRADED_REPLY', agentLabel: active.state.definitions.label, reason };
      await this.#closeWith(workflowRunId, active, input as UnitInput, undefined, {
        status: 'FAILED',
        runOutput: false,
      });
      return;
    }
    const report = degradedReportBody({ ...this.#reportInput(workflowRunId, active), reason });
    await this.#closeWith(
      workflowRunId,
      active,
      { goalRef: this.#objectiveRef(workflowRunId), report },
      undefined,
      { status: 'FAILED', result: { action: 'FINISH' }, runOutput: true },
    );
  }

  async #onEnding(workflowRunId: string, agentRunId: string, ending: AgentEnding): Promise<void> {
    const active = this.#agents.get(agentRunId);
    if (active === undefined) return;
    const { turnId } = active.state;
    switch (ending.kind) {
      case 'ENDED':
        return this.#runEndAction(ending.tool.action, workflowRunId, active, ending);
      case 'SPAWN':
        return this.#onSpawn(workflowRunId, active, ending);
      case 'DEGRADED':
        return this.#onDegraded(workflowRunId, active, ending.reason);
      case 'CLOSED': {
        const plan = active.nodeEnding ?? { status: 'SUCCEEDED', runOutput: false };
        await this.#endAgentRun(workflowRunId, active, ending.kind);
        await this.#endNode(
          workflowRunId,
          turnId,
          active.nodeId,
          plan.status,
          plan.result,
          ending.outputRef,
        );
        if (plan.runOutput) this.#runResult = ending.outputRef;
        if (this.#interrupted)
          return this.#agents.size === 0 ? this.#close(workflowRunId, 'INTERRUPTED') : undefined;
        if (this.#mode === 'CHAT' && ending.budget.run !== 'NORMAL')
          return this.#close(workflowRunId, 'BUDGET');
        return this.#advance(workflowRunId);
      }
      case 'FAILED':
        if (active.task !== undefined) {
          await this.#endTask(workflowRunId, active, ending.kind, {
            status: 'FAILED',
            notes: [`failed: ${ending.code}`],
          });
          return this.#advance(workflowRunId);
        }
        if (this.#interrupted) {
          // The reply could not be published: the run still ends, and the log says why.
          await this.#endAgentRun(workflowRunId, active, ending.kind);
          await this.#endNode(workflowRunId, turnId, active.nodeId, 'FAILED');
          return this.#agents.size === 0 ? this.#close(workflowRunId, 'INTERRUPTED') : undefined;
        }
        // In a chat the run goes on with the next prompt, so the user must hear of it here.
        if (this.#mode === 'CHAT') return this.#onDegraded(workflowRunId, active, ending.code);
        await this.#endAgentRun(workflowRunId, active, ending.kind);
        await this.#endNode(workflowRunId, turnId, active.nodeId, 'FAILED');
        this.#runFailure = ending.code;
        return this.#advance(workflowRunId);
    }
  }

  #refOf(agentId: string): DefinitionRef {
    const { id, version } = this.#binding(agentId).ref;
    return { id, version };
  }

  /** The model reads this in place of a result: which rules failed, and what to do instead. */
  #refusalText(errors: readonly SpawnError[], withdrawn: boolean): string {
    const lines = errors.map(
      (error) =>
        `${error.code}${error.task === undefined ? '' : ` (${error.task})`}: ${error.message}`,
    );
    const tail = withdrawn
      ? 'run_subagents is no longer available to you: finish the work yourself.'
      : 'Nothing was started. Correct the call and send it again, or do the work yourself.';
    const text = [...lines, tail].join('\n');
    return text.length <= 1000 ? text : `${text.slice(0, 999)}…`;
  }

  /**
   * `run_subagents` (M2Design 3.6): the tasks are checked as a whole, the Kernel lends their
   * shares as a whole, and only then does the graph grow. The caller waits until they all ended.
   */
  async #onSpawn(
    workflowRunId: string,
    active: ActiveAgent,
    ending: Extract<AgentEnding, { kind: 'SPAWN' }>,
  ): Promise<void> {
    const sessionId = this.#sessionIdOrThrow();
    const { toolCallId } = ending.source;
    const refuse = async (text: string, withdraw = false): Promise<void> => {
      const transition = resumeAfterSpawn(
        active.state,
        {
          refused: true,
          withdraw,
          records: [answerRecord(active.state, 'INVALID_ACTION', toolCallId, text)],
        },
        this.#context(workflowRunId, active.scope),
        this.#deps.config,
      );
      await this.#apply(workflowRunId, transition);
    };
    const agents = new Map<
      string,
      { writes: boolean; allowedEfforts: readonly ThinkingEffort[] }
    >();
    for (const [id, binding] of this.#deps.agents)
      if (binding.definitions.endTools.some((tool) => tool.action === 'FINISH_SUBAGENT'))
        agents.set(id, {
          writes: binding.requestedCapabilities.includes('workspace.write'),
          allowedEfforts: binding.allowedEfforts,
        });
    const readable = readableArtifacts(this.#records, active.state.agentRunId);
    const checked = validateSpawn(ending.arguments as RunSubagentsArgs, {
      rules: this.#deps.config,
      agents,
      callerRoots: this.#binding(active.agentId).writeRoots,
      spawned: this.#spawned,
      readable: (artifactId) => readable.has(artifactId),
    });
    if (!checked.ok) {
      const withdraw = checked.errors.some((error) => error.code === 'SPAWN_LIMIT');
      return refuse(
        this.#refusalText(checked.errors, withdraw || active.state.invalidSpawns + 1 >= 2),
        withdraw,
      );
    }
    const { tasks } = checked.plan;
    const reserved = await this.#deps.gateway.reserveDelegation(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        parentAgentRunId: active.state.agentRunId,
        tasks: tasks.map((task) => ({
          name: task.name,
          agentRef: this.#binding(task.agent).ref,
          writeRoots: [...task.writeRoots],
          ...(task.budget?.tokens === undefined ? {} : { tokens: task.budget.tokens }),
        })),
      },
      contextOf(sessionId, workflowRunId),
    );
    if (reserved.outcome === 'REJECTED') {
      if (reserved.reasonCode === 'RUN_BLOCKED') return;
      if (reserved.reasonCode === 'BUDGET_INSUFFICIENT')
        return refuse(
          `BUDGET_INSUFFICIENT: at most ${String(reserved.delegable)} tokens can be lent to subtasks right now, in total. Start fewer or smaller tasks, or do the work yourself.`,
        );
      return refuse(
        `${reserved.reasonCode}: the system refused to start these tasks. Nothing was started.`,
      );
    }
    const shares = new Map(reserved.shares.map((share) => [share.name, share]));
    const projected = projectGraph(this.#records, workflowRunId);
    const revisionNumber = projected.lastRevision + 1;
    const revision = spawnRevision(
      workflowRunId,
      revisionNumber,
      tasks.map((task) => {
        const share = shares.get(task.name);
        return {
          name: task.name,
          agentRef: this.#refOf(task.agent),
          goal: task.goal,
          dependsOn: task.dependsOn ?? [],
          spawn: {
            parentAgentRunId: active.state.agentRunId,
            delegationId: reserved.delegationId,
            callToolCallId: toolCallId,
            writeScope: [...task.writeRoots],
            acceptance: [...(task.acceptance ?? [])],
            inputs: [...(task.inputs ?? [])],
            ...(task.effort === undefined ? {} : { effort: task.effort }),
            tokens: share?.tokens ?? 1,
            ...(share?.clamped === undefined ? {} : { clamped: share.clamped }),
          },
        };
      }),
    );
    await this.#extend(workflowRunId, revisionNumber, 'SPAWN', revision);
    this.#spawned = {
      tasks: this.#spawned.tasks + tasks.length,
      calls: this.#spawned.calls + 1,
    };
    this.#agents.set(active.state.agentRunId, {
      ...active,
      waiting: {
        toolCallId,
        delegationId: reserved.delegationId,
        tasks: tasks.map((task) => ({
          name: task.name,
          agent: task.agent,
          nodeId: revision.nodes.find((node) => node.name === task.name)?.nodeId ?? '',
        })),
      },
    });
    await this.#advance(workflowRunId);
  }

  /** A caller whose tasks have all ended is told how they went and goes on (M2Design 3.6). */
  async #joinFinished(workflowRunId: string): Promise<void> {
    if (this.#interrupted) return;
    const sessionId = this.#sessionIdOrThrow();
    for (const parent of [...this.#agents.values()]) {
      const { waiting } = parent;
      if (waiting === undefined) continue;
      const outcomes = waiting.tasks.map((task) => ({
        task,
        outcome: outcomeOf(this.#records, workflowRunId, task.nodeId),
      }));
      if (outcomes.some((each) => each.outcome === undefined)) continue;
      // The shares of tasks that never started go back to the caller.
      await this.#deps.gateway.releaseDelegation(
        { requestId: newId('req'), sessionId, workflowRunId, delegationId: waiting.delegationId },
        contextOf(sessionId, workflowRunId),
      );
      await this.#append([
        {
          type: 'SUBAGENTS_JOINED',
          workflowRunId,
          ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
          agentRunId: parent.state.agentRunId,
          toolCallId: waiting.toolCallId,
          delegationId: waiting.delegationId,
          results: outcomes.flatMap(({ task, outcome }) =>
            outcome === undefined
              ? []
              : [
                  {
                    name: task.name,
                    agent: task.agent,
                    status: outcome.status,
                    notes: [...outcome.notes],
                    ...(outcome.outputRef === undefined ? {} : { outputRef: outcome.outputRef }),
                    ...(outcome.toolCallId === undefined
                      ? {}
                      : { resultToolCallId: outcome.toolCallId }),
                  },
                ],
          ),
        },
      ]);
      const rest = withoutWaiting(parent);
      this.#agents.set(parent.state.agentRunId, rest);
      await this.#apply(
        workflowRunId,
        resumeAfterSpawn(
          rest.state,
          { refused: false, records: [] },
          this.#context(workflowRunId, rest.scope),
          this.#deps.config,
        ),
      );
    }
  }
}
