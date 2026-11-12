import { settleOpenCalls } from './settle-stale.js';
import { lastWorkspaceOf } from '../domain/workspace/workspace-binding.js';
import { checkedItems, nextReferenceId } from '../domain/handover/handover.js';
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
  type HandoverParty,
  type InterruptReason,
  DEFAULT_SLEEP_SECONDS,
  type SendMessageArgs,
  type SleepArgs,
  type JobKillArgs,
  type JobOutputArgs,
  type StopSubagentsArgs,
  type WakeCondition,
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
import {
  exitText,
  jobListText,
  jobsOf,
  jobsOfMission,
  nextJobId,
  runningJobs,
} from '../domain/graph/mission-jobs.js';
import { revokedCompactions } from '../domain/context/compaction-revocation.js';
import { projectHistory, type ProjectionScope } from '../domain/context/history-projection.js';
import { isTerminal, wakeableNodes, type Wake } from '../domain/graph/graph.js';
import { placementOf } from '../domain/spawn/placement.js';
import { readableArtifacts } from '../domain/spawn/readable-artifacts.js';
import { callOf, spawnedBy, spawnNodeOf, taskScopeOf } from '../domain/spawn/spawn-graph.js';
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
  childrenOf,
  missionStateOf,
  projectMissions,
  rootMissionId,
  siblingsOf,
  treeView,
  type MissionView,
} from '../domain/graph/mission-tree.js';
import {
  advanceGraph,
  chatGrowthPoint,
  chatGrowthRevision,
  compileTemplate,
  initialChatRevision,
  projectGraph,
  askRevision,
  continuationRevision,
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
/** The id the root task of a Turn-chat is named by (Orchestration 3.2). */
const CHAT_TEMPLATE = 'chat';
/** Messages one segment may send (Orchestration 5). */
const MAX_MESSAGES_PER_SEGMENT = 10;
/** Wakes by messages, timers and jobs between two words of the user (Orchestration 4.4). */
const MAX_CONSECUTIVE_WAKES = 3;
/** Times a task is woken because nothing could move, before it is ended. */
const MAX_STALLED_WAKES = 3;
/** What one `job_output` reads at most: it must fit the answer of the call. */
const JOB_READ_BYTES = 12_000;
/** The deepest level of the MissionTree: three levels (Orchestration 3.6). */
const MAX_MISSION_DEPTH = 2;

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
  /** The task this AgentRun is a segment of (Orchestration 3.4). */
  readonly missionId: string;
  /** Messages this segment has sent. */
  readonly messages: number;
  /**
   * The segment ends after the round it is in (Orchestration 5.1, 5.2): stopped by its parent, so
   * its task ends, or interrupted, so a new segment of it starts at once.
   */
  readonly stopAfterRound?: { readonly kind: 'STOP' | 'INTERRUPT'; readonly reason: string };
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

/** What a stopped task had changed, so its parent knows what it leaves behind. */
function changedNote(changed: readonly string[]): string[] {
  if (changed.length === 0) return [];
  const shown = changed.slice(0, 10).join(', ');
  return [
    `it changed: ${shown}${changed.length > 10 ? ` and ${String(changed.length - 10)} more` : ''}`,
  ];
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
  /** Delegations given back once all their tasks ended (Orchestration 8.2). */
  readonly #released = new Set<string>();

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
    this.#released.clear();
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
      case 'JobEnded':
        await this.#onJobEnded(workflowRunId, event);
        break;
      case 'WakeDue':
        // Recorded first, so a wake by time is read from the log like any other (4.2).
        await this.#append([
          {
            type: 'MISSION_TIMER_DUE',
            workflowRunId,
            ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
            missionId: event.missionId,
            timerId: event.timerId,
          },
        ]);
        await this.#advance(workflowRunId);
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
    source: 'TEMPLATE' | 'CHAT_GROWTH' | 'SPAWN' | 'STEER' | 'ASK' | 'WAKE',
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
    const sessionId = this.#sessionIdOrThrow();
    if (event.mode === 'CHAT')
      return initialChatRevision(
        workflowRunId,
        this.#mainRef(),
        rootMissionId(sessionId, CHAT_TEMPLATE),
      );
    const template = this.#deps.templates.get(event.templateRef.id);
    if (template === undefined) throw new Error(`unknown template ${event.templateRef.id}`);
    const compiled = compileTemplate(
      workflowRunId,
      template,
      rootMissionId(sessionId, template.id),
    );
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

  /**
   * The binding of an Agent for a task at `depth`: at the deepest level it does not spawn
   * (Orchestration 3.6), and lent a scope without commands it runs none (D17).
   */
  #bindingAt(agentId: string, depth: number, commands = true): AgentBinding {
    let binding = this.#binding(agentId);
    if (depth >= MAX_MISSION_DEPTH && binding.definitions.spawnTool !== undefined) {
      const definitions: AgentDefinitions = { ...binding.definitions };
      delete (definitions as { spawnTool?: unknown }).spawnTool;
      binding = {
        ...binding,
        requestedCapabilities: binding.requestedCapabilities.filter(
          (capability) => capability !== 'agent.spawn',
        ),
        definitions,
      };
    }
    if (commands) return binding;
    return {
      ...binding,
      requestedCapabilities: binding.requestedCapabilities.filter(
        (capability) => capability !== 'command.exec' && capability !== 'command.network',
      ),
      definitions: {
        ...binding.definitions,
        tools: binding.definitions.tools.filter((tool) => tool.executionKind !== 'COMMAND'),
      },
    };
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
    await this.#settleMissions(workflowRunId);
    await this.#releaseFinishedDelegations(workflowRunId);
    if (this.#mode === 'CHAT') {
      const projected = projectGraph(this.#records, workflowRunId);
      const growth = chatGrowthPoint(projected);
      if (growth !== undefined) {
        const revision = projected.lastRevision + 1;
        await this.#extend(
          workflowRunId,
          revision,
          'CHAT_GROWTH',
          chatGrowthRevision(
            workflowRunId,
            revision,
            growth,
            this.#mainRef(),
            rootMissionId(this.#sessionIdOrThrow(), CHAT_TEMPLATE),
          ),
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
    if (await this.#wakeMissions(workflowRunId)) {
      this.#advanceAgain = true;
      return;
    }
    // A task that sleeps still has work ahead: it waits for a timer, a job or a message that will
    // come. When none can come, the stall handling above wakes or closes it; the run never ends
    // as finished around it, and never ends its root before the root has delivered.
    if (
      this.#mode === 'ORCHESTRATION' &&
      ready.length === 0 &&
      this.#agents.size === 0 &&
      this.#sleeping(workflowRunId).length === 0
    )
      await this.#closeFinishedRun(workflowRunId);
  }

  /** A template run ends when its graph has nothing left to start. */
  async #closeFinishedRun(workflowRunId: string): Promise<void> {
    // The root task ends with the run it is the owner of (Orchestration 3.3).
    const roots = [...projectMissions(this.#records).values()].filter(
      (mission) =>
        mission.parentId === undefined &&
        mission.ended === undefined &&
        mission.nodeIds.some((nodeId) =>
          projectGraph(this.#records, workflowRunId).nodes.has(nodeId),
        ),
    );
    await this.#append(
      roots.map((mission) => ({
        type: 'MISSION_ENDED' as const,
        workflowRunId,
        ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
        missionId: mission.missionId,
        status: this.#runFailure === undefined ? ('SUCCEEDED' as const) : ('FAILED' as const),
      })),
    );
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
        toolInputOf(
          kind,
          args,
          [...this.#records, ...(notYetInLog as SessionLogRecord[])],
          scope,
          this.#repositoryRoot,
        ),
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
  ): { parentAgentRunId?: string; delegationId: string } | undefined {
    if (node.spawn === undefined) return undefined;
    const call = callOf(graph, node.nodeId);
    if (call?.delegationId === undefined)
      throw new Error(`the task ${node.name} was not dispatched by run_subagents`);
    // The caller may have gone to sleep since: its task, not its AgentRun, stands behind the task.
    const caller = [...this.#agents.values()].find((each) => each.nodeId === call.callerNodeId);
    return {
      ...(caller === undefined ? {} : { parentAgentRunId: caller.state.agentRunId }),
      delegationId: call.delegationId,
    };
  }

  /** The node a task was started by: itself, or the first segment of its task. */
  #taskNodeOf(workflowRunId: string, node: GraphNodeRecord): GraphNodeRecord | undefined {
    if (node.spawn !== undefined) return node;
    const missionId = node.mission?.id;
    if (missionId === undefined) return undefined;
    const first = projectMissions(this.#records).get(missionId)?.nodeIds[0];
    const found =
      first === undefined ? undefined : projectGraph(this.#records, workflowRunId).nodes.get(first);
    return found?.spawn === undefined ? undefined : found;
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
    const graph = projectGraph(this.#records, workflowRunId);
    const missionId = node.mission?.id ?? agentRunId;
    // Below the deepest level a task does not spawn (Orchestration 3.6).
    const depth = projectMissions(this.#records).get(missionId)?.depth ?? 0;
    // A later segment of a spawned task works within what its first segment was given.
    const taskNode = this.#taskNodeOf(workflowRunId, node);
    const binding = this.#bindingAt(agentId, depth, taskNode?.spawn?.commands !== false);
    const place = placementOf(
      taskNode ?? node,
      {
        label: binding.definitions.label,
        effort: binding.effort,
        writeRoots: binding.writeRoots,
      },
      spawn === undefined
        ? taskNode === undefined
          ? undefined
          : { delegationId: '' }
        : this.#dispatchOf(graph, node),
    );
    const link = spawn === undefined ? undefined : place.link;
    await this.#append([
      {
        type: 'AGENT_RUN_REGISTERED',
        workflowRunId,
        turnId,
        agentRunId,
        nodeId,
        agentRef: binding.ref,
        effort: place.effort,
        ...(link?.parentAgentRunId === undefined
          ? {}
          : { parentAgentRunId: link.parentAgentRunId }),
        missionId,
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
        ...(link === undefined ? {} : { delegationId: link.delegationId, taskName: link.taskName }),
        ...(node.mission === undefined
          ? {}
          : {
              mission: {
                missionId: node.mission.id,
                ...(node.mission.parentId === undefined
                  ? {}
                  : { parentMissionId: node.mission.parentId }),
              },
            }),
      },
      contextOf(sessionId, workflowRunId),
    );
    if (registered.outcome === 'REJECTED') {
      if (taskNode !== undefined) {
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
      taskNode?.spawn !== undefined
        ? taskScopeOf(this.#records, workflowRunId, graph, taskNode, taskNode.spawn)
        : node.goal !== undefined && this.#mode === 'ORCHESTRATION'
          ? {
              // A template step is told what its step is, and keeps the user's goal (3.5).
              name: node.name,
              agent: agentId,
              goal: node.goal,
              acceptance: [],
              writeScope: [],
              inputs: [],
              dependencies: [],
              withPrompt: true,
            }
          : undefined;
    const scope: ProjectionScope =
      this.#mode === 'CHAT' && taskNode === undefined && node.mission?.parentId === undefined
        ? { kind: 'MAIN', ...(node.mission === undefined ? {} : { missionId }) }
        : {
            kind: 'NODE',
            workflowRunId,
            agentRunId,
            ...(node.mission === undefined ? {} : { missionId }),
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
      missionId,
      messages: 0,
      scope,
      agentId,
      changed: [],
      unchecked: false,
      completionAsked: false,
      ...(taskNode?.spawn === undefined
        ? {}
        : { task: { name: taskNode.name, criteria: taskNode.spawn.acceptance } }),
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
    // A segment told to stop or interrupted ends where its next round would begin (5.1, 5.2).
    const halted = this.#agents.get(agentRunId);
    // A segment that would go to sleep instead is halted just the same: stopped, it does not sleep
    // on; interrupted, it starts again at once with the interrupt.
    if (
      halted?.stopAfterRound !== undefined &&
      (transition.ending?.kind === 'SLEEP' ||
        (transition.ending === undefined &&
          transition.submissions.some((each) => each.unitRef.id === 'context-assemble')))
    ) {
      // The sleep it asked for is answered, so its history stays whole.
      if (transition.ending?.kind === 'SLEEP')
        await this.#append([
          answerRecord(
            transition.state,
            'NOT_ASLEEP',
            transition.ending.source.toolCallId,
            halted.stopAfterRound.kind === 'STOP'
              ? 'Not asleep: your parent stopped this task.'
              : 'Not asleep: your parent interrupted you; its message follows.',
          ),
        ]);
      return this.#halt(workflowRunId, halted, halted.stopAfterRound);
    }
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
    await this.#noteJobStarted(workflowRunId, active, report);
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
    status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED' | 'YIELDED',
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

  /**
   * The AgentRun ends. Its task goes on (`continues`) when it went to sleep, and always for a root
   * task, whose next step is another segment; a task below ends with its last segment (8.1).
   */
  async #endAgentRun(
    workflowRunId: string,
    active: ActiveAgent,
    outcome: AgentEnding['kind'] | 'YIELDED',
    sleeping = false,
  ): Promise<void> {
    const isRoot =
      projectGraph(this.#records, workflowRunId).nodes.get(active.nodeId)?.mission?.parentId ===
      undefined;
    const continues = sleeping || isRoot;
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
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        agentRunId,
        ...(continues ? { missionContinues: true } : {}),
      },
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
    // A task that started subtasks ends only after they ended (D4, Orchestration 9.3).
    const running = this.#runningChildren(active.missionId);
    if (running.length > 0 && !active.state.final)
      return this.#sendBack(
        workflowRunId,
        active,
        ending.source.toolCallId,
        'SUBTASKS_RUNNING',
        `Not yet: subtasks you started are still running (${running.map((each) => each.name).join(', ')}). Call sleep with until children: you are woken as each one ends; finish when all have ended.`,
      );
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
          // In a template, the reply of the output step is the result of the run (3.5, 10.1).
          {
            status: 'SUCCEEDED',
            runOutput:
              this.#mode === 'ORCHESTRATION' &&
              projectGraph(this.#records, workflowRunId).nodes.get(active.nodeId)?.output === true,
          },
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
    // The receiver is the parent task, whichever of its segments reads it, asleep or not (3.4).
    const missions = projectMissions(this.#records);
    const parentId = missions.get(active.missionId)?.parentId;
    const parent = parentId === undefined ? undefined : missions.get(parentId);
    if (parent === undefined) return { notes: checked.notes };
    const receiver: HandoverParty =
      this.#mode === 'CHAT' && parent.parentId === undefined
        ? { kind: 'MAIN' }
        : { kind: 'MISSION', missionId: parent.missionId };
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
        to: receiver,
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
    if (all.length === 0) {
      for (const { node } of this.#sleeping(workflowRunId))
        await this.#closeSleeping(workflowRunId, node, 'INTERRUPTED');
      await this.#settleMissions(workflowRunId);
      return this.#finishInterrupted(workflowRunId);
    }
    for (const nodeId of questionsOf(this.#records, workflowRunId))
      await this.#endQuestion(workflowRunId, nodeId);
    // A task asleep ends with the run: nothing will wake it now.
    for (const { node } of this.#sleeping(workflowRunId))
      await this.#closeSleeping(workflowRunId, node, 'INTERRUPTED');
    await this.#settleMissions(workflowRunId);
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
      // A step of a template that gave up has not delivered: `mas run` must not say it did. A run
      // cut by its budget still ends as BUDGET.
      if (this.#mode !== 'CHAT' && active.task === undefined && !OVER_BUDGET.includes(reason))
        this.#runFailure ??= reason;
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
      case 'SLEEP':
        return this.#onSleep(workflowRunId, active, ending);
      case 'MESSAGE':
        return this.#onMessage(workflowRunId, active, ending);
      case 'VIEW_TASKS':
        return this.#answerControl(
          workflowRunId,
          active,
          ending.source.toolCallId,
          false,
          'TASKS',
          treeView(projectMissions(this.#records), active.missionId, missionStateOf(this.#records)),
        );
      case 'STOP':
        return this.#onStop(workflowRunId, active, ending);
      case 'JOB':
        return this.#onJobTool(workflowRunId, active, ending);
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
      callerRoots: this.#callerRoots(workflowRunId, active),
      spawned: spawnedBy(this.#records, active.missionId),
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
    const projected = projectGraph(this.#records, workflowRunId);
    const revisionNumber = projected.lastRevision + 1;
    const missionId = projected.nodes.get(active.nodeId)?.mission?.id;
    if (missionId === undefined) throw new Error('a caller of run_subagents belongs to no task');
    const revision = spawnRevision(
      workflowRunId,
      revisionNumber,
      { nodeId: active.nodeId, call, missionId },
      tasks.map((task) => ({
        name: task.name,
        agentRef: this.#refOf(task.agent),
        goal: task.goal,
        dependsOn: task.dependsOn ?? [],
        spawn: spawnNodeOf(task, shares.get(task.name)),
      })),
    );
    await this.#extend(workflowRunId, revisionNumber, 'SPAWN', revision);
    // The call comes back at once (D14): the tasks run while the caller goes on or sleeps.
    const current = this.#agents.get(active.state.agentRunId) ?? active;
    await this.#apply(
      workflowRunId,
      answerDelegatedCall(
        current.state,
        toolCallId,
        {
          refused: false,
          spawn: true,
          records: [
            answerRecord(
              current.state,
              'STARTED',
              toolCallId,
              `Started ${String(tasks.length)} subtask(s): ${tasks.map((task) => task.name).join(', ')}. They run now; their results come to you as they finish. To wait for them, call sleep with until children: you are woken as each one ends, with its result, so you can use it, check it or start what depends on it; the others go on meanwhile. Until each has ended, its scope is its own: you may not write there, and your commands see it read-only.`,
            ),
          ],
        },
        this.#context(workflowRunId, current.scope),
        this.#deps.config,
      ),
    );
    await this.#advance(workflowRunId);
  }

  /** Where the caller may write: a task its own scope, the root what its Agent may (3.6). */
  #callerRoots(workflowRunId: string, active: ActiveAgent): readonly string[] {
    const projected = projectGraph(this.#records, workflowRunId);
    const node = projected.nodes.get(active.nodeId);
    const taskNode = node === undefined ? undefined : this.#taskNodeOf(workflowRunId, node);
    return taskNode?.spawn?.writeScope ?? this.#binding(active.agentId).writeRoots;
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

  // ---- tasks: sleep, wake, messages (Orchestration 4, 5) ------------------------------------

  /** The tasks this task started with `run_subagents` that have not ended yet. */
  #runningChildren(missionId: string): readonly MissionView[] {
    const missions = projectMissions(this.#records);
    const spawned = this.#spawnedNodes();
    return childrenOf(missions, missionId).filter(
      (child) => child.ended === undefined && child.nodeIds.some((id) => spawned.has(id)),
    );
  }

  /** The siblings of a task that have not ended: what `until siblings` can wait for (D28). */
  #runningSiblings(missionId: string): readonly MissionView[] {
    const missions = projectMissions(this.#records);
    const spawned = this.#spawnedNodes();
    return siblingsOf(missions, missionId).filter(
      (sibling) => sibling.ended === undefined && sibling.nodeIds.some((id) => spawned.has(id)),
    );
  }

  /** Nodes that `run_subagents` added: the first segments of spawned tasks. */
  #spawnedNodes(): ReadonlySet<string> {
    const found = new Set<string>();
    for (const record of this.#records)
      if (record.type === 'GRAPH_EXTENDED' && record.source === 'SPAWN')
        for (const node of record.nodes) found.add(node.nodeId);
    return found;
  }

  /**
   * `sleep` (Orchestration 4.1, 4.2): the segment ends and its task waits for what it named. A
   * sleep that nothing could ever end is not taken; the call is answered and the segment goes on.
   */
  /**
   * A command that runs on as a job (Orchestration 6.1): it is named in its task, before its result
   * is shown, so the result can say which job it is.
   */
  async #noteJobStarted(
    workflowRunId: string,
    active: ActiveAgent,
    report: Extract<KernelToWorkflowEvent, { type: 'UnitReport' }>,
  ): Promise<void> {
    if (report.status !== 'OK' || report.executionKind !== 'COMMAND') return;
    const job = (report.output as { readonly job?: { jobKey: string; promoted: boolean } }).job;
    if (job === undefined) return;
    const submitted = this.#records.find(
      (record): record is Extract<SessionLogRecord, { type: 'UNIT_SUBMITTED' }> =>
        record.type === 'UNIT_SUBMITTED' && record.requestId === report.requestId,
    );
    const fields =
      submitted?.inputSource.kind === 'TOOL_CALL'
        ? submitted.inputSource.workflowFields
        : undefined;
    const command = typeof fields?.command === 'string' ? fields.command : 'a command';
    await this.#append([
      {
        type: 'JOB_STARTED',
        workflowRunId,
        ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
        missionId: active.missionId,
        jobId: nextJobId(this.#records, active.missionId),
        jobKey: job.jobKey,
        requestId: report.requestId,
        command: command.length <= 200 ? command : `${command.slice(0, 199)}…`,
        promoted: job.promoted,
      },
    ]);
  }

  /** `job_output`, `job_list`, `job_kill` (Orchestration 6.2): only the task's own jobs. */
  async #onJobTool(
    workflowRunId: string,
    active: ActiveAgent,
    ending: Extract<AgentEnding, { kind: 'JOB' }>,
  ): Promise<void> {
    const { toolCallId } = ending.source;
    const jobs = jobsOfMission(this.#records, active.missionId);
    if (ending.action === 'LIST')
      return this.#answerControl(
        workflowRunId,
        active,
        toolCallId,
        false,
        'JOBS',
        jobListText(jobs),
      );
    const args = ending.arguments as JobOutputArgs | JobKillArgs;
    const job = jobs.find((each) => each.jobId === args.jobId);
    if (job === undefined)
      return this.#answerControl(
        workflowRunId,
        active,
        toolCallId,
        true,
        'JOB_NOT_FOUND',
        `You have no background command ${args.jobId}. ${jobListText(jobs)}`,
      );
    const sessionId = this.#sessionIdOrThrow();
    const fromStart = ending.action === 'OUTPUT' && (args as JobOutputArgs).fromStart === true;
    const response = await this.#deps.gateway.controlJob(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId: job.workflowRunId,
        jobKey: job.jobKey,
        action: ending.action === 'KILL' ? 'STOP' : 'READ',
        ...(ending.action === 'OUTPUT'
          ? { offset: fromStart ? 0 : job.readOffset, maxBytes: JOB_READ_BYTES }
          : {}),
      },
      contextOf(sessionId, workflowRunId),
    );
    const result = response.outcome === 'ACCEPTED' ? response.result : { found: false as const };
    if (!result.found) {
      const state = job.ended === undefined ? 'stopped with its run' : exitText(job.ended);
      return this.#answerControl(
        workflowRunId,
        active,
        toolCallId,
        ending.action !== 'KILL',
        'JOB_GONE',
        `${job.jobId} is no longer kept: ${state}.`,
      );
    }
    if (ending.action === 'KILL') {
      const how =
        result.exit === undefined
          ? 'stopping it; you are told when it has ended.'
          : `it had already ended [${job.ended === undefined ? 'ended' : exitText(job.ended)}].`;
      return this.#answerControl(
        workflowRunId,
        active,
        toolCallId,
        false,
        'JOB_KILLED',
        `${job.jobId}: ${how}`,
      );
    }
    await this.#append([
      {
        type: 'JOB_READ',
        workflowRunId,
        ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
        missionId: active.missionId,
        jobId: job.jobId,
        nextOffset: result.nextOffset,
      },
    ]);
    const state =
      result.exit === undefined
        ? 'running'
        : job.ended === undefined
          ? 'ended'
          : exitText(job.ended);
    const skipped =
      result.skipped > 0 ? `[${String(result.skipped)} older bytes are no longer kept]\n` : '';
    const more =
      result.nextOffset < result.totalBytes
        ? `\n[${String(result.totalBytes - result.nextOffset)} more bytes: call job_output again]`
        : '';
    const body = result.text === '' ? '(nothing new)' : result.text;
    return this.#answerControl(
      workflowRunId,
      active,
      toolCallId,
      false,
      'JOB_OUTPUT',
      `${skipped}${body}${more}\n[${job.jobId} status: ${state}]`,
    );
  }

  /**
   * A job has ended (Orchestration 6.4): recorded for its task, which reads it at its next
   * assembly, or is woken by it.
   */
  async #onJobEnded(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEvent, { type: 'JobEnded' }>,
  ): Promise<void> {
    const job = jobsOf(this.#records).find((each) => each.jobKey === event.jobKey);
    if (job === undefined || job.ended !== undefined) return;
    await this.#append([
      {
        type: 'JOB_ENDED',
        workflowRunId,
        ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
        missionId: job.missionId,
        jobId: job.jobId,
        exit: event.exit,
        durationMs: event.durationMs,
        totalBytes: event.totalBytes,
        readUpTo: job.readOffset,
        tail: event.tail.length <= 8192 ? event.tail : event.tail.slice(-8192),
      },
    ]);
    await this.#advance(workflowRunId);
  }

  /** A task that ended stops its jobs (Orchestration 6.3); their end is recorded when it comes. */
  async #stopJobsOf(workflowRunId: string, missionIds: readonly string[]): Promise<void> {
    const jobs = runningJobs(this.#records, workflowRunId).filter((job) =>
      missionIds.includes(job.missionId),
    );
    if (jobs.length === 0) return;
    const sessionId = this.#sessionIdOrThrow();
    for (const job of jobs)
      await this.#deps.gateway.controlJob(
        {
          requestId: newId('req'),
          sessionId,
          workflowRunId,
          jobKey: job.jobKey,
          action: 'STOP',
        },
        contextOf(sessionId, workflowRunId),
      );
  }

  async #onSleep(
    workflowRunId: string,
    active: ActiveAgent,
    ending: Extract<AgentEnding, { kind: 'SLEEP' }>,
  ): Promise<void> {
    const args = ending.arguments as SleepArgs;
    const { toolCallId } = ending.source;
    const running = this.#runningChildren(active.missionId);
    const jobs = jobsOfMission(this.#records, active.missionId).filter((job) => job.running);
    const siblings = this.#runningSiblings(active.missionId);
    const problems: string[] = [];
    for (const condition of args.until) {
      if (condition.kind === 'siblings') {
        const unknown = (condition.names ?? []).filter(
          (name) => !siblings.some((sibling) => sibling.name === name),
        );
        if (siblings.length === 0) problems.push('none of your sibling tasks is still running');
        else if (unknown.length > 0)
          problems.push(`no running sibling task is named ${unknown.join(', ')}`);
        continue;
      }
      if (condition.kind === 'children') {
        const unknown = (condition.names ?? []).filter(
          (name) => !running.some((child) => child.name === name),
        );
        if (running.length === 0)
          problems.push('none of the subtasks you started is still running');
        else if (unknown.length > 0)
          problems.push(`no running subtask of yours is named ${unknown.join(', ')}`);
      } else if (condition.kind === 'jobs') {
        const unknown = (condition.jobIds ?? []).filter(
          (jobId) => !jobs.some((job) => job.jobId === jobId),
        );
        if (jobs.length === 0)
          problems.push('you have no background commands that are still running');
        else if (unknown.length > 0)
          problems.push(`no running background command of yours is ${unknown.join(', ')}`);
      }
    }
    const usable = args.until.some(
      (condition) =>
        condition.kind === 'message' ||
        condition.kind === 'timer' ||
        (condition.kind === 'children' && running.length > 0) ||
        (condition.kind === 'siblings' && siblings.length > 0) ||
        (condition.kind === 'jobs' && jobs.length > 0),
    );
    if (!usable || problems.length === args.until.length)
      return this.#sendBack(
        workflowRunId,
        active,
        toolCallId,
        'SLEEP_REFUSED',
        `Not asleep: nothing you named could wake you (${problems.join('; ')}). Go on working, or finish.`,
      );
    const timeoutSeconds = args.timeoutSeconds ?? DEFAULT_SLEEP_SECONDS;
    // What it waits for, with the defaults written down (D28): each child as it ends, all of the
    // named siblings, any job.
    const until = args.until.map((condition): WakeCondition => {
      if (condition.kind === 'children' || condition.kind === 'jobs')
        return { ...condition, mode: condition.mode ?? 'any' };
      if (condition.kind === 'siblings') return { ...condition, mode: condition.mode ?? 'all' };
      return { ...condition };
    });
    const named = until
      .map((condition) =>
        'mode' in condition ? `${condition.kind} (${condition.mode})` : condition.kind,
      )
      .join(', ');
    // A timer guessed while siblings still work is the wrong way to wait for them.
    const guessing =
      siblings.length > 0 &&
      until.every((condition) => condition.kind === 'timer' || condition.kind === 'message');
    const hint = guessing
      ? ` If you are waiting for a sibling task to finish, sleep with until siblings (names) instead of a timer: you are woken when it has ended.`
      : '';
    await this.#append([
      answerRecord(
        active.state,
        'ASLEEP',
        toolCallId,
        `Asleep until: ${named} (at most ${String(timeoutSeconds)} seconds).${hint}`,
      ),
      {
        type: 'SEGMENT_YIELDED',
        workflowRunId,
        ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
        nodeId: active.nodeId,
        missionId: active.missionId,
        agentRunId: active.state.agentRunId,
        until,
        timeoutSeconds,
        source: { modelTurnRequestId: ending.source.modelTurnRequestId, toolCallId },
      },
    ]);
    await this.#endAgentRun(workflowRunId, active, 'YIELDED', true);
    await this.#endNode(workflowRunId, active.state.turnId, active.nodeId, 'YIELDED');
    // Time is the Kernel's: it is asked for the timer it named and for the most it may sleep.
    const timers = args.until.flatMap((condition) =>
      condition.kind === 'timer' ? [condition.seconds] : [],
    );
    const sessionId = this.#sessionIdOrThrow();
    const schedule = async (suffix: string, seconds: number) => {
      const response = await this.#deps.gateway.scheduleWake(
        {
          requestId: newId('req'),
          sessionId,
          workflowRunId,
          missionId: active.missionId,
          timerId: `${active.nodeId}:${suffix}`,
          seconds,
        },
        contextOf(sessionId, workflowRunId),
      );
      if (response.outcome === 'REJECTED' && response.reasonCode !== 'RUN_BLOCKED')
        throw new Error(`scheduleWake refused: ${response.reasonCode}`);
    };
    if (timers.length > 0) await schedule('timer', Math.min(...timers));
    await schedule('timeout', timeoutSeconds);
    return this.#advance(workflowRunId);
  }

  /**
   * `send_message` (Orchestration 5): routed along the tree by name, recorded once, and answered at
   * once. Who gets it reads it at its next assembly, or is woken by it.
   */
  async #onMessage(
    workflowRunId: string,
    active: ActiveAgent,
    ending: Extract<AgentEnding, { kind: 'MESSAGE' }>,
  ): Promise<void> {
    const args = ending.arguments as SendMessageArgs;
    const { toolCallId } = ending.source;
    const answer = (refused: boolean, text: string) =>
      this.#apply(
        workflowRunId,
        answerDelegatedCall(
          active.state,
          toolCallId,
          {
            refused,
            spawn: false,
            records: [answerRecord(active.state, refused ? 'NOT_SENT' : 'SENT', toolCallId, text)],
          },
          this.#context(workflowRunId, active.scope),
          this.#deps.config,
        ),
      );
    if (active.messages >= MAX_MESSAGES_PER_SEGMENT)
      return answer(
        true,
        `Not sent: at most ${String(MAX_MESSAGES_PER_SEGMENT)} messages in one segment. Write what is long into a file instead.`,
      );
    const missions = projectMissions(this.#records);
    const me = missions.get(active.missionId);
    if (me === undefined) return answer(true, 'Not sent: this task is not in the task tree.');
    const open = (each: MissionView) => each.ended === undefined;
    let targets: readonly MissionView[];
    if (args.to === 'parent') {
      const parent = me.parentId === undefined ? undefined : missions.get(me.parentId);
      if (parent === undefined) return answer(true, 'Not sent: this task has no parent task.');
      targets = [parent];
    } else if (args.to === 'children') targets = childrenOf(missions, me.missionId).filter(open);
    else if (args.to === 'siblings') targets = siblingsOf(missions, me.missionId).filter(open);
    else {
      const named = [...childrenOf(missions, me.missionId), ...siblingsOf(missions, me.missionId)]
        .filter((each) => each.name === args.to)
        .at(-1);
      if (named === undefined)
        return answer(
          true,
          `Not sent: no child or sibling task is named ${args.to}. to is parent, children, siblings or the name of one of them.`,
        );
      if (!open(named))
        return answer(true, `Not sent: task ${args.to} has already ended; it reads nothing more.`);
      targets = [named];
    }
    if (targets.length === 0)
      return answer(true, 'Not sent: there is no running task to send it to.');
    // An interrupt goes down the tree only: to a child of the sender (D21).
    const interrupt = args.interrupt === true;
    if (interrupt && targets.some((each) => each.parentId !== me.missionId))
      return answer(
        true,
        'Not sent: interrupt is only for your own subtasks. Send it without interrupt; it reaches them as information.',
      );
    this.#agents.set(active.state.agentRunId, { ...active, messages: active.messages + 1 });
    await this.#append([
      {
        type: 'MISSION_MESSAGE',
        workflowRunId,
        ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
        from: me.missionId,
        fromLabel: me.name,
        to: targets.map((each) => each.missionId),
        ...(interrupt ? { interrupt: true } : {}),
        source: {
          modelTurnRequestId: ending.source.modelTurnRequestId,
          outputRef: ending.source.modelOutputRef,
          toolCallId,
        },
      },
    ]);
    const current = this.#agents.get(active.state.agentRunId) ?? active;
    await this.#apply(
      workflowRunId,
      answerDelegatedCall(
        current.state,
        toolCallId,
        {
          refused: false,
          spawn: false,
          records: [
            answerRecord(
              current.state,
              'SENT',
              toolCallId,
              `${interrupt ? 'Interrupted' : 'Sent to'} ${targets.map((each) => each.name).join(', ')}.`,
            ),
          ],
        },
        this.#context(workflowRunId, current.scope),
        this.#deps.config,
      ),
    );
    if (interrupt)
      for (const target of targets) await this.#interruptMission(workflowRunId, target);
    return this.#advance(workflowRunId);
  }

  /**
   * An interrupt reaches a task (D20): one that works ends its round and starts again at once;
   * one that sleeps is woken now, whatever it waited for and however often it was woken.
   */
  async #interruptMission(workflowRunId: string, mission: MissionView): Promise<void> {
    const running = [...this.#agents.values()].find((each) => each.missionId === mission.missionId);
    if (running !== undefined) {
      this.#agents.set(running.state.agentRunId, {
        ...running,
        stopAfterRound: { kind: 'INTERRUPT', reason: 'interrupted by its parent' },
      });
      return;
    }
    const sleeping = this.#sleeping(workflowRunId).find(
      (each) => each.mission.missionId === mission.missionId,
    );
    if (sleeping !== undefined)
      await this.#continueMission(workflowRunId, sleeping.node, [{ kind: 'INTERRUPTED' }]);
  }

  /** Answers a control call that is not a Unit, and the segment goes on. */
  async #answerControl(
    workflowRunId: string,
    active: ActiveAgent,
    toolCallId: string,
    refused: boolean,
    code: string,
    text: string,
  ): Promise<void> {
    const shown = text.length <= 4000 ? text : `${text.slice(0, 3999)}…`;
    await this.#apply(
      workflowRunId,
      answerDelegatedCall(
        active.state,
        toolCallId,
        {
          refused,
          spawn: false,
          records: [answerRecord(active.state, code, toolCallId, shown)],
        },
        this.#context(workflowRunId, active.scope),
        this.#deps.config,
      ),
    );
  }

  /**
   * `stop_subagents` (Orchestration 5.1, D19): children of the caller stop with their subtree. A
   * task that works stops after the round it is in; one that sleeps or has not started, at once.
   */
  async #onStop(
    workflowRunId: string,
    active: ActiveAgent,
    ending: Extract<AgentEnding, { kind: 'STOP' }>,
  ): Promise<void> {
    const args = ending.arguments as StopSubagentsArgs;
    const missions = projectMissions(this.#records);
    const open = childrenOf(missions, active.missionId).filter((each) => each.ended === undefined);
    const all = args.names.includes('all');
    const targets = all ? open : open.filter((each) => args.names.includes(each.name));
    const unknown = all
      ? []
      : args.names.filter((name) => !targets.some((each) => each.name === name));
    if (unknown.length > 0 || targets.length === 0)
      return this.#answerControl(
        workflowRunId,
        active,
        ending.source.toolCallId,
        true,
        'NOT_STOPPED',
        `Nothing stopped: ${unknown.length > 0 ? `no running subtask of yours is named ${unknown.join(', ')}` : 'none of your subtasks is running'}.`,
      );
    const reason = args.reason;
    for (const target of targets) await this.#stopMission(workflowRunId, target, reason, missions);
    await this.#answerControl(
      workflowRunId,
      this.#agents.get(active.state.agentRunId) ?? active,
      ending.source.toolCallId,
      false,
      'STOPPING',
      `Stopping ${targets.map((each) => each.name).join(', ')} with what they started. One that is working stops after its current step; you get each result as stopped.`,
    );
    return this.#advance(workflowRunId);
  }

  /** A task and everything below it come to an end (Orchestration 5.1). */
  async #stopMission(
    workflowRunId: string,
    mission: MissionView,
    reason: string,
    missions: ReadonlyMap<string, MissionView>,
  ): Promise<void> {
    for (const child of childrenOf(missions, mission.missionId))
      if (child.ended === undefined)
        await this.#stopMission(workflowRunId, child, reason, missions);
    const note = `stopped by its parent: ${reason}`;
    const running = [...this.#agents.values()].find((each) => each.missionId === mission.missionId);
    if (running !== undefined) {
      this.#agents.set(running.state.agentRunId, {
        ...running,
        stopAfterRound: { kind: 'STOP', reason: note },
      });
      return;
    }
    const sleeping = this.#sleeping(workflowRunId).find(
      (each) => each.mission.missionId === mission.missionId,
    );
    if (sleeping !== undefined) {
      await this.#closeSleeping(workflowRunId, sleeping.node, 'INTERRUPTED', note);
      return;
    }
    // Not started yet: its nodes end without running.
    const projected = projectGraph(this.#records, workflowRunId);
    const turn = this.#turnId === undefined ? {} : { turnId: this.#turnId };
    await this.#append(
      mission.nodeIds
        .filter(
          (nodeId) =>
            projected.view.get(nodeId)?.status === 'PENDING' || !projected.view.has(nodeId),
        )
        .filter((nodeId) => projected.nodes.has(nodeId))
        .map((nodeId) => ({
          type: 'NODE_ENDED' as const,
          workflowRunId,
          ...turn,
          nodeId,
          status: 'INTERRUPTED' as const,
          result: resultOf({ status: 'FAILED', notes: [note] }),
        })),
    );
  }

  /**
   * The round of a segment told to stop has ended (5.1, 5.2): stopped, its task ends with what it
   * did; interrupted, a new segment of its task starts at once and reads why at the end.
   */
  async #halt(
    workflowRunId: string,
    active: ActiveAgent,
    halt: NonNullable<ActiveAgent['stopAfterRound']>,
  ): Promise<void> {
    const { turnId } = active.state;
    if (halt.kind === 'STOP') {
      await this.#endAgentRun(workflowRunId, active, 'FAILED');
      await this.#endNode(
        workflowRunId,
        turnId,
        active.nodeId,
        'INTERRUPTED',
        resultOf({ status: 'FAILED', notes: [halt.reason, ...changedNote(active.changed)] }),
      );
      return this.#advance(workflowRunId);
    }
    await this.#endAgentRun(workflowRunId, active, 'YIELDED', true);
    await this.#endNode(workflowRunId, turnId, active.nodeId, 'YIELDED');
    const node = projectGraph(this.#records, workflowRunId).nodes.get(active.nodeId);
    if (node !== undefined)
      await this.#continueMission(workflowRunId, node, [{ kind: 'INTERRUPTED' }]);
    return this.#advance(workflowRunId);
  }

  /**
   * A task whose last segment has ended for good has ended: its `MISSION_ENDED` is written, once
   * (Orchestration 3.2). A root task ends only by its own end or with the run, never here.
   */
  async #settleMissions(workflowRunId: string): Promise<void> {
    const projected = projectGraph(this.#records, workflowRunId);
    const missions = projectMissions(this.#records);
    const ended: NewLogRecord[] = [];
    for (const mission of missions.values()) {
      if (mission.ended !== undefined || mission.parentId === undefined) continue;
      const last = mission.nodeIds.at(-1);
      if (last === undefined || !projected.nodes.has(last)) continue;
      const status = projected.view.get(last)?.status;
      if (status === undefined || !isTerminal(status) || status === 'YIELDED') continue;
      ended.push({
        type: 'MISSION_ENDED',
        workflowRunId,
        ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
        missionId: mission.missionId,
        status:
          status === 'SUCCEEDED'
            ? 'SUCCEEDED'
            : status === 'INTERRUPTED'
              ? 'INTERRUPTED'
              : 'FAILED',
      });
    }
    await this.#append(ended);
    await this.#stopJobsOf(
      workflowRunId,
      ended.flatMap((record) => (record.type === 'MISSION_ENDED' ? [record.missionId] : [])),
    );
  }

  /**
   * A delegation whose tasks have all ended is given back: the shares never claimed return to the
   * caller, and its task may write in their scopes again (M2Design 7.3, Orchestration 8.2).
   */
  async #releaseFinishedDelegations(workflowRunId: string): Promise<void> {
    const projected = projectGraph(this.#records, workflowRunId);
    const missions = projectMissions(this.#records);
    const byDelegation = new Map<string, string[]>();
    for (const edge of projected.graph.edges)
      if (edge.kind === 'DELEGATE' && edge.call?.delegationId !== undefined)
        byDelegation.set(edge.call.delegationId, [
          ...(byDelegation.get(edge.call.delegationId) ?? []),
          edge.to,
        ]);
    const sessionId = this.#sessionIdOrThrow();
    for (const [delegationId, nodeIds] of byDelegation) {
      if (this.#released.has(delegationId)) continue;
      const done = nodeIds.every((nodeId) => {
        const missionId = projected.nodes.get(nodeId)?.mission?.id;
        return missionId !== undefined && missions.get(missionId)?.ended !== undefined;
      });
      if (!done) continue;
      this.#released.add(delegationId);
      await this.#deps.gateway.releaseDelegation(
        { requestId: newId('req'), sessionId, workflowRunId, delegationId },
        contextOf(sessionId, workflowRunId),
      );
    }
  }

  /**
   * What wakes each sleeping task now (Orchestration 4.2, 4.4): the events since it went to sleep
   * that it named, within the limit of wakes without the user. Pure in the log.
   */
  #wakeCauses(
    mission: MissionView,
    yielded: Extract<SessionLogRecord, { type: 'SEGMENT_YIELDED' }>,
    missions: ReadonlyMap<string, MissionView>,
  ): Extract<SessionLogRecord, { type: 'MISSION_WOKEN' }>['causes'] {
    const after = (seq: number) => seq > yielded.seq;
    // A message counts when the task has not seen it: after the last context it was given, even
    // if it came just before it went to sleep.
    let lastSeen = 0;
    for (const record of this.#records)
      if (
        record.type === 'UNIT_SUBMITTED' &&
        record.agentRunId === yielded.agentRunId &&
        record.unitRef.id === 'context-assemble'
      )
        lastSeen = record.seq;
    const causes: Extract<SessionLogRecord, { type: 'MISSION_WOKEN' }>['causes'][number][] = [];
    const spawned = this.#spawnedNodes();
    const children = childrenOf(missions, mission.missionId).filter((child) =>
      child.nodeIds.some((id) => spawned.has(id)),
    );
    const endedAt = new Map<string, number>();
    const messages: number[] = [];
    for (const record of this.#records) {
      if (
        record.type === 'MISSION_TIMER_DUE' &&
        record.missionId === mission.missionId &&
        after(record.seq)
      ) {
        if (record.timerId === `${yielded.nodeId}:timeout`)
          causes.push({ kind: 'TIMEOUT', seq: record.seq });
        else if (
          record.timerId === `${yielded.nodeId}:timer` &&
          !this.#wakeLimitReached(mission.missionId)
        )
          causes.push({ kind: 'TIMER', seq: record.seq });
      }
      if (record.type === 'MISSION_ENDED') endedAt.set(record.missionId, record.seq);
      if (
        record.type === 'MISSION_MESSAGE' &&
        record.to.includes(mission.missionId) &&
        record.seq > lastSeen
      )
        messages.push(record.seq);
    }
    const endedWith = new Map(
      this.#records.flatMap((record) =>
        record.type === 'MISSION_ENDED' ? [[record.missionId, record.status] as const] : [],
      ),
    );
    for (const condition of yielded.until) {
      if (condition.kind === 'children') {
        const watched = children.filter(
          (child) => condition.names === undefined || condition.names.includes(child.name),
        );
        if (watched.length === 0) continue;
        const ends = watched.map((child) => endedAt.get(child.missionId));
        const allEnded = ends.every((seq) => seq !== undefined);
        const anyNew = ends.some((seq) => seq !== undefined && after(seq));
        if (condition.mode === 'all' ? allEnded : anyNew || allEnded)
          causes.push({ kind: 'CHILDREN', seq: Math.max(...ends.map((seq) => seq ?? 0)) });
      }
      if (condition.kind === 'siblings') {
        const watched = siblingsOf(missions, mission.missionId).filter(
          (sibling) =>
            sibling.nodeIds.some((id) => spawned.has(id)) &&
            (condition.names === undefined || condition.names.includes(sibling.name)),
        );
        if (watched.length === 0) continue;
        const ends = watched.map((sibling) => endedAt.get(sibling.missionId));
        const allEnded = ends.every((seq) => seq !== undefined);
        const anyNew = ends.some((seq) => seq !== undefined && after(seq));
        if (condition.mode === 'all' ? allEnded : anyNew)
          causes.push({ kind: 'SIBLINGS', seq: Math.max(...ends.map((seq) => seq ?? 0)) });
      }
    }
    // A subtask that failed or was stopped wakes its parent whatever it waits for (D28): the parent
    // has to decide what to do about it now, not after the others.
    if (!causes.some((cause) => cause.kind === 'CHILDREN')) {
      const failed = children
        .map((child) => ({ child, seq: endedAt.get(child.missionId) }))
        .filter(
          ({ child, seq }) =>
            seq !== undefined && after(seq) && endedWith.get(child.missionId) !== 'SUCCEEDED',
        );
      if (failed.length > 0)
        causes.push({ kind: 'CHILDREN', seq: Math.max(...failed.map(({ seq }) => seq ?? 0)) });
    }
    // A job wakes when it was named, and the limit allows it (Orchestration 6.4).
    const jobs = jobsOfMission(this.#records, mission.missionId);
    for (const condition of yielded.until) {
      if (condition.kind !== 'jobs') continue;
      const watched = jobs.filter(
        (job) => condition.jobIds === undefined || condition.jobIds.includes(job.jobId),
      );
      const ends = watched.map((job) => job.ended?.seq);
      if (watched.length === 0 || this.#wakeLimitReached(mission.missionId)) continue;
      const anyNew = ends.some((seq) => seq !== undefined && after(seq));
      const allEnded = ends.every((seq) => seq !== undefined);
      if (condition.mode === 'all' ? allEnded && anyNew : anyNew)
        causes.push({ kind: 'JOB', seq: Math.max(...ends.map((seq) => seq ?? 0)) });
    }
    // A message wakes a sleeping task whatever it waited for, within the limit (D20).
    if (messages.length > 0 && !this.#wakeLimitReached(mission.missionId))
      causes.push({ kind: 'MESSAGE', seq: messages[0] ?? yielded.seq });
    return causes;
  }

  /** Wakes by messages, timers and jobs since the last word of the user (Orchestration 4.4). */
  #wakeLimitReached(missionId: string): boolean {
    let count = 0;
    for (const record of this.#records) {
      if (record.type === 'HUMAN_ANSWERED') count = 0;
      if (
        record.type === 'MISSION_WOKEN' &&
        record.missionId === missionId &&
        record.causes.some(
          (cause) => cause.kind === 'MESSAGE' || cause.kind === 'TIMER' || cause.kind === 'JOB',
        )
      )
        count += 1;
    }
    return count >= MAX_CONSECUTIVE_WAKES;
  }

  /** The tasks that sleep now: their last segment yielded and nobody took over yet. */
  #sleeping(workflowRunId: string): readonly {
    readonly mission: MissionView;
    readonly node: GraphNodeRecord;
    readonly yielded: Extract<SessionLogRecord, { type: 'SEGMENT_YIELDED' }>;
  }[] {
    const projected = projectGraph(this.#records, workflowRunId);
    const missions = projectMissions(this.#records);
    const found: {
      mission: MissionView;
      node: GraphNodeRecord;
      yielded: Extract<SessionLogRecord, { type: 'SEGMENT_YIELDED' }>;
    }[] = [];
    for (const mission of missions.values()) {
      if (mission.ended !== undefined) continue;
      const last = mission.nodeIds.at(-1);
      const node = last === undefined ? undefined : projected.nodes.get(last);
      if (node === undefined || projected.view.get(node.nodeId)?.status !== 'YIELDED') continue;
      const yielded = [...this.#records]
        .reverse()
        .find(
          (record): record is Extract<SessionLogRecord, { type: 'SEGMENT_YIELDED' }> =>
            record.type === 'SEGMENT_YIELDED' && record.nodeId === node.nodeId,
        );
      if (yielded !== undefined) found.push({ mission, node, yielded });
    }
    return found;
  }

  /**
   * Wakes every sleeping task whose wait is over: the reason is written, then the segment that
   * takes over, which is ready at once (Orchestration 4.3). When nothing can move any more, the
   * highest sleeping task is woken to decide what to do (4.4).
   */
  async #wakeMissions(workflowRunId: string): Promise<boolean> {
    if (this.#interrupted) return false;
    const missions = projectMissions(this.#records);
    let woke = false;
    for (const { mission, node, yielded } of this.#sleeping(workflowRunId)) {
      const causes = this.#wakeCauses(mission, yielded, missions);
      if (causes.length === 0) continue;
      await this.#continueMission(workflowRunId, node, causes);
      woke = true;
    }
    if (woke) return true;
    const sleeping = this.#sleeping(workflowRunId);
    if (sleeping.length === 0 || this.#agents.size > 0 || this.#waitingForHuman(workflowRunId))
      return false;
    // A timer it set itself will move the work; the timeout every sleep has does not count.
    const due = new Set(
      this.#records.flatMap((record) =>
        record.type === 'MISSION_TIMER_DUE' ? [record.timerId] : [],
      ),
    );
    if (
      sleeping.some(
        ({ node, yielded }) =>
          yielded.until.some((condition) => condition.kind === 'timer') &&
          !due.has(`${node.nodeId}:timer`),
      )
    )
      return false;
    // A background command that still runs will move the work too (Orchestration 6.4).
    if (runningJobs(this.#records, workflowRunId).length > 0) return false;
    const highest = [...sleeping].sort((a, b) => a.mission.depth - b.mission.depth)[0];
    if (highest === undefined) return false;
    const stalls = this.#records.filter(
      (record) =>
        record.type === 'MISSION_WOKEN' &&
        record.missionId === highest.mission.missionId &&
        record.causes.some((cause) => cause.kind === 'STALLED'),
    ).length;
    if (stalls >= MAX_STALLED_WAKES) {
      // Woken again and again with nothing to wait for: it ends, so whoever waits for it can go on.
      await this.#closeSleeping(workflowRunId, highest.node, 'FAILED');
      return true;
    }
    await this.#continueMission(workflowRunId, highest.node, [{ kind: 'STALLED' }]);
    return true;
  }

  /** A question or an open input that waits for the user: the run is not stuck while it waits. */
  #waitingForHuman(workflowRunId: string): boolean {
    const projected = projectGraph(this.#records, workflowRunId);
    return [...projected.nodes.values()].some(
      (node) => node.kind === 'HUMAN' && projected.view.get(node.nodeId)?.status === 'RUNNING',
    );
  }

  /** The segment that takes over a sleeping task, with why it woke. */
  async #continueMission(
    workflowRunId: string,
    yielded: GraphNodeRecord,
    causes: Extract<SessionLogRecord, { type: 'MISSION_WOKEN' }>['causes'],
  ): Promise<void> {
    const missionId = yielded.mission?.id;
    if (missionId === undefined) throw new Error('a segment that slept belongs to no task');
    const turn = this.#turnId === undefined ? {} : { turnId: this.#turnId };
    await this.#append([
      { type: 'MISSION_WOKEN', workflowRunId, ...turn, missionId, causes: [...causes] },
    ]);
    const revision = projectGraph(this.#records, workflowRunId).lastRevision + 1;
    await this.#extend(
      workflowRunId,
      revision,
      'WAKE',
      continuationRevision(workflowRunId, revision, yielded),
    );
  }

  /**
   * A sleeping task that cannot go on (the run is interrupted, or it stalled): a segment takes over
   * and ends at once, with no AgentRun, so the task and whatever waits for it come to an end.
   */
  async #closeSleeping(
    workflowRunId: string,
    yielded: GraphNodeRecord,
    status: 'FAILED' | 'INTERRUPTED',
    note?: string,
  ): Promise<void> {
    const revision = projectGraph(this.#records, workflowRunId).lastRevision + 1;
    const content = continuationRevision(workflowRunId, revision, yielded);
    await this.#extend(workflowRunId, revision, 'WAKE', content);
    const node = content.nodes[0];
    if (node === undefined) throw new Error('a continuation makes one node');
    const turn = this.#turnId === undefined ? {} : { turnId: this.#turnId };
    await this.#append([
      { type: 'NODE_STARTED', workflowRunId, ...turn, nodeId: node.nodeId, path: node.path },
      {
        type: 'NODE_ENDED',
        workflowRunId,
        ...turn,
        nodeId: node.nodeId,
        status,
        ...(yielded.mission?.parentId === undefined
          ? {}
          : {
              result: resultOf({
                status: 'FAILED',
                notes: [
                  note ??
                    (status === 'INTERRUPTED'
                      ? 'stopped: the run was interrupted while it slept'
                      : 'stopped: it slept with nothing left that could wake it'),
                ],
              }),
            }),
      },
    ]);
  }
}
