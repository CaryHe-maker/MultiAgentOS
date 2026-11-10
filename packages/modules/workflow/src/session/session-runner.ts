import { settleOpenCalls } from './settle-stale.js';
import { lastWorkspaceOf } from '../domain/workspace/workspace-binding.js';
import { checkedItems, nextReferenceId, partyOf } from '../domain/handover/handover.js';
import {
  REPOSITORY_KINDS,
  WRITE_KINDS,
  REASON_CODE_CATEGORY,
  newId,
  type AnalysisReportDraft,
  type AskUserArgs,
  type ArtifactRef,
  type BoundaryContext,
  canonicalJson,
  type DefinitionRef,
  type DelegationReserved,
  type GraphNodeRecord,
  type InterruptReason,
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
  resumeAfterPause,
  resumeAfterRefusal,
  answerDelegatedCall,
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
import { revokedCompactions } from '../domain/context/compaction-revocation.js';
import { projectHistory, type ProjectionScope } from '../domain/context/history-projection.js';
import { isTerminal, wakeableNodes, type Wake } from '../domain/graph/graph.js';
import { placementOf } from '../domain/spawn/placement.js';
import { readableArtifacts } from '../domain/spawn/readable-artifacts.js';
import { callOf, spawnedIn, spawnNodeOf, taskScopeOf } from '../domain/spawn/spawn-graph.js';
import {
  finishedOutcome,
  resultOf,
  unansweredCriteria,
  type TaskOutcome,
} from '../domain/spawn/task-results.js';
import {
  validateSpawn,
  type SpawnAgentFacts,
  type SpawnError,
  type SpawnPlan,
} from '../domain/spawn/validate-spawn.js';
import {
  advanceGraph,
  chatGrowthPoint,
  chatGrowthRevision,
  compileTemplate,
  initialChatRevision,
  projectGraph,
  askRevision,
  spawnRevision,
  steerRevision,
  type GraphRevision,
  type ProjectedGraph,
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

/**
 * Why the arguments of `ask_user` cannot be taken, in words the model can act on: what the
 * schema leaves open (a review needs something to look at, a choice needs options, names are
 * unique) and an artifact the asker cannot read (M2Design 3.4).
 */
function askProblem(args: AskUserArgs, readable: ReadonlySet<string>): string | undefined {
  const fields = args.fields ?? [];
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) return `Not asked: two fields are named ${field.name}.`;
    names.add(field.name);
    if ((field.type === 'select' || field.type === 'multiselect') && field.options === undefined)
      return `Not asked: field ${field.name} is a choice and needs options.`;
  }
  if (args.kind === 'review') {
    if (args.reviewArtifact === undefined)
      return 'Not asked: a review needs reviewArtifact, the artifact the user should look at.';
    if (!readable.has(args.reviewArtifact.artifactId))
      return 'Not asked: you can only hand the user an artifact that you have read yourself.';
  }
  return undefined;
}

/** The nodes of questions put to the user that are still waiting for an answer. */
function questionsOf(records: readonly SessionLogRecord[], workflowRunId: string): string[] {
  const asked = new Set<string>();
  for (const record of records) {
    if (record.type !== 'HUMAN_REQUESTED' || record.workflowRunId !== workflowRunId) continue;
    if (record.kind !== 'prompt') asked.add(record.nodeId);
  }
  return [...asked];
}

const asHumanRequestId = (nodeId: string): string => `hrq_${nodeId.slice('nod_'.length)}`;

/** How a node ends once its AgentRun closed. */
interface NodeEnding {
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly result?: Record<string, unknown>;
  /** The run's result when this node is its output. */
  readonly runOutput: boolean;
}

const OVER_BUDGET: readonly string[] = ['BUDGET_WRAP_UP', 'BUDGET_EXHAUSTED'];

interface ActiveAgent {
  readonly state: AgentState;
  readonly nodeId: string;
  readonly scope: ProjectionScope;
  readonly agentId: string;
  readonly nodeEnding?: NodeEnding;
  /** The task this AgentRun was started for, when it is a SubAgent. */
  readonly task?: { readonly name: string; readonly criteria: readonly string[] };
  /** What the Kernel reported this AgentRun changed (M2Design 3.7). */
  readonly changed: readonly string[];
  /** Files changed after the last successful command: a worker should check its work. */
  readonly unchecked: boolean;
  readonly completionAsked: boolean;
}

export class SessionRunner {
  readonly #deps: SessionRunnerDeps;
  readonly #spawnable: ReadonlyMap<string, SpawnAgentFacts>;
  #sessionId: string | undefined;
  #repositoryRoot = '';
  #records: SessionLogRecord[] = [];
  #mode: 'CHAT' | 'ORCHESTRATION' = 'CHAT';
  #turnId: string | undefined;
  /** Every AgentRun that has not ended, by id: SubAgents run beside the AgentRun that spawned them. */
  readonly #agents = new Map<string, ActiveAgent>();
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
  /** Why the run is being interrupted, while it is. */
  #interruptReason: InterruptReason | undefined;
  #advancing = false;
  #advanceAgain = false;
  #runFailure: string | undefined;

  public constructor(deps: SessionRunnerDeps) {
    this.#deps = deps;
    // The Agents `run_subagents` may start are those that end by returning a result (M2Design 3.9).
    this.#spawnable = new Map(
      [...deps.agents]
        .filter(([, agent]) =>
          agent.definitions.endTools.some((tool) => tool.action === 'FINISH_SUBAGENT'),
        )
        .map(([id, agent]) => [
          id,
          {
            writes: agent.requestedCapabilities.includes('workspace.write'),
            allowedEfforts: agent.allowedEfforts,
          },
        ]),
    );
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
        this.#adopt(
          sessionId,
          event.repositoryRoot,
          await this.#bound(event.repositoryRoot, forked.records),
        );
        await reply({
          command: 'FORK',
          outcome: 'READY',
          inheritedArtifacts: [...forked.inheritedArtifacts],
          fromTurnCount: forked.fromTurnCount,
        });
      } else {
        const opened = await this.#deps.store.open(sessionId, this.#deps.definitionsDigest);
        const records = await this.#bound(event.repositoryRoot, opened.records);
        this.#adopt(sessionId, event.repositoryRoot, records);
        const lastTurn = [...opened.records].reverse().find((r) => r.type === 'TURN_STARTED');
        await reply({
          command: 'OPEN',
          outcome: 'READY',
          turnCount: opened.turnCount,
          ...(opened.titleRef === undefined ? {} : { titleRef: opened.titleRef }),
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

  /**
   * The Session is bound to the folder this process works in. When the log says another folder
   * was the last, that is recorded now, before anything uses the Session (M2Design 2.3): Kernel
   * has already confirmed it with the user and began the snapshots again. The same comparison
   * on every open makes this safe to repeat after a crash between the two.
   */
  async #bound(
    repositoryRoot: string,
    records: readonly SessionLogRecord[],
  ): Promise<readonly SessionLogRecord[]> {
    const previousRoot = lastWorkspaceOf(records);
    if (previousRoot === undefined || previousRoot === repositoryRoot) return records;
    return [...records, await this.#deps.store.bindWorkspace({ repositoryRoot, previousRoot })];
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
    this.#interruptReason = undefined;
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
          sessions: await this.#deps.store.list(),
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
      case 'RunPaused':
        await this.#append([
          {
            type: 'RUN_PAUSED',
            workflowRunId,
            ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
          },
        ]);
        break;
      case 'RunResumed':
        await this.#onResumed(workflowRunId, event);
        break;
      case 'HumanCancelled':
        // The question is gone: its node was ended when the interrupt came, or is ended now.
        await this.#endQuestion(workflowRunId, event.nodeId);
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
      case 'CompactionSourceQuery':
        await this.#onCompactionQuery(workflowRunId, event);
        break;
      case 'ToolResultsPruned':
        await this.#recordCompaction(workflowRunId, event.compactionId, 'PRUNE', [
          {
            type: 'TOOL_RESULTS_PRUNED',
            workflowRunId,
            compactionId: event.compactionId,
            target: event.target,
            items: event.items,
          },
        ]);
        break;
      case 'ContextCompacted':
        await this.#recordCompaction(workflowRunId, event.compactionId, 'SUMMARY', [
          {
            type: 'CONTEXT_COMPACTED',
            workflowRunId,
            compactionId: event.compactionId,
            target: event.target,
            fromSeq: event.fromSeq,
            toSeq: event.toSeq,
            keptSeqs: event.keptSeqs,
            summaryRef: event.summaryRef,
            summaryInput: event.summaryInput,
            usage: event.usage,
          },
        ]);
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
        // A summary of work that was undone stands for nothing any more (Module/Workflow 8.4).
        await this.#append(revokedCompactions(this.#records, workflowRunId, event.revertedTurnIds));
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

  /** Kernel asks for the material of a compaction: the projection of the target, as it is now. */
  async #onCompactionQuery(
    workflowRunId: string,
    event: Extract<WorkflowInboxEvent['event'], { type: 'CompactionSourceQuery' }>,
  ): Promise<void> {
    const sessionId = this.#sessionIdOrThrow();
    const scope: ProjectionScope | undefined =
      event.target.kind === 'MAIN'
        ? { kind: 'MAIN' }
        : this.#agents.get(event.target.agentRunId)?.scope;
    // An AgentRun that is gone has nothing to compact; Kernel then finds nothing to do.
    const entries =
      scope === undefined ? [] : projectHistory(this.#records, scope, { material: true });
    await this.#deps.gateway.reportCompactionSource(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        compactionId: event.compactionId,
        entries: [...entries],
      },
      contextOf(sessionId),
    );
  }

  /** What Kernel did to a context goes in the log first; only then does it take effect (9.6). */
  async #recordCompaction(
    workflowRunId: string,
    compactionId: string,
    stage: 'PRUNE' | 'SUMMARY',
    records: readonly NewLogRecord[],
  ): Promise<void> {
    const sessionId = this.#sessionIdOrThrow();
    const acknowledge = (outcome: 'RECORDED' | 'FAILED') =>
      this.#deps.gateway.ackCompaction(
        { requestId: newId('req'), sessionId, workflowRunId, compactionId, stage, outcome },
        contextOf(sessionId),
      );
    try {
      await this.#append(records);
    } catch (error) {
      await acknowledge('FAILED');
      throw error;
    }
    await acknowledge('RECORDED');
  }

  #sessionIdOrThrow(): string {
    if (this.#sessionId === undefined) throw new Error('no Session is open');
    return this.#sessionId;
  }

  async #extend(
    workflowRunId: string,
    revision: number,
    source: 'TEMPLATE' | 'CHAT_GROWTH' | 'SPAWN' | 'STEER' | 'ASK',
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

  /** The AgentRun that dispatched a node (a task or a question), from the `DELEGATE` edge to it. */
  #askerOf(graph: ProjectedGraph, nodeId: string): ActiveAgent | undefined {
    const call = callOf(graph, nodeId);
    return [...this.#agents.values()].find((each) => each.nodeId === call?.callerNodeId);
  }

  /**
   * The user answered a question of `ask_user`: the node it stands for is done, and the graph then
   * wakes the AgentRun that asked, which reads the answer as the result of its call (M2Design 3.3).
   */
  async #onAnswer(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEvent, { type: 'HumanAnswered' }> & {
      readonly kind: 'ask' | 'confirm' | 'review';
    },
  ): Promise<void> {
    const requested = this.#records.find(
      (record) =>
        record.type === 'HUMAN_REQUESTED' &&
        record.workflowRunId === workflowRunId &&
        'humanRequestId' in event &&
        record.humanRequestId === event.humanRequestId,
    );
    if (requested?.type !== 'HUMAN_REQUESTED') throw new Error('an answer names no question');
    const projected = projectGraph(this.#records, workflowRunId);
    const status = projected.view.get(requested.nodeId)?.status;
    if (status === undefined || isTerminal(status) || this.#turnId === undefined) return;
    const asker = this.#askerOf(projected, requested.nodeId);
    await this.#append([
      {
        type: 'HUMAN_ANSWERED',
        workflowRunId,
        turnId: this.#turnId,
        nodeId: requested.nodeId,
        humanRequestId: requested.humanRequestId,
        kind: event.kind,
        origin: 'requested',
        inputId: event.inputId,
        contentRef: event.contentRef,
        ...(asker === undefined ? {} : { attachedAgentRunId: asker.state.agentRunId }),
      },
      {
        type: 'NODE_ENDED',
        workflowRunId,
        turnId: this.#turnId,
        nodeId: requested.nodeId,
        status: 'SUCCEEDED',
        resultRef: event.contentRef,
      },
    ]);
    await this.#advance(workflowRunId);
  }

  /**
   * `ask_user` (M2Design 3.4): what the question points at is checked, and then the graph grows by
   * the HUMAN node that asks it. The caller waits like it waits for tasks: its node is WAITING, and
   * its AgentRun has a call whose result has not come yet.
   */
  async #onAsk(
    workflowRunId: string,
    active: ActiveAgent,
    ending: Extract<AgentEnding, { kind: 'ASK' }>,
  ): Promise<void> {
    const { toolCallId } = ending.source;
    const args = ending.arguments as AskUserArgs;
    const problem = askProblem(args, readableArtifacts(this.#records, active.state.agentRunId));
    if (problem !== undefined) {
      await this.#apply(
        workflowRunId,
        answerDelegatedCall(
          active.state,
          toolCallId,
          {
            refused: true,
            spawn: false,
            records: [answerRecord(active.state, 'INVALID_ACTION', toolCallId, problem)],
          },
          this.#context(workflowRunId, active.scope),
          this.#deps.config,
        ),
      );
      return;
    }
    const revisionNumber = projectGraph(this.#records, workflowRunId).lastRevision + 1;
    await this.#extend(
      workflowRunId,
      revisionNumber,
      'ASK',
      askRevision(
        workflowRunId,
        revisionNumber,
        { nodeId: active.nodeId, toolCallId },
        {
          kind: args.kind,
          question: args.question,
          ...(args.fields === undefined ? {} : { fields: args.fields }),
          ...(args.reviewArtifact === undefined ? {} : { reviewRef: args.reviewArtifact }),
        },
      ),
    );
    await this.#advance(workflowRunId);
  }

  /**
   * A note of the user slipped into a run that goes on (M2Design 4.5): a HUMAN(steer) node, made
   * and ended at once, and the record that says whom it is for. The AgentRun sees it at its next
   * assembly (history projection); nothing about its own state changes.
   */
  async #steer(
    workflowRunId: string,
    note: {
      readonly inputId: string;
      readonly contentRef: ArtifactRef;
      readonly targetAgentRunId?: string;
    },
  ): Promise<void> {
    const target = this.#steerTarget(note.targetAgentRunId);
    const revision = projectGraph(this.#records, workflowRunId).lastRevision + 1;
    const content = steerRevision(workflowRunId, revision);
    await this.#extend(workflowRunId, revision, 'STEER', content);
    const node = content.nodes[0];
    if (node === undefined) throw new Error('a steer makes one node');
    const turn = this.#turnId === undefined ? {} : { turnId: this.#turnId };
    await this.#append([
      {
        type: 'HUMAN_ANSWERED',
        workflowRunId,
        ...turn,
        nodeId: node.nodeId,
        kind: 'steer',
        origin: 'unrequested',
        inputId: note.inputId,
        contentRef: note.contentRef,
        ...(target === undefined ? {} : { attachedAgentRunId: target.agentRunId }),
        ...(target?.redirectedFrom === undefined ? {} : { redirectedFrom: target.redirectedFrom }),
      },
      { type: 'NODE_ENDED', workflowRunId, ...turn, nodeId: node.nodeId, status: 'SUCCEEDED' },
    ]);
  }

  /**
   * Whom a note is for: the AgentRun it names, or main of this Turn. One that has ended hands it to
   * the AgentRun that started it, and so on up; with nobody left it waits for the next Turn.
   */
  #steerTarget(
    requested: string | undefined,
  ): { readonly agentRunId: string; readonly redirectedFrom?: string } | undefined {
    if (requested === undefined) {
      const main = [...this.#agents.values()].find(
        (each) => each.task === undefined && each.agentId === MAIN,
      );
      return main === undefined ? undefined : { agentRunId: main.state.agentRunId };
    }
    if (this.#agents.has(requested)) return { agentRunId: requested };
    const parentOf = (agentRunId: string): string | undefined => {
      const registered = this.#records.find(
        (record) => record.type === 'AGENT_RUN_REGISTERED' && record.agentRunId === agentRunId,
      );
      return registered?.type === 'AGENT_RUN_REGISTERED' ? registered.parentAgentRunId : undefined;
    };
    for (let parent = parentOf(requested); parent !== undefined; parent = parentOf(parent))
      if (this.#agents.has(parent)) return { agentRunId: parent, redirectedFrom: requested };
    return undefined;
  }

  /** The user continued a paused run, perhaps with a note: the note first, then what was held. */
  async #onResumed(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEvent, { type: 'RunResumed' }>,
  ): Promise<void> {
    await this.#append([
      {
        type: 'RUN_RESUMED',
        workflowRunId,
        ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
        ...(event.steer === undefined ? {} : { steerInputId: event.steer.inputId }),
      },
    ]);
    if (event.steer !== undefined) await this.#steer(workflowRunId, event.steer);
    for (const active of [...this.#agents.values()]) {
      const current = this.#agents.get(active.state.agentRunId);
      if (current === undefined) continue;
      await this.#apply(
        workflowRunId,
        resumeAfterPause(
          current.state,
          this.#context(workflowRunId, current.scope),
          this.#deps.config,
        ),
      );
    }
  }

  async #onHumanAnswered(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEvent, { type: 'HumanAnswered' }>,
  ): Promise<void> {
    if (event.kind === 'steer') return this.#steer(workflowRunId, event);
    if (event.kind !== 'prompt') return this.#onAnswer(workflowRunId, event);
    const { graph, view } = projectGraph(this.#records, workflowRunId);
    const node =
      event.origin === 'initial'
        ? graph.nodes.find((candidate) => candidate.kind === 'HUMAN')
        : graph.nodes.find(
            (candidate) => asHumanRequestId(candidate.nodeId) === event.humanRequestId,
          );
    if (node === undefined) throw new Error('HumanAnswered names no HUMAN node');
    if (view.get(node.nodeId)?.status === 'SUCCEEDED') return;
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
    const { skipped, ready, wake: woken } = advanceGraph(projected.graph, projected.view);
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
        await this.#requestHuman(workflowRunId, record);
      } else {
        await this.#startAgent(workflowRunId, record);
      }
    }
    await this.#wake(workflowRunId, woken);
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

  /**
   * A HUMAN node starts: open input (`prompt`), which needs the run to be still, or the question
   * of an `ask_user` call, which only the AgentRun that asked waits for (M2Design 4.2).
   */
  async #requestHuman(workflowRunId: string, node: GraphNodeRecord): Promise<void> {
    const { nodeId, ask } = node;
    const humanRequestId = asHumanRequestId(nodeId);
    const asker =
      ask === undefined
        ? undefined
        : this.#askerOf(projectGraph(this.#records, workflowRunId), nodeId);
    if (ask !== undefined && asker === undefined)
      throw new Error('a question has no AgentRun that asked it');
    const question =
      ask === undefined || asker === undefined
        ? ({ kind: 'prompt' } as const)
        : {
            kind: ask.kind,
            attachedAgentRunId: asker.state.agentRunId,
            question: ask.question,
            ...(ask.fields === undefined ? {} : { fields: ask.fields }),
            ...(ask.reviewRef === undefined ? {} : { reviewRef: ask.reviewRef }),
          };
    await this.#append([
      { type: 'HUMAN_REQUESTED', workflowRunId, humanRequestId, nodeId, ...question },
    ]);
    const sessionId = this.#sessionIdOrThrow();
    const response = await this.#deps.gateway.requestHuman(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        humanRequestId,
        nodeId,
        ...question,
      },
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

  /** Who dispatched a task, from the `DELEGATE` edge that leads to it; undefined for any other node. */
  #dispatchOf(
    graph: ProjectedGraph,
    node: GraphNodeRecord,
  ): { parentAgentRunId: string; delegationId: string } | undefined {
    if (node.spawn === undefined) return undefined;
    const call = callOf(graph, node.nodeId);
    const caller = [...this.#agents.values()].find((each) => each.nodeId === call?.callerNodeId);
    if (call?.delegationId === undefined || caller === undefined)
      throw new Error(`the task ${node.name} was not dispatched by a running AgentRun`);
    return { parentAgentRunId: caller.state.agentRunId, delegationId: call.delegationId };
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
    const graph = projectGraph(this.#records, workflowRunId);
    const place = placementOf(
      node,
      {
        label: binding.definitions.label,
        effort: binding.effort,
        writeRoots: binding.writeRoots,
      },
      this.#dispatchOf(graph, node),
    );
    await this.#append([
      {
        type: 'AGENT_RUN_REGISTERED',
        workflowRunId,
        turnId,
        agentRunId,
        nodeId,
        agentRef: binding.ref,
        effort: place.effort,
        ...(place.link === undefined ? {} : { parentAgentRunId: place.link.parentAgentRunId }),
      },
      {
        type: 'REQUEST_CONTEXT',
        workflowRunId,
        turnId,
        agentRunId,
        modelRef: binding.modelRef,
        thinking: place.effort,
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
        effort: place.effort,
        workspaceViewId: 'main',
        display: { label: place.label },
        requestedCapabilities: [...binding.requestedCapabilities],
        writeRoots: [...place.writeRoots],
        ...place.link,
      },
      contextOf(sessionId, workflowRunId),
    );
    if (registered.outcome === 'REJECTED') {
      if (place.link !== undefined) {
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
    const task =
      spawn === undefined
        ? undefined
        : taskScopeOf(this.#records, workflowRunId, graph, node, spawn);
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
    if (transition.submissions.length > 0) this.#assertNotWaiting(workflowRunId, current);
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
   * A node that waits for a call it dispatched submits no new Unit (M2Design 3.1): the AgentRun
   * has nothing to do until the call comes back, so a submission now is a bug in the runner.
   */
  #assertNotWaiting(workflowRunId: string, active: ActiveAgent | undefined): void {
    if (active === undefined) return;
    const { view } = projectGraph(this.#records, workflowRunId);
    if (view.get(active.nodeId)?.status === 'WAITING')
      throw new Error(`the node of ${active.state.agentRunId} waits and submits no Unit`);
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
    // A read outside the workspace is not a read of the workspace: it must not lead to the
    // workspace's project instructions being read, and to a question about it (Kernel/Core 5h).
    const external = found.state.definitions.tools.some(
      (tool) => tool.unit.external === true && tool.unit.ref.id === report.unitRef.id,
    );
    if (report.status === 'OK' && READS_REPOSITORY.has(report.executionKind) && !external)
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

  /** A question that waited for the user ends with the run that was interrupted (M2Design 4.5). */
  async #endQuestion(workflowRunId: string, nodeId: string): Promise<void> {
    const { view } = projectGraph(this.#records, workflowRunId);
    const status = view.get(nodeId)?.status;
    if (this.#turnId === undefined || status === undefined || isTerminal(status)) return;
    await this.#endNode(workflowRunId, this.#turnId, nodeId, 'INTERRUPTED');
  }

  async #endNode(
    workflowRunId: string,
    turnId: string,
    nodeId: string,
    status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED',
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
    outcome: 'COMPLETED' | 'BUDGET' | 'INTERRUPTED' | 'CANCELLED' | 'TIMEOUT',
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
    const finished = finishedOutcome(args, task.criteria, active.changed);
    // Its result and the tool results it listed are handed over: those that pass, the others are
    // only told of.
    const handed = await this.#hand(
      workflowRunId,
      active,
      { toolCallId, ref: ending.source.modelOutputRef },
      args.references ?? [],
    );
    const outcome = { ...finished, notes: [...finished.notes, ...handed.notes] };
    await this.#endAgentRun(workflowRunId, active, 'ENDED');
    await this.#endNode(
      workflowRunId,
      active.state.turnId,
      active.nodeId,
      outcome.status === 'BLOCKED' ? 'FAILED' : 'SUCCEEDED',
      resultOf({
        ...outcome,
        toolCallId,
        ...(handed.referenceId === undefined ? {} : { referenceId: handed.referenceId }),
      }),
      ending.source.modelOutputRef,
    );
    return this.#advance(workflowRunId);
  }

  /**
   * What a SubAgent hands to the AgentRun that started it (M2Design 3.7): its result, and the tool
   * results it listed that were checked. The Kernel keeps them for the Session first; when it
   * cannot, nothing is handed over and the result goes on without a reference.
   */
  async #hand(
    workflowRunId: string,
    active: ActiveAgent,
    result: { readonly toolCallId: string; readonly ref: ArtifactRef },
    listed: readonly string[],
  ): Promise<{ readonly referenceId?: string; readonly notes: readonly string[] }> {
    const { agentRunId, sessionId, turnId } = active.state;
    const checked = checkedItems(this.#records, agentRunId, listed);
    const items = [
      { toolCallId: result.toolCallId, tool: 'finish_subagent', ref: result.ref },
      ...checked.items,
    ];
    const registered = this.#records.find(
      (record) => record.type === 'AGENT_RUN_REGISTERED' && record.agentRunId === agentRunId,
    );
    const parent =
      registered?.type === 'AGENT_RUN_REGISTERED' ? registered.parentAgentRunId : undefined;
    const receiver = parent === undefined ? undefined : this.#agents.get(parent);
    if (receiver === undefined) return { notes: checked.notes };
    const kept = await this.#deps.gateway.retainArtifacts(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        refs: items.map((item) => item.ref),
      },
      contextOf(sessionId, workflowRunId),
    );
    if (kept.outcome !== 'ACCEPTED')
      return {
        notes: [...checked.notes, 'system: its results could not be kept, so none are handed over'],
      };
    const referenceId = nextReferenceId(this.#records);
    await this.#append([
      {
        type: 'REFERENCES_REGISTERED',
        workflowRunId,
        turnId,
        referenceId,
        from: { agentRunId, label: active.task?.name ?? active.agentId },
        to: partyOf(receiver.scope),
        items,
      },
    ]);
    return { referenceId, notes: checked.notes };
  }

  /** A SubAgent that stops without a result: whatever it has left is the caller's to read. */
  async #endTask(
    workflowRunId: string,
    active: ActiveAgent,
    kind: AgentEnding['kind'],
    outcome: TaskOutcome,
    resultRef?: ArtifactRef,
  ): Promise<void> {
    await this.#endAgentRun(workflowRunId, active, kind);
    await this.#endNode(
      workflowRunId,
      active.state.turnId,
      active.nodeId,
      // A task that was cut short with the run is INTERRUPTED, whatever it had to report.
      this.#interrupted ? 'INTERRUPTED' : outcome.status === 'PARTIAL' ? 'SUCCEEDED' : 'FAILED',
      resultOf(outcome),
      resultRef,
    );
  }

  /**
   * The Kernel interrupts the run (Kernel/Core 5c, 5e): no model is called again. What waits for
   * the user is over, SubAgents stop where they are, and the AgentRun that spawned them ends with
   * the one reply that says why, which needs no model. Whatever was in flight is no longer waited
   * for. How the run goes on from there depends on why it was interrupted (`#finishInterrupted`).
   */
  async #onInterrupted(workflowRunId: string, reason: InterruptReason): Promise<void> {
    this.#interrupted = true;
    this.#interruptReason = reason;
    const all = [...this.#agents.values()];
    if (all.length === 0) return this.#finishInterrupted(workflowRunId);
    for (const nodeId of questionsOf(this.#records, workflowRunId))
      await this.#endQuestion(workflowRunId, nodeId);
    for (const active of all.filter((each) => each.task !== undefined))
      await this.#endTask(workflowRunId, active, 'FAILED', {
        status: 'FAILED',
        notes: ['stopped: the run was interrupted'],
      });
    // Every task has ended now: the calls came back, though nobody will read what they came to.
    const projected = projectGraph(this.#records, workflowRunId);
    await this.#wake(workflowRunId, wakeableNodes(projected.graph, projected.view));
    for (const active of all.filter((each) => each.task === undefined))
      await this.#onDegraded(workflowRunId, active, reason);
  }

  /**
   * Every AgentRun of an interrupted run has ended (Kernel/Core 5e). Memory pressure closes the
   * run, which the system then leaves in control; any other reason ends only the Turn: a chat asks
   * for the next input, an Orchestration run closes as cancelled or timed out.
   */
  async #finishInterrupted(workflowRunId: string): Promise<void> {
    const reason = this.#interruptReason ?? 'MEMORY_PRESSURE';
    if (reason === 'MEMORY_PRESSURE') return this.#close(workflowRunId, 'INTERRUPTED');
    if (this.#mode === 'CHAT') {
      this.#interrupted = false;
      this.#interruptReason = undefined;
      return this.#advance(workflowRunId);
    }
    return this.#close(
      workflowRunId,
      reason === 'TURN_TIMEOUT' ? 'TIMEOUT' : 'CANCELLED',
      this.#runResult,
    );
  }

  async #onDegraded(
    workflowRunId: string,
    active: ActiveAgent,
    reason: string,
    unfinished?: Extract<AgentEnding, { kind: 'DEGRADED' }>['unfinished'],
  ): Promise<void> {
    if (OVER_BUDGET.includes(reason)) this.#overBudget = true;
    const { onDegraded } = active.state.definitions;
    if (onDegraded === 'RETURN_PARTIAL') {
      // What the last round wrote is not thrown away for its form: the caller gets it as written,
      // marked as not following the form, and judges it itself.
      const handed =
        unfinished === undefined
          ? undefined
          : await this.#hand(
              workflowRunId,
              active,
              { toolCallId: unfinished.source.toolCallId, ref: unfinished.source.modelOutputRef },
              [],
            );
      await this.#endTask(
        workflowRunId,
        active,
        'DEGRADED',
        {
          status: 'PARTIAL',
          notes: [
            `stopped early: ${reason}`,
            ...(unfinished === undefined
              ? []
              : [
                  `its last result does not follow the required form (${unfinished.why}); it is shown as written`,
                ]),
          ],
          ...(unfinished === undefined ? {} : { toolCallId: unfinished.source.toolCallId }),
          ...(handed?.referenceId === undefined ? {} : { referenceId: handed.referenceId }),
        },
        unfinished?.source.modelOutputRef,
      );
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
      case 'ASK':
        return this.#onAsk(workflowRunId, active, ending);
      case 'DEGRADED':
        return this.#onDegraded(workflowRunId, active, ending.reason, ending.unfinished);
      case 'CLOSED': {
        const plan = active.nodeEnding ?? { status: 'SUCCEEDED', runOutput: false };
        await this.#endAgentRun(workflowRunId, active, ending.kind);
        await this.#endNode(
          workflowRunId,
          turnId,
          active.nodeId,
          this.#interrupted ? 'INTERRUPTED' : plan.status,
          plan.result,
          ending.outputRef,
        );
        if (plan.runOutput) this.#runResult = ending.outputRef;
        if (this.#interrupted)
          return this.#agents.size === 0 ? this.#finishInterrupted(workflowRunId) : undefined;
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
          await this.#endNode(workflowRunId, turnId, active.nodeId, 'INTERRUPTED');
          return this.#agents.size === 0 ? this.#finishInterrupted(workflowRunId) : undefined;
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
    const { toolCallId } = ending.source;
    const refuse = (text: string, withdraw = false): Promise<void> =>
      this.#apply(
        workflowRunId,
        answerDelegatedCall(
          active.state,
          toolCallId,
          {
            refused: true,
            spawn: true,
            withdraw,
            records: [answerRecord(active.state, 'INVALID_ACTION', toolCallId, text)],
          },
          this.#context(workflowRunId, active.scope),
          this.#deps.config,
        ),
      );
    const readable = readableArtifacts(this.#records, active.state.agentRunId);
    const checked = validateSpawn(ending.arguments as RunSubagentsArgs, {
      rules: this.#deps.config,
      agents: this.#spawnable,
      callerRoots: this.#binding(active.agentId).writeRoots,
      spawned: spawnedIn(this.#records, this.#turnId),
      readable: (artifactId) => readable.has(artifactId),
    });
    if (!checked.ok) {
      const withdraw = checked.errors.some((error) => error.code === 'SPAWN_LIMIT');
      return refuse(
        this.#refusalText(checked.errors, withdraw || active.state.invalidSpawns + 1 >= 2),
        withdraw,
      );
    }
    const lent = await this.#lend(workflowRunId, active, checked.plan.tasks);
    if (lent.kind === 'BLOCKED') return;
    if (lent.kind === 'REFUSED') return refuse(lent.text);
    await this.#expandGraph(workflowRunId, active, toolCallId, checked.plan.tasks, lent.reserved);
  }

  /** Asks the Kernel to lend the shares of all the tasks, or none (M2Design 7.3, rule 2). */
  async #lend(
    workflowRunId: string,
    active: ActiveAgent,
    tasks: SpawnPlan['tasks'],
  ): Promise<
    | { readonly kind: 'GRANTED'; readonly reserved: DelegationReserved }
    | { readonly kind: 'REFUSED'; readonly text: string }
    | { readonly kind: 'BLOCKED' }
  > {
    const sessionId = this.#sessionIdOrThrow();
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
          ...(task.budget === undefined ? {} : { tokens: task.budget.tokens }),
        })),
      },
      contextOf(sessionId, workflowRunId),
    );
    if (reserved.outcome === 'ACCEPTED') return { kind: 'GRANTED', reserved };
    // The run is closing: whoever asked is told by the run, not by this answer.
    if (reserved.reasonCode === 'RUN_BLOCKED') return { kind: 'BLOCKED' };
    const text =
      reserved.reasonCode === 'BUDGET_INSUFFICIENT'
        ? `BUDGET_INSUFFICIENT: at most ${String(reserved.delegable)} tokens can be lent to subtasks right now, in total. Start fewer or smaller tasks, or do the work yourself.`
        : `${reserved.reasonCode}: the system refused to start these tasks. Nothing was started.`;
    return { kind: 'REFUSED', text };
  }

  /**
   * Task graph: the tasks become nodes, joined to their caller by `DELEGATE` and `RESUME` edges,
   * so the caller is the last link of the tasks it started (M2Design 3.1, 3.6). The caller's node is
   * WAITING from here on; its AgentRun just has a tool call whose result has not come yet.
   */
  async #expandGraph(
    workflowRunId: string,
    active: ActiveAgent,
    toolCallId: string,
    tasks: SpawnPlan['tasks'],
    reserved: DelegationReserved,
  ): Promise<void> {
    const call = { toolCallId, delegationId: reserved.delegationId };
    const shares = new Map(reserved.shares.map((share) => [share.name, share]));
    const revisionNumber = projectGraph(this.#records, workflowRunId).lastRevision + 1;
    const revision = spawnRevision(
      workflowRunId,
      revisionNumber,
      { nodeId: active.nodeId, call },
      tasks.map((task) => ({
        name: task.name,
        agentRef: this.#refOf(task.agent),
        goal: task.goal,
        dependsOn: task.dependsOn ?? [],
        spawn: spawnNodeOf(task, shares.get(task.name)),
      })),
    );
    await this.#extend(workflowRunId, revisionNumber, 'SPAWN', revision);
    // The caller is WAITING from here on: the edges hold a call that has not come back.
    await this.#advance(workflowRunId);
  }

  /**
   * The graph says a call came back (its `RESUME` edges can be followed); the AgentRun that waits
   * for it goes on (M2Design 3.3): the shares of the tasks that never started go back to it, and
   * what its tasks came to answers the call.
   */
  async #wake(workflowRunId: string, woken: readonly Wake[]): Promise<void> {
    const sessionId = this.#sessionIdOrThrow();
    for (const { node, call } of woken) {
      const caller = [...this.#agents.values()].find((each) => each.nodeId === node.nodeId);
      await this.#append([
        {
          type: 'NODE_RESUMED',
          workflowRunId,
          ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
          nodeId: node.nodeId,
          call,
        },
      ]);
      // A run that is closing hears no answer; an AgentRun whose call is not out has nothing to go on with.
      if (this.#interrupted || caller === undefined || !caller.state.pending.has(call.toolCallId))
        continue;
      // A call to SubAgents has a reservation to give back; a question to the user has none.
      if (call.delegationId !== undefined)
        await this.#deps.gateway.releaseDelegation(
          { requestId: newId('req'), sessionId, workflowRunId, delegationId: call.delegationId },
          contextOf(sessionId, workflowRunId),
        );
      await this.#apply(
        workflowRunId,
        answerDelegatedCall(
          caller.state,
          call.toolCallId,
          { refused: false, spawn: call.delegationId !== undefined, records: [] },
          this.#context(workflowRunId, caller.scope),
          this.#deps.config,
        ),
      );
    }
  }
}
