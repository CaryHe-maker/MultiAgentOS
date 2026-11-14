import {
  approvalDigestOf,
  isProjectInstructionPath,
  newId,
  normalizeRequestPath,
  writableRoots,
  writeRootsOverlap,
  writeRootsWithin,
  type CommandInput,
  type JobEndedFact,
  type HaltAgentRunRequest,
  type RestoreMissionRequest,
  type CloseMissionRequest,
  type TakeCheckpointRequest,
  type WebFetchInput,
  type WebSearchInput,
  type DelegationReserved,
  type ReleaseDelegationRequest,
  type RetainArtifactsRequest,
  type ScheduleWakeRequest,
  type ReserveDelegationRequest,
  type SandboxProfile,
} from '@multiagentos/contracts';
import type {
  AckCompactionRequest,
  AnswerAuthorizationRequest,
  ArtifactRef,
  AuthorizationRequest,
  AuthorizationResolved,
  CloseReason,
  CompactionFailed,
  CompactionTarget,
  ContextCompacted,
  CoreRejectedCode,
  ExternalReadPaused,
  EndAgentRunRequest,
  ExecutionScope,
  InterruptReason,
  KernelToWorkflowEvent,
  MemoryLevel,
  ProjectFileContent,
  ReadProjectFileRequest,
  RegisterAgentRunRequest,
  ReportCompactionSourceRequest,
  RunSummary,
  SubmitUnitRequest,
  SyscallAck,
  SyscallRejected,
  InputUsage,
  UnitDefinition,
  UnitReport,
  UnknownEffect,
  UpdateActivityRequest,
} from '@multiagentos/contracts';
import { homedir } from 'node:os';
import { resolveExternal, type ExternalResolution, type ExternalSupport } from './external-read.js';
import { RequestLedger } from './request-ledger.js';
import type { Compacting } from './run-compactor.js';
import type { CompactionConfig } from './run-compaction.js';
import type { AssemblyInfo } from './run-execution.js';
import type { SchedulerDuties } from '../interfaces/index.js';
import { minShare, type RunLedgers } from '../monitor/index.js';
import type { AgentShare } from './pinned-agent.js';
import { RunDelegations } from './run-delegations.js';
import {
  RunAttempts,
  type AttemptAudit,
  type AttemptFault,
  type AttemptSpec,
  type PinnedAgent,
} from './run-attempts.js';
import { RunActivity, type ActivityOutput } from './run-activity.js';
import { RunAuthorization, type QuestionResolved } from './run-authorization.js';
import { admitWork, readsProjectFile, type Decision, type RunControl } from './run-control.js';
import { admitUnit } from './unit-admission.js';
import {
  ceilingOf,
  type CapabilityCeiling,
  type CommandAnalysis,
  type CommandDemand,
  type UnitDecision,
  type UnitDemand,
} from './unit-decision.js';
import type { RetryingActivity } from './run-execution.js';
import { WallClocks } from './wall-clocks.js';

export type PinResult =
  | { readonly ok: true; readonly agent: PinnedAgent }
  | {
      readonly ok: false;
      readonly reasonCode: Extract<
        CoreRejectedCode,
        'DEFINITION_UNAVAILABLE' | 'DEFINITION_MISMATCH' | 'FORBIDDEN'
      >;
    };

/** The run as the Session actor owns it: control state, ordering and the Outbox stay there. */
export interface RunHost {
  readonly workflowRunId: string;
  control(): RunControl;
  closeReason(): CloseReason | undefined;
  runEpoch(): number;
  registerAgentRun(agentRunId: string): Decision;
  endAgentRun(agentRunId: string, keepsQuestions?: boolean): Decision;
  attemptStarted(unitAttemptId: string): void;
  attemptEnded(unitAttemptId: string): void;
  toWorkflow(report: UnitReport): void;
  toInteraction(
    event:
      | AuthorizationRequest
      | AuthorizationResolved
      | ActivityOutput
      | ContextCompacted
      | CompactionFailed
      | ExternalReadPaused,
  ): void;
  /** An event of the run to Workflow other than a report (the compaction's). */
  toWorkflowEvent(event: KernelToWorkflowEvent): void;
  fault(fault: AttemptFault): void;
  /** Runs `work` as a control message of the actor; timers only do this. */
  enqueue(work: () => void | Promise<void>): void;
  /** The system pauses the run (Kernel/Core 5h); nothing happens when it is not running. */
  requestPause(): void;
}

/** What running commands needs from outside Core (Kernel/Core 5b); absent, no command runs. */
export interface CommandSupport {
  /** The line analysed with the lists applied; `text` is the line as the model wrote it. */
  readonly analyze: (command: string) => CommandAnalysis;
  /** What the probe at the start of the Session found. */
  readonly sandbox: () => 'AVAILABLE' | 'UNAVAILABLE';
  readonly unavailablePolicy: 'deny' | 'ask-unisolated';
  /** `kernel.command.approval`: whether a safe command runs without a question (M2Design 5.2). */
  readonly approval?: 'ask' | 'auto';
  readonly homeReadOnly: readonly string[];
  readonly homeMaskedFiles: readonly string[];
  /** Hidden from commands when it lies outside the home directory (M2Design 6.1). */
  readonly dataDir?: string;
  /** The files to mask and the protected paths that exist, found by looking at the repository. */
  readonly scan: () => Promise<
    Pick<SandboxProfile, 'maskedFiles' | 'maskedDirs' | 'protectedExisting'>
  >;
}

export interface RunWorkDeps {
  /**
   * The compaction of this run's contexts and its thresholds (M2Design 9.6); absent: nothing is
   * ever compacted, and a context that outgrows its window ends the way it does without compaction.
   */
  readonly compactor?: Compacting;
  readonly compaction?: CompactionConfig;
  readonly command?: CommandSupport;
  /** The sites the user forbade, and who receives a search (`KernelConfig.web`, Core 5f). */
  readonly web?: { readonly deniedDomains: readonly string[]; readonly searchProvider: string };
  /** What the checks of an external read need to know of the machine (Core 5h). */
  readonly external?: ExternalSupport;
  readonly host: RunHost;
  readonly ledgers: RunLedgers;
  readonly scheduler: SchedulerDuties;
  readonly provider: string;
  readonly technicalRetryLimit: number;
  readonly repositoryRoot: string;
  readonly repositoryExclusions: readonly string[];
  readonly pinAgent: (request: RegisterAgentRunRequest) => Promise<PinResult>;
  /** The Agent a compaction is made as, by reference; none means main (`compactionAgentFrom`). */
  readonly compactionAgent: (ref?: {
    readonly id: string;
    readonly version: string;
  }) => PinnedAgent | undefined;
  /** The share and the budget of an Agent a task names; absent: nothing can be delegated. */
  readonly agentShare?: (
    ref: ReserveDelegationRequest['tasks'][number]['agentRef'],
    context: { readonly sessionId: string; readonly workflowRunId: string },
  ) => AgentShare;
  readonly newDelegationId?: () => string;
  readonly inputIsValid: (unit: UnitDefinition, input: unknown) => boolean;
  readonly preset: 'standard' | 'readonly';
  readonly readProjectFile: (path: string, scope: ExecutionScope) => Promise<ProjectFileRead>;
  readonly isTrusted: (path: string, sha256: string) => boolean;
  readonly trust: (path: string, sha256: string) => Promise<void>;
  /** The user allowed the web search for this folder from now on (Kernel/Core 5f). */
  readonly webSearchTrusted: () => boolean;
  readonly trustWebSearch: () => Promise<void>;
  /** Keeps these for the whole Session; false when one of them is not the Session's (Core 5g). */
  readonly retainArtifacts: (refs: readonly ArtifactRef[]) => Promise<boolean>;
  /** Keeps what a critical question shows; the question then only refers to it. */
  readonly storeQuestionContent: (text: string) => Promise<ArtifactRef>;
  /** Execution takes the attempt over and registers it through `attempts`. */
  readonly createAttempt: (spec: AttemptSpec, attempts: RunAttempts) => Promise<string>;
  /** Stops what is queued or running; every attempt still ends through `attempts`. */
  readonly cancelExecutions: (runEpoch: number) => void;
  /** PAUSING (Kernel/Execution 4e): `drained` is called when nothing is executing any more. */
  readonly pauseExecutions: (drained: () => void) => void;
  readonly resumeExecutions: () => Promise<void>;
  /** An interrupt cancels everything that exists now; each attempt answers INTERRUPTED(ABORTED). */
  readonly abortExecutions: () => void;
  /** A checkpoint's snapshot (Orchestration 7.1); absent: none can be taken. */
  readonly checkpoint?: (
    checkpointId: string,
    kind: TakeCheckpointRequest['kind'],
    label: string,
  ) => Promise<string | undefined>;
  /** The barrier of a checkpoint: hold writes and foreground commands (Orchestration 7.3). */
  readonly holdMutating?: (clear: () => void) => void;
  readonly releaseMutating?: () => void;
  readonly heldMutating?: () => string[];
  /** The longest a checkpoint waits for work in flight before it is given up. */
  readonly checkpointBarrierMs?: number;
  /** The same for the attempts of one AgentRun, whose task was stopped or interrupted. */
  readonly abortAgentRunExecutions?: (agentRunId: string) => void;
  readonly executionsClosed: () => void;
  /** Offers the call slots given back to the attempts that wait for one (M2Design 7.2). */
  readonly drainCapacityWaiters?: () => Promise<void>;
  readonly unknownEffects: () => UnknownEffect[];
  readonly audit: (entry: AttemptAudit) => void;
  readonly now: () => Date;
  readonly schedule: (delayMs: number, due: () => void) => () => void;
  /** The live memory level; a WARNING ends when it says the pressure is gone. */
  readonly memoryLevel?: () => MemoryLevel | undefined;
  /** The deepest level of the MissionTree; 2 means three levels (Orchestration 3.6). */
  readonly maxMissionDepth?: number;
  /**
   * What to do when the work of an input is about to run out of its budget while the run has
   * tokens left (M2Design 7.3, rule 6); `ask`, 4 times, when absent.
   */
  readonly budgetExtension?: { readonly mode: 'ask' | 'extend' | 'stop'; readonly max: number };
}

type Response = SyscallAck | SyscallRejected;
type Decided =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reasonCode: CoreRejectedCode | 'RUN_BLOCKED' };
type FileResponse = ProjectFileContent | SyscallRejected;

/** What Execution read; `truncated` says a question shows only the head of the file. */
export type ProjectFileRead =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly ref: ArtifactRef;
      readonly sha256: string;
      readonly text: string;
      readonly truncated: boolean;
    };

/** The delegation and task that fund the first segment of a spawned task. */
interface Funding {
  readonly delegationId: string;
  readonly taskName: string;
}

/**
 * One task of the run and its MissionScope (Orchestration 8.1): what every segment of it may do at
 * most, where it writes, who its parent is and whether a segment of it runs now. It stays open
 * while the task sleeps, so its write roots stay held and its ledger is kept.
 */
interface MissionRecord {
  readonly parent?: string;
  readonly depth: number;
  /** The ceiling of its first segment; a later segment may only narrow it. */
  readonly ceiling: CapabilityCeiling;
  readonly roots: readonly string[];
  /** Funded by a delegation: its share is its own ledger (M2Design 7.3). */
  readonly funded: boolean;
  active?: string | undefined;
  closed: boolean;
}

/** Where a registration goes: a task that exists, or a new one under a parent or as a root. */
type Placement =
  | {
      readonly ok: true;
      readonly missionId: string;
      readonly existing?: MissionRecord;
      readonly parentId?: string;
      readonly parent?: MissionRecord;
      readonly funding?: Funding;
    }
  | { readonly ok: false; readonly reasonCode: CoreRejectedCode };

interface AgentRunRecord {
  /** The parent task of its task; absent for a segment of a root task. */
  readonly parent?: string;
  readonly mission: string;
  readonly agent: PinnedAgent;
  readonly ceiling: CapabilityCeiling;
  state: 'ACTIVE' | 'ENDED';
  /** For the RunSummary. */
  readonly agentRef: RegisterAgentRunRequest['agentRef'];
  readonly registeredAt: string;
  endedAt?: string;
  rounds: number;
}

/** How a run ended, as the RunSummary repeats it. */
export type RunEnding = Pick<RunSummary, 'closeReason' | 'unknownEffects' | 'resultRef'> & {
  readonly failure?: Extract<RunSummary, { failure: unknown }>['failure'];
};

/** A request parked on a question: first `repo.read`, then trust in the exact content. */
interface WaitingFile {
  readonly request: ReadProjectFileRequest;
  readonly done: (response: FileResponse) => void;
  read?: Extract<ProjectFileRead, { exists: true }>;
}

interface WaitingUnit {
  readonly request: SubmitUnitRequest;
  readonly unit: UnitDefinition;
  readonly record: AgentRunRecord;
}

/** What a write shows when it asks; an edit has no whole new content yet (ExecutorSet 5b). */
function shownContent(input: SubmitUnitRequest['input']): string {
  if ('content' in input) return input.content;
  if ('oldString' in input) return `--- replaces\n${input.oldString}\n+++ with\n${input.newString}`;
  throw new Error('A write has neither content nor an edit');
}

const pathOf = (input: SubmitUnitRequest['input']): string | undefined =>
  'path' in input && typeof input.path === 'string' ? input.path : undefined;

/** The input an executor gets for an external read: the path is the one below the allowed folder. */
function externalInput(
  input: SubmitUnitRequest['input'],
  external: Extract<ExternalResolution, { readonly ok: true }>,
): SubmitUnitRequest['input'] {
  const rest: Record<string, unknown> = { ...input };
  delete rest['path'];
  return external.path === '' ? rest : { ...rest, path: external.path };
}

/**
 * The Unit path of one run (Kernel/Interaction 7): request records, AgentRuns, admission, quotas,
 * authorization and attempts. Every method runs inside one message of the Session actor.
 */
export class RunWork {
  readonly #deps: RunWorkDeps;
  readonly #host: RunHost;
  readonly #requests = new RequestLedger();
  readonly #agentRuns = new Map<string, AgentRunRecord>();
  /** The checkpoint of the input whose work goes on (Orchestration 7.1). */
  #openInputId: string | undefined;
  /** One checkpoint at a time; another asked for meanwhile is skipped. */
  #checkpointing = false;
  /** The tasks of this run, by id (Orchestration 8.1). */
  readonly #missions = new Map<string, MissionRecord>();
  readonly #delegations = new RunDelegations();
  readonly #waiting = new Map<string, WaitingUnit>();
  readonly #waitingFiles = new Map<string, WaitingFile>();
  readonly #inFlight = new Map<string, number>();
  readonly #authorization: RunAuthorization;
  readonly #clocks: WallClocks;
  readonly #attempts: RunAttempts;
  readonly #activity: RunActivity;
  readonly #startedAt: string;
  /** AgentRuns that had an automatic compaction in the round they are in: at most one (9.6). */
  readonly #compactedInRound = new Set<string>();
  /** How many times in a row the provider refused the context of an AgentRun for its size. */
  readonly #overflows = new Map<string, number>();
  /** Memory is short (Kernel/Core 5c): no new AgentRun, and the tools of running ones stop. */
  #memoryWarning = false;
  /** Ends the Kernel's wait for Workflow to close an interrupted run (Kernel/Core 5e). */
  #cancelBackstop: (() => void) | undefined;
  /** The cancels of the wake timers still armed: they end with the run (Orchestration 8.5). */
  readonly #wakeTimers = new Set<() => void>();
  /** The path each external read of this run asked for, until its report is counted. */
  readonly #externalAsks = new Map<string, string>();
  /** How often the input's budget was added to, and whether the user refused to (rule 6). */
  #budgetExtensions = 0;
  #budgetDeclined = false;
  /** What the open question about the budget would add. */
  #budgetOffer = 0;
  /** The failed external reads since the last success or pause: two pause the run (Core 5h). */
  #externalFailures: ExternalReadPaused['attempts'][number][] = [];
  #inputs = 0;
  #modelRequests = 0;
  readonly #units = { submitted: 0, ok: 0, rejected: 0, failed: 0 };

  public constructor(deps: RunWorkDeps) {
    this.#deps = deps;
    const { host } = deps;
    this.#host = host;
    this.#startedAt = deps.now().toISOString();
    this.#authorization = new RunAuthorization({
      repositoryRoot: deps.repositoryRoot,
      provider: deps.provider,
      repositoryExclusions: deps.repositoryExclusions,
      webSearchTrusted: deps.webSearchTrusted(),
      now: deps.now,
    });
    const activity = new RunActivity({ emit: (event) => host.toInteraction(event), now: deps.now });
    this.#activity = activity;
    this.#clocks = new WallClocks({
      now: () => deps.now().getTime(),
      schedule: deps.schedule,
      due: () => {
        host.enqueue(() => {
          for (const agentRunId of this.#clocks.takeExpired())
            deps.ledgers.wallClockExceeded(agentRunId);
        });
      },
    });
    const closing = () => {
      const { phase } = host.control();
      return phase === 'CONVERGING' || phase === 'CLOSED';
    };
    this.#attempts = new RunAttempts({
      provider: deps.provider,
      technicalRetryLimit: deps.technicalRetryLimit,
      ledger: deps.ledgers,
      scheduler: deps.scheduler,
      createAttempt: (spec) => deps.createAttempt(spec, this.#attempts),
      isDeliverable: (runEpoch) => !closing() && runEpoch === host.runEpoch(),
      isConverging: closing,
      leaseIsValid: () => this.#authorization.lease !== undefined,
      deliver: (report, spec) => {
        host.toWorkflow(report);
        activity.reported(spec, report);
        this.#counted(report);
      },
      attemptStarted: (spec, unitAttemptId) => {
        this.#countInFlight(spec.agentRunId, 1);
        host.attemptStarted(unitAttemptId);
        activity.queued(spec, unitAttemptId);
      },
      attemptRunning: (spec, unitAttemptId, final) => {
        if (spec.unit.executionKind === 'MODEL') this.#modelRequests += 1;
        activity.running(spec, unitAttemptId, final);
      },
      attemptEnded: (spec, unitAttemptId) => {
        this.#countInFlight(spec.agentRunId, -1);
        this.#authorization.attemptEnded(spec.requestId);
        host.attemptEnded(unitAttemptId);
      },
      onFault: (fault) => {
        host.fault(fault);
      },
      audit: deps.audit,
    });
  }

  /** Execution reports back through this object. */
  get attempts(): RunAttempts {
    return this.#attempts;
  }

  #countInFlight(agentRunId: string, change: number): void {
    this.#inFlight.set(agentRunId, (this.#inFlight.get(agentRunId) ?? 0) + change);
  }

  /** At the end of every message of the actor: the slots given back go to those who wait. */
  async drainCapacityWaiters(): Promise<void> {
    await this.#deps.drainCapacityWaiters?.();
  }

  setMemoryWarning(): void {
    this.#memoryWarning = true;
  }

  /**
   * New work is refused while this process is short of memory. The live level decides, so a
   * new input after an interrupt is refused with the reason while the pressure lasts and accepted as
   * soon as it has fallen; without a live level the message that raised the warning decides.
   */
  #underWarning(): boolean {
    if (this.#interruptRefusal() !== undefined) return true;
    if (this.#deps.memoryLevel !== undefined) return this.#deps.memoryLevel() !== undefined;
    return this.#memoryWarning;
  }

  /**
   * What an interrupted run says to the Units it refuses: the memory is the reason when it is
   * (Kernel/Core 5c), and any other interrupt just blocks (Kernel/Core 5e). Only the closing reply
   * may still be published.
   */
  #interruptRefusal(): 'MEMORY_PRESSURE' | 'RUN_BLOCKED' | undefined {
    const { phase, interrupt } = this.#host.control();
    if (phase !== 'INTERRUPTING') return undefined;
    return interrupt === 'MEMORY_PRESSURE' ? 'MEMORY_PRESSURE' : 'RUN_BLOCKED';
  }

  /** A run that goes on after the process stopped spent this much before (Orchestration 7.6). */
  chargeEarlier(tokens: number): void {
    this.#deps.ledgers.chargeEarlier(tokens);
  }

  /** Whether the work of an input was ever opened in this run. */
  hadInput(): boolean {
    return this.#inputs > 0;
  }

  /** The work of an input opens, named by its checkpoint: it gets its share of the budget. */
  openInput(checkpointId: string): void {
    this.#inputs += 1;
    this.#openInputId = checkpointId;
    this.#deps.ledgers.openInputLedger(checkpointId);
  }

  #insideRepository(path: string): boolean {
    const root = this.#deps.repositoryRoot.replace(/[\\/]+$/u, '');
    const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path);
    return (
      path !== '' &&
      (!absolute || path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
    );
  }

  /** Kernel/Core 5h: two failures in a row of reading outside the workspace pause the run. */
  #externalOutcome(report: UnitReport): void {
    const path = this.#externalAsks.get(report.requestId);
    if (path === undefined) return;
    this.#externalAsks.delete(report.requestId);
    if (report.status === 'INTERRUPTED') return;
    if (report.status === 'OK') {
      this.#externalFailures = [];
      return;
    }
    // A path that is relative or lies inside the repository is no guess at the machine: the
    // tool's refusal already says to use read_file, and the run is not stopped for the user.
    if (this.#insideRepository(path)) return;
    const code = 'reasonCode' in report ? report.reasonCode : undefined;
    this.#externalFailures.push({
      path,
      reason:
        code === 'EXTERNAL_PATH_UNAVAILABLE'
          ? 'UNAVAILABLE'
          : code === 'USER_DECLINED'
            ? 'DECLINED'
            : 'FAILED',
    });
    if (this.#externalFailures.length < 2) return;
    // What the Agent tried goes to the user, and the counting starts over for what comes after.
    const attempts = this.#externalFailures.slice(-8);
    this.#externalFailures = [];
    this.#host.toInteraction({ type: 'ExternalReadPaused', attempts });
    this.#host.requestPause();
  }

  #counted(report: UnitReport): void {
    this.#externalOutcome(report);
    if (report.status === 'OK') this.#units.ok += 1;
    else if (report.status === 'REJECTED') this.#units.rejected += 1;
    else this.#units.failed += 1;
    const record = this.#agentRuns.get(report.agentRunId);
    if (record !== undefined && report.executionKind === 'MODEL' && report.status !== 'REJECTED')
      record.rounds += 1;
  }

  /** The run record of Execution (RunSummary), once the run closed and its last input settled. */
  summary(ids: { readonly sessionId: string }, ending: RunEnding): RunSummary {
    const closedAt = this.#deps.now();
    const delivered = this.#units.ok + this.#units.rejected + this.#units.failed;
    return {
      workflowRunId: this.#host.workflowRunId,
      sessionId: ids.sessionId,
      startedAt: this.#startedAt,
      closedAt: closedAt.toISOString(),
      durationMs: Math.max(0, closedAt.getTime() - Date.parse(this.#startedAt)),
      inputs: this.#inputs,
      agentRuns: [...this.#agentRuns].map(([agentRunId, record]) => ({
        agentRunId,
        agentRef: record.agentRef,
        registeredAt: record.registeredAt,
        ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
        rounds: record.rounds,
        finalCallUsed: this.#attempts.usedFinalCall(agentRunId),
      })),
      units: { ...this.#units, notDelivered: this.#units.submitted - delivered },
      model: { requests: this.#modelRequests },
      tokens: this.#deps.ledgers.usage(),
      ...ending,
    } as RunSummary;
  }

  /** The work of an input settled: what it used, and what is left goes back to the run. */
  settleInput(checkpointId: string): InputUsage {
    return this.#deps.ledgers.closeInputLedger(checkpointId);
  }

  #refuse(
    requestId: string,
    payload: unknown,
    reasonCode: CoreRejectedCode | 'RUN_BLOCKED',
  ): Response {
    let response: SyscallRejected;
    if (reasonCode === 'RUN_BLOCKED') {
      // A run that is interrupted is blocked for that reason, though it may stay open (Core 5e).
      const closeReason =
        this.#host.closeReason() ??
        (this.#host.control().phase === 'INTERRUPTING' ? 'INTERRUPTED' : undefined);
      if (closeReason === undefined) throw new Error('RUN_BLOCKED requires closeReason');
      response = { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode, closeReason };
    } else response = { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode };
    this.#requests.remember(requestId, payload, response);
    return response;
  }

  #accept(requestId: string, payload: unknown): Response {
    const response: SyscallAck = { requestId, outcome: 'ACCEPTED' };
    this.#requests.remember(requestId, payload, response);
    return response;
  }

  /** The answer to a request seen before; the same requestId with other content conflicts. */
  #replay(requestId: string, payload: unknown): Response | undefined {
    const found = this.#requests.lookup<Response>(requestId, payload);
    if (found.kind === 'replay') return found.response;
    if (found.kind === 'conflict')
      return { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode: 'REQUEST_CONFLICT' };
    return undefined;
  }

  /** Idempotency for a request whose decision lives in the actor. */
  async once(
    requestId: string,
    payload: unknown,
    decide: () => Promise<Decided> | Decided,
  ): Promise<Response> {
    const replay = this.#replay(requestId, payload);
    if (replay !== undefined) return replay;
    const decision = await decide();
    return decision.accepted
      ? this.#accept(requestId, payload)
      : this.#refuse(requestId, payload, decision.reasonCode);
  }

  /**
   * Where a registration goes (Orchestration 8.1). A request that names its task registers a
   * segment of it: the task's next segment if it exists, or its first under its parent; the first
   * segment of a spawned task also names the delegation and task that fund it. A request without a
   * task is a task of its own, with the SubAgent fields of M2Design 6.4: a parent AgentRun that
   * runs, the delegation and the task, all three or none. Only one root task runs at a time.
   */
  #placement(request: RegisterAgentRunRequest): Placement {
    const { parentAgentRunId, delegationId, taskName, mission } = request;
    const fundingGiven = [delegationId, taskName].filter((each) => each !== undefined).length;
    const funding =
      delegationId !== undefined && taskName !== undefined ? { delegationId, taskName } : undefined;
    if (mission === undefined) {
      const given = [parentAgentRunId, delegationId, taskName].filter((each) => each !== undefined);
      if (given.length !== 0 && given.length !== 3)
        return { ok: false, reasonCode: 'INVALID_INPUT' };
      if (parentAgentRunId === undefined || funding === undefined)
        return this.#rootTaken()
          ? { ok: false, reasonCode: 'AGENT_RUN_ACTIVE' }
          : { ok: true, missionId: request.agentRunId };
      const parentRun = this.#agentRuns.get(parentAgentRunId);
      if (parentRun === undefined) return { ok: false, reasonCode: 'AGENT_RUN_NOT_FOUND' };
      if (parentRun.state === 'ENDED') return { ok: false, reasonCode: 'AGENT_RUN_ENDED' };
      const parent = this.#missions.get(parentRun.mission);
      if (parent === undefined || parent.closed)
        return { ok: false, reasonCode: 'AGENT_RUN_ENDED' };
      return {
        ok: true,
        missionId: request.agentRunId,
        parentId: parentRun.mission,
        parent,
        funding,
      };
    }
    if (fundingGiven === 1) return { ok: false, reasonCode: 'INVALID_INPUT' };
    const { missionId, parentMissionId } = mission;
    const existing = this.#missions.get(missionId);
    if (existing !== undefined) {
      if (existing.closed) return { ok: false, reasonCode: 'MISSION_CLOSED' };
      if (existing.active !== undefined) return { ok: false, reasonCode: 'MISSION_BUSY' };
      if (existing.parent !== parentMissionId || funding !== undefined)
        return { ok: false, reasonCode: 'INVALID_INPUT' };
      return { ok: true, missionId, existing };
    }
    if (parentMissionId === undefined) {
      if (funding !== undefined) return { ok: false, reasonCode: 'INVALID_INPUT' };
      return this.#rootTaken()
        ? { ok: false, reasonCode: 'AGENT_RUN_ACTIVE' }
        : { ok: true, missionId };
    }
    const parent = this.#missions.get(parentMissionId);
    if (parent === undefined || parent.closed)
      return { ok: false, reasonCode: 'MISSION_NOT_FOUND' };
    return {
      ok: true,
      missionId,
      parentId: parentMissionId,
      parent,
      ...(funding === undefined ? {} : { funding }),
    };
  }

  /** A root task has a segment that runs: a second root may not start (M2Design 2.3). */
  #rootTaken(): boolean {
    return [...this.#missions.values()].some(
      (each) => each.parent === undefined && each.active !== undefined,
    );
  }

  /**
   * A new task can do no more than its parent and writes only where its task may; it may spawn only
   * above the deepest level (Orchestration 3.6). A later segment can do no more than the first.
   */
  #ceilingRefusal(
    placed: Extract<Placement, { ok: true }>,
    ceiling: CapabilityCeiling,
    roots: readonly string[],
  ): CoreRejectedCode | undefined {
    const { existing, parent, parentId, funding } = placed;
    if (existing !== undefined) {
      const beyond = [...ceiling.capabilities].some(
        (capability) => !existing.ceiling.capabilities.has(capability),
      );
      return beyond || !writeRootsWithin(roots, existing.roots)
        ? 'CAPABILITY_NOT_SUBSET'
        : undefined;
    }
    if (parent === undefined || parentId === undefined) return undefined;
    let allowed = parent.roots;
    if (funding !== undefined) {
      const task = this.#delegations.openTask(funding.delegationId, parentId, funding.taskName);
      if (task === undefined) return 'DELEGATION_NOT_FOUND';
      allowed = task.roots;
    }
    const mayNotSpawn = parent.depth + 1 >= this.#maxMissionDepth();
    const beyond = [...ceiling.capabilities].some(
      (capability) =>
        (capability === 'agent.spawn' && mayNotSpawn) ||
        !parent.ceiling.capabilities.has(capability),
    );
    return beyond || !writeRootsWithin(roots, allowed) ? 'CAPABILITY_NOT_SUBSET' : undefined;
  }

  #maxMissionDepth(): number {
    return this.#deps.maxMissionDepth ?? 2;
  }

  /** The tasks above `missionId` and itself, nearest first. */
  #ancestorsOf(missionId: string | undefined): string[] {
    const found: string[] = [];
    let next = missionId;
    while (next !== undefined && !found.includes(next)) {
      found.push(next);
      next = this.#missions.get(next)?.parent;
    }
    return found;
  }

  /**
   * Open tasks write apart from each other, a sleeping one too (Orchestration 8.2): a new task may
   * not touch the roots of any open task that is not above it.
   */
  #writeConflict(
    missionId: string,
    parentId: string | undefined,
    roots: readonly string[],
  ): boolean {
    if (roots.length === 0) return false;
    const above = this.#ancestorsOf(parentId);
    return [...this.#missions].some(
      ([id, each]) =>
        id !== missionId &&
        !each.closed &&
        !above.includes(id) &&
        each.roots.length > 0 &&
        writeRootsOverlap(each.roots, roots),
    );
  }

  async registerAgentRun(request: RegisterAgentRunRequest): Promise<Response> {
    const { requestId, agentRunId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const admitted = admitWork(this.#host.control());
    if (!admitted.accepted) return this.#refuse(requestId, request, admitted.reasonCode);
    if (this.#agentRuns.has(agentRunId))
      return this.#refuse(requestId, request, 'AGENT_RUN_EXISTS');
    const interrupted = this.#interruptRefusal();
    if (interrupted !== undefined) return this.#refuse(requestId, request, interrupted);
    if (this.#underWarning()) return this.#refuse(requestId, request, 'MEMORY_PRESSURE');
    const placed = this.#placement(request);
    if (!placed.ok) return this.#refuse(requestId, request, placed.reasonCode);
    const { missionId, existing, parentId, parent, funding } = placed;

    const pinned = await this.#deps.pinAgent(request);
    if (!pinned.ok) return this.#refuse(requestId, request, pinned.reasonCode);
    const ceiling = ceilingOf({
      agentCapabilities: pinned.agent.capabilities,
      requestedCapabilities: request.requestedCapabilities,
      writeRoots: request.writeRoots,
      preset: this.#deps.preset,
      exclusions: this.#authorization.exclusions,
    });
    if (!ceiling.ok) return this.#refuse(requestId, request, ceiling.reasonCode);
    const roots = writableRoots(ceiling.ceiling);
    const refusal = this.#ceilingRefusal(placed, ceiling.ceiling, roots);
    if (refusal !== undefined) return this.#refuse(requestId, request, refusal);
    if (existing === undefined && this.#writeConflict(missionId, parentId, roots))
      return this.#refuse(requestId, request, 'WRITE_SCOPE_CONFLICT');
    const registered = this.#host.registerAgentRun(agentRunId);
    if (!registered.accepted) return this.#refuse(requestId, request, registered.reasonCode);
    // A funded task spends its own share, every segment of it; every other one spends the input's.
    const mission: MissionRecord = existing ?? {
      ...(parentId === undefined ? {} : { parent: parentId }),
      depth: parent === undefined ? 0 : parent.depth + 1,
      ceiling: ceiling.ceiling,
      roots,
      funded: funding !== undefined,
      closed: false,
    };
    if (existing === undefined) {
      this.#missions.set(missionId, mission);
      if (funding !== undefined && parentId !== undefined) {
        this.#delegations.claim(funding.delegationId, funding.taskName, missionId);
        this.#deps.ledgers.registerAgentRun({
          agentRunId,
          delegationId: funding.delegationId,
          taskName: funding.taskName,
          agent: pinned.agent.budget,
          ledgerKey: missionId,
        });
      }
    } else if (existing.funded) this.#deps.ledgers.attachAgentRun(agentRunId, missionId);
    mission.active = agentRunId;
    this.#agentRuns.set(agentRunId, {
      ...(mission.parent === undefined ? {} : { parent: mission.parent }),
      mission: missionId,
      agent: pinned.agent,
      ceiling: ceiling.ceiling,
      state: 'ACTIVE',
      agentRef: request.agentRef,
      registeredAt: this.#deps.now().toISOString(),
      rounds: 0,
    });
    // The activity tree hangs a segment below the segment of its parent task that runs now.
    const shownParent =
      mission.parent === undefined ? undefined : this.#missions.get(mission.parent)?.active;
    // Only a real task is told: without one, the AgentRun stands for its own task (Core 5a).
    this.#activity.registered(
      agentRunId,
      request.display.label,
      shownParent,
      request.mission === undefined
        ? undefined
        : {
            missionId,
            ...(mission.parent === undefined ? {} : { parentMissionId: mission.parent }),
          },
    );
    this.#clocks.register(agentRunId, pinned.agent.maxWallClockMs);
    return this.#accept(requestId, request);
  }

  endAgentRun(request: EndAgentRunRequest): Response {
    const { requestId, agentRunId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const { phase } = this.#host.control();
    if (phase === 'CONVERGING' || phase === 'CLOSED') return this.#accept(requestId, request);
    const record = this.#agentRuns.get(agentRunId);
    if (record === undefined) return this.#refuse(requestId, request, 'AGENT_RUN_NOT_FOUND');
    if (record.state === 'ENDED') return this.#refuse(requestId, request, 'AGENT_RUN_ENDED');
    record.state = 'ENDED';
    record.endedAt = this.#deps.now().toISOString();
    this.#clocks.end(agentRunId);
    const mission = this.#missions.get(record.mission);
    const continues = request.missionContinues === true;
    // A task that sleeps keeps its line in the activity area; one that ends loses it.
    if (continues) this.#activity.sleeping(agentRunId);
    else this.#activity.ended(agentRunId);
    if (mission !== undefined) {
      mission.active = undefined;
      if (!continues) mission.closed = true;
    }
    // A segment that went to wait keeps its task's ledger; when the task ends, the unused part of
    // its share goes back to its parent at once (M2Design 7.3, rule 4).
    this.#deps.ledgers.endAgentRun(agentRunId, continues);
    if (!continues) this.#delegations.childEnded(record.mission);
    const ended = this.#host.endAgentRun(agentRunId, continues && request.keepsQuestions === true);
    if (!ended.accepted) return this.#refuse(requestId, request, ended.reasonCode);
    return this.#accept(requestId, request);
  }

  /**
   * Takes the shares of all the tasks of a `run_subagents` call out of the parent's ledger, or none
   * (M2Design 3.6, 7.3). The parent holds no write roots from now until its children have ended.
   */
  reserveDelegation(request: ReserveDelegationRequest): DelegationReserved | SyscallRejected {
    const { requestId, parentAgentRunId } = request;
    const refuse = (reasonCode: CoreRejectedCode | 'RUN_BLOCKED') =>
      this.#refuse(requestId, request, reasonCode) as SyscallRejected;
    const replay = this.#replay(requestId, request) as
      DelegationReserved | SyscallRejected | undefined;
    if (replay !== undefined) return replay;
    const admitted = admitWork(this.#host.control());
    if (!admitted.accepted) return refuse(admitted.reasonCode);
    if (this.#underWarning()) return refuse('MEMORY_PRESSURE');
    const parent = this.#agentRuns.get(parentAgentRunId);
    if (parent === undefined) return refuse('AGENT_RUN_NOT_FOUND');
    if (parent.state === 'ENDED') return refuse('AGENT_RUN_ENDED');
    // Only an AgentRun with `agent.spawn` in its ceiling spawns (M2Design 5.4, layer 3).
    if (!parent.ceiling.capabilities.has('agent.spawn') || this.#deps.agentShare === undefined)
      return refuse('FORBIDDEN');
    const names = new Set(request.tasks.map((task) => task.name));
    if (names.size !== request.tasks.length) return refuse('INVALID_INPUT');
    const parentRoots = writableRoots(parent.ceiling);
    const context = { sessionId: request.sessionId, workflowRunId: request.workflowRunId };
    const tasks: {
      name: string;
      roots: string[];
      tokens: number;
      least: number;
      ceiling: number;
      clamped?: 'MIN' | 'MAX';
    }[] = [];
    for (const task of request.tasks) {
      const share = this.#deps.agentShare(task.agentRef, context);
      if (!share.ok) return refuse(share.reasonCode);
      if (share.defaultShare === undefined) return refuse('FORBIDDEN');
      const roots = task.writeRoots.flatMap((root) => normalizeRequestPath(root) ?? []);
      if (roots.length !== task.writeRoots.length) return refuse('INVALID_INPUT');
      if (!writeRootsWithin(roots, parentRoots)) return refuse('CAPABILITY_NOT_SUBSET');
      // A task opens with the least its Agent can work with, as the ledgers count it (rule 7),
      // and is topped up as it needs more, in pieces of that size (M2Design 7.3, rule 5), so
      // nothing is reserved that is not used. What the caller asked for bounds how far it may be
      // topped up for its own calls: between four times the least by the Agent's declared limits
      // and twice the default; beyond it the task wraps up.
      const least = this.#deps.ledgers.leastShare(share.budget);
      const asked = task.tokens ?? share.defaultShare;
      const ceiling = Math.max(4 * minShare(share.budget), Math.min(2 * share.defaultShare, asked));
      tasks.push({
        name: task.name,
        roots,
        tokens: least,
        least,
        ceiling,
        ...(asked < least ? { clamped: 'MIN' as const } : {}),
      });
    }
    const leastTotal = tasks.reduce((sum, task) => sum + task.least, 0);
    const delegationId = this.#deps.newDelegationId?.() ?? newId('dlg');
    const result = this.#deps.ledgers.reserveDelegation({
      delegationId,
      parentAgentRunId,
      shares: tasks.map(({ name, tokens, ceiling }) => ({ name, tokens, ceiling })),
    });
    if (!result.ok) {
      const response: SyscallRejected = {
        requestId,
        outcome: 'REJECTED',
        issuer: 'CORE',
        reasonCode: 'BUDGET_INSUFFICIENT',
        delegable: result.delegable,
        least: leastTotal,
      };
      this.#requests.remember(requestId, request, response);
      return response;
    }
    this.#delegations.create(delegationId, parent.mission, tasks);
    this.#activity.waitingForSubtasks(parentAgentRunId);
    const response: DelegationReserved = {
      requestId,
      outcome: 'ACCEPTED',
      delegationId,
      shares: tasks.map(({ name, tokens, clamped }) => ({
        name,
        tokens,
        ...(clamped === undefined ? {} : { clamped }),
      })),
    };
    this.#requests.remember(requestId, request, response);
    return response;
  }

  /** The shares of the tasks that never registered go back to the parent (M2Design 7.3, rule 3). */
  releaseDelegation(request: ReleaseDelegationRequest): Response {
    const { requestId, delegationId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const { phase } = this.#host.control();
    if (phase === 'CONVERGING' || phase === 'CLOSED') return this.#accept(requestId, request);
    if (!this.#delegations.has(delegationId))
      return this.#refuse(requestId, request, 'DELEGATION_NOT_FOUND');
    this.#deps.ledgers.releaseDelegation(delegationId);
    this.#delegations.release(delegationId);
    return this.#accept(requestId, request);
  }

  /**
   * A timer that wakes a sleeping task (Orchestration 8.5): when it is due, and the run still
   * works, Workflow hears `WakeDue`. Workflow decides whether it still matters, so it is not
   * cancelled while the run works; it ends with the run, or the process would wait for it after
   * the run closed (a sleep of an hour kept `mas run` alive for that hour, 2026-11-14).
   */
  scheduleWake(request: ScheduleWakeRequest): Response {
    const { requestId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const admitted = admitWork(this.#host.control());
    if (!admitted.accepted) return this.#refuse(requestId, request, admitted.reasonCode);
    const { missionId, timerId } = request;
    const epoch = this.#host.runEpoch();
    const cancel = this.#deps.schedule(request.seconds * 1000, () => {
      this.#wakeTimers.delete(cancel);
      this.#host.enqueue(() => {
        const { phase } = this.#host.control();
        if (phase === 'CONVERGING' || phase === 'CLOSED' || epoch !== this.#host.runEpoch()) return;
        this.#host.toWorkflowEvent({ type: 'WakeDue', missionId, timerId });
      });
    });
    this.#wakeTimers.add(cancel);
    return this.#accept(requestId, request);
  }

  /**
   * A checkpoint (Orchestration 7.3): mutating work is held, the snapshot is taken once none is in
   * flight, and the barrier is lifted. Workflow hears `CheckpointTaken`, or `SKIPPED` when there
   * is no way to take one now (no snapshots, another in progress, or the wait ran too long).
   */
  takeCheckpoint(request: TakeCheckpointRequest): Response {
    const { requestId, checkpointId, kind, label } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const admitted = admitWork(this.#host.control());
    if (!admitted.accepted) return this.#refuse(requestId, request, admitted.reasonCode);
    const skip = () =>
      this.#host.toWorkflowEvent({
        type: 'CheckpointTaken',
        checkpointId,
        outcome: 'SKIPPED',
        heldUnits: [],
      });
    const { checkpoint, holdMutating, releaseMutating, heldMutating } = this.#deps;
    const openInput = this.#openInputId;
    if (
      checkpoint === undefined ||
      holdMutating === undefined ||
      releaseMutating === undefined ||
      heldMutating === undefined ||
      openInput === undefined ||
      this.#checkpointing
    ) {
      skip();
      return this.#accept(requestId, request);
    }
    this.#checkpointing = true;
    const epoch = this.#host.runEpoch();
    let done = false;
    const finish = (taken: boolean) => {
      if (done) return;
      done = true;
      this.#host.enqueue(async () => {
        try {
          if (!taken || epoch !== this.#host.runEpoch()) {
            skip();
            return;
          }
          const held = heldMutating();
          const snapshot = await checkpoint(checkpointId, kind, label);
          this.#host.toWorkflowEvent({
            type: 'CheckpointTaken',
            checkpointId,
            outcome: snapshot === undefined ? 'SKIPPED' : 'TAKEN',
            ...(snapshot === undefined ? {} : { snapshot }),
            heldUnits: held,
          });
        } finally {
          this.#checkpointing = false;
          releaseMutating();
        }
      });
    };
    const stopWaiting = this.#deps.schedule(this.#deps.checkpointBarrierMs ?? 600_000, () => {
      finish(false);
    });
    holdMutating(() => {
      stopWaiting();
      finish(true);
    });
    return this.#accept(requestId, request);
  }

  /**
   * A task was stopped or interrupted by its parent (Orchestration 5.1, 5.2): what its AgentRun has
   * queued or running is cancelled now, so it does not finish a long command or model call first.
   * The run goes on; every cancelled Unit answers INTERRUPTED(ABORTED).
   */
  haltAgentRun(request: HaltAgentRunRequest): Response {
    const { requestId, agentRunId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    if (!this.#agentRuns.has(agentRunId))
      return this.#refuse(requestId, request, 'AGENT_RUN_NOT_FOUND');
    this.#deps.abortAgentRunExecutions?.(agentRunId);
    return this.#accept(requestId, request);
  }

  /**
   * A task that ended after the cut a rewind went back to is open again (Orchestration 7.5): asleep,
   * no segment running, its write roots held and lent again, its share funded again from its parent.
   * A task still open is left as it is.
   */
  restoreMission(request: RestoreMissionRequest): Response {
    const { requestId, missionId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const admitted = admitWork(this.#host.control());
    if (!admitted.accepted) return this.#refuse(requestId, request, admitted.reasonCode);
    const mission = this.#missions.get(missionId);
    if (mission === undefined) return this.#refuse(requestId, request, 'MISSION_NOT_FOUND');
    if (!mission.closed) return this.#accept(requestId, request);
    if (mission.parent !== undefined && this.#missions.get(mission.parent)?.closed !== false)
      return this.#refuse(requestId, request, 'MISSION_NOT_FOUND');
    if (this.#writeConflict(missionId, mission.parent, mission.roots))
      return this.#refuse(requestId, request, 'WRITE_SCOPE_CONFLICT');
    if (mission.funded && request.tokens !== undefined) {
      const parentKey =
        mission.parent === undefined || this.#missions.get(mission.parent)?.funded !== true
          ? undefined
          : mission.parent;
      const segment = [...this.#agentRuns.values()].find((each) => each.mission === missionId);
      if (segment === undefined) return this.#refuse(requestId, request, 'MISSION_NOT_FOUND');
      this.#deps.ledgers.restoreTask({
        key: missionId,
        parentKey,
        tokens: request.tokens,
        agent: segment.agent.budget,
      });
    }
    mission.closed = false;
    this.#delegations.reopen(missionId);
    return this.#accept(requestId, request);
  }

  /**
   * A sleeping task that will not wake is closed (Orchestration 5.1, 7.5): its roots are given back,
   * the unused part of its share returns to its parent. One with a segment running is not: that
   * segment ends it, as it always does.
   */
  closeMission(request: CloseMissionRequest): Response {
    const { requestId, missionId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const mission = this.#missions.get(missionId);
    if (mission === undefined || mission.closed) return this.#accept(requestId, request);
    if (mission.active !== undefined) return this.#refuse(requestId, request, 'MISSION_BUSY');
    mission.closed = true;
    this.#activity.missionClosed(missionId);
    if (mission.funded) this.#deps.ledgers.closeTask(missionId);
    this.#delegations.childEnded(missionId);
    return this.#accept(requestId, request);
  }

  /** A background command ended (Orchestration 6.4): Workflow hears it while the run works. */
  jobEnded(fact: JobEndedFact): void {
    const { phase } = this.#host.control();
    if (phase === 'CONVERGING' || phase === 'CLOSED') return;
    const { jobKey, exit, durationMs, totalBytes, tail } = fact;
    this.#host.toWorkflowEvent({ type: 'JobEnded', jobKey, exit, durationMs, totalBytes, tail });
  }

  /** What a handover carries is kept for the Session, so it can be read later (Core 5g). */
  async retainArtifacts(request: RetainArtifactsRequest): Promise<Response> {
    const { requestId, refs } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    if (!(await this.#deps.retainArtifacts(refs)))
      return this.#refuse(requestId, request, 'INVALID_ARTIFACT_REF');
    return this.#accept(requestId, request);
  }

  async submitUnit(request: SubmitUnitRequest): Promise<Response> {
    const { requestId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const record = this.#agentRuns.get(request.agentRunId);
    const admission = admitUnit(request, {
      control: this.#host.control(),
      agentRun:
        record === undefined
          ? undefined
          : {
              state: record.state,
              units: record.agent.units,
              maxToolUnits: record.agent.maxToolUnits,
            },
      inputIsValid: this.#deps.inputIsValid,
    });
    if (!admission.accepted) return this.#refuse(requestId, request, admission.reasonCode);
    if (record === undefined) throw new Error('An admitted Unit has no AgentRun');
    const { unit } = admission;
    const response = this.#accept(requestId, request);
    this.#units.submitted += 1;

    const interrupted = this.#interruptRefusal();
    if (interrupted !== undefined && unit.executionKind !== 'MESSAGE_PUBLISH')
      return this.#refuse(requestId, request, interrupted);
    // What a task has lent is its borrower's to write until it comes back (Orchestration 8.2, D17):
    // a write there is refused; a command runs with those roots read-only (`#commandScope`).
    if (unit.executionKind === 'FILE_WRITE' || unit.executionKind === 'FILE_EDIT') {
      const lent = this.#delegations.delegatedRoots(record.mission);
      const path = pathOf(request.input);
      const normalized = path === undefined ? undefined : normalizeRequestPath(path);
      if (lent.length > 0 && (normalized === undefined || writeRootsWithin([normalized], lent))) {
        this.#refuseUnit(request, unit, { reasonCode: 'WRITE_SCOPE_DELEGATED' });
        return response;
      }
    }
    if (admission.countsAsTool && this.#underWarning()) {
      this.#refuseUnit(request, unit, { reasonCode: 'QUOTA_EXHAUSTED', quota: 'MEMORY' });
      return response;
    }
    if (admission.countsAsTool) {
      const quota = this.#deps.ledgers.countToolUnit(request.agentRunId, record.agent.maxToolUnits);
      if (!quota.ok) {
        this.#refuseUnit(request, unit, { reasonCode: 'QUOTA_EXHAUSTED', quota: quota.quota });
        return response;
      }
    }
    await this.#decide({ request, unit, record });
    return response;
  }

  /** Kernel/Core 5a.3; an answer to a question comes back here, because it only adds an entry. */
  async #decide(waiting: WaitingUnit): Promise<void> {
    const { request, unit, record } = waiting;
    let readOnly = false;
    let auto = false;
    let external: ExternalResolution | undefined;
    for (const capability of unit.protectedCapabilities) {
      const path = pathOf(request.input);
      if (capability === 'external.read') {
        this.#externalAsks.set(request.requestId, path ?? '');
        external = await this.#resolveExternal(path);
      }
      const command = capability === 'command.exec' ? this.#commandDemand(request) : undefined;
      const web = capability === 'web.fetch' ? this.#webDemand(request) : undefined;
      if (capability === 'command.exec' && command === undefined) {
        this.#refuseUnit(request, unit, { reasonCode: 'ADMISSION_CHECK_FAILED' });
        return;
      }
      const decision = this.#authorization.decide(
        {
          requestId: request.requestId,
          agentRunId: request.agentRunId,
          capability,
          ...(path === undefined ? {} : { path }),
          ...(command === undefined ? {} : { command }),
          ...(web === undefined ? {} : { web }),
          ...(external === undefined
            ? {}
            : { external: { root: external.ok ? external.root : undefined } }),
        },
        record.ceiling,
      );
      if (decision.kind === 'ALLOW' && decision.readOnly === true) readOnly = true;
      if (decision.kind === 'ALLOW' && decision.auto === true) auto = true;
      if (decision.kind === 'REFUSE') {
        this.#refuseUnit(request, unit, { reasonCode: decision.reasonCode });
        return;
      }
      if (decision.kind === 'ASK') {
        await this.#ask(waiting, decision);
        return;
      }
    }
    // Every command that ran without a question is in the audit, with what it was.
    if (auto && 'command' in request.input)
      this.#deps.audit({
        type: 'COMMAND_AUTO_APPROVED',
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        command: request.input.command,
        workdir: request.input.workdir,
      });
    if (unit.executionKind === 'MODEL' && this.#budgetShort(waiting)) return;
    await this.#startAttempt(request, unit, record, readOnly, external?.ok ? external : undefined);
  }

  /**
   * Before a call of the model: when the work of the input is about to run out of its budget and
   * the run still has tokens, more is added, by the configuration or by the user's answer
   * (M2Design 7.3, rule 6). The model is not part of it and is not told: with more, its ledgers
   * are simply in NORMAL. True when the call waits for the user's answer.
   */
  #budgetShort(waiting: WaitingUnit): boolean {
    const { requestId, agentRunId } = waiting.request;
    const policy = this.#deps.budgetExtension ?? { mode: 'ask' as const, max: 4 };
    if (policy.mode === 'stop' || this.#budgetDeclined || this.#budgetExtensions >= policy.max)
      return false;
    const wants = this.#deps.ledgers.inputWants(agentRunId);
    if (wants === undefined) return false;
    if (policy.mode === 'extend') {
      this.#extendBudget(wants.add, requestId, agentRunId, 'CONFIGURED');
      return false;
    }
    const tasks = [...this.#missions.values()].filter(
      (mission) => mission.parent !== undefined && !mission.closed,
    ).length;
    const check = this.#authorization.askBudget(wants, tasks, requestId, agentRunId);
    if (check.requested !== undefined) {
      this.#budgetOffer = wants.add;
      this.#host.toInteraction(check.requested);
      this.#deps.audit({
        type: 'AUTHORIZATION_ASKED',
        requestId,
        agentRunId,
        capability: 'budget.extend',
      });
    }
    this.#waiting.set(requestId, waiting);
    this.#activity.awaitingAuthorization(agentRunId);
    return true;
  }

  #extendBudget(
    tokens: number,
    requestId: string,
    agentRunId: string,
    by: 'USER' | 'CONFIGURED',
  ): void {
    const added = this.#deps.ledgers.extendInput(tokens);
    if (added === 0) return;
    this.#budgetExtensions += 1;
    this.#deps.audit({ type: 'BUDGET_EXTENDED', requestId, agentRunId, tokens: added, by });
  }

  #resolveExternal(path: string | undefined): Promise<ExternalResolution> {
    if (path === undefined) return Promise.resolve({ ok: false });
    return resolveExternal(path, {
      support: this.#deps.external ?? { homeDir: homedir() },
      repositoryRoot: this.#deps.repositoryRoot,
      granted: this.#authorization.externalRoots(),
    });
  }

  async #ask(waiting: WaitingUnit, decision: Extract<UnitDecision, { kind: 'ASK' }>) {
    const { requestId, agentRunId, input } = waiting.request;
    let check;
    if (decision.capability === 'command.exec') check = this.#askCommand(waiting, decision);
    else if (decision.capability === 'web.search')
      check = this.#authorization.askWebSearch(
        (input as WebSearchInput).queries,
        this.#deps.web?.searchProvider ?? 'deepseek',
        requestId,
        agentRunId,
      );
    else if (decision.capability === 'web.fetch')
      check = this.#authorization.askWebFetch(
        (input as WebFetchInput).url,
        decision.resourceKey,
        requestId,
        agentRunId,
      );
    else if (decision.capability === 'repo.read')
      check = this.#authorization.requireRepoRead(requestId, agentRunId);
    else if (decision.capability === 'external.read')
      check = this.#authorization.askExternalRead(
        decision.resourceKey,
        pathOf(input) ?? decision.resourceKey,
        requestId,
        agentRunId,
      );
    else if (decision.critical) {
      const path = pathOf(input);
      if (path === undefined) throw new Error('A critical write has no path');
      const contentRef = await this.#deps.storeQuestionContent(shownContent(input));
      check = this.#authorization.askWrite(
        { critical: true, path, contentRef },
        requestId,
        agentRunId,
      );
    } else
      check = this.#authorization.askWrite(
        { critical: false, writeRoot: decision.resourceKey },
        requestId,
        agentRunId,
      );
    if (check.requested !== undefined) {
      this.#host.toInteraction(check.requested);
      // Every question is in the audit, so a run says how often it stopped for the user.
      this.#deps.audit({
        type: 'AUTHORIZATION_ASKED',
        requestId,
        agentRunId,
        capability: decision.capability,
      });
    }
    this.#waiting.set(requestId, waiting);
    this.#activity.awaitingAuthorization(agentRunId);
  }

  #webDemand(request: SubmitUnitRequest): UnitDemand['web'] | undefined {
    const { input } = request as { input: Partial<WebFetchInput> };
    return typeof input.url === 'string'
      ? { url: input.url, deniedDomains: this.#deps.web?.deniedDomains ?? [] }
      : undefined;
  }

  #commandDemand(request: SubmitUnitRequest): CommandDemand | undefined {
    const support = this.#deps.command;
    if (support === undefined || !('command' in request.input) || !('timeoutMs' in request.input))
      return undefined;
    const { input } = request as { input: CommandInput };
    return {
      analysis: support.analyze(input.command),
      workdir: input.workdir,
      network: input.network,
      sandbox: support.sandbox(),
      unavailablePolicy: support.unavailablePolicy,
      repoReadGranted: this.#authorization.lease !== undefined,
      ...(support.approval === undefined ? {} : { approval: support.approval }),
    };
  }

  #askCommand(waiting: WaitingUnit, decision: Extract<UnitDecision, { kind: 'ASK' }>) {
    const { request, record } = waiting;
    const demand = this.#commandDemand(request);
    if (demand === undefined) throw new Error('A command question has no command');
    const input = request.input as CommandInput;
    const unisolated = demand.sandbox === 'UNAVAILABLE';
    const roots = [...writableRoots(record.ceiling)];
    return this.#authorization.askCommand(
      {
        analysis: demand.analysis,
        workdir: input.workdir,
        writableRoots: roots,
        network: input.network,
        unisolated,
        approvalDigest: approvalDigestOf({
          command: input.command,
          workdir: input.workdir,
          network: input.network,
          writableRoots: roots,
          backend: unisolated ? 'UNISOLATED' : 'BWRAP',
        }),
      },
      decision.critical,
      request.requestId,
      request.agentRunId,
    );
  }

  #refuseUnit(
    request: SubmitUnitRequest,
    unit: UnitDefinition,
    refusal: Parameters<RunAttempts['rejectWithoutAttempt']>[1],
  ): void {
    this.#attempts.rejectWithoutAttempt(
      {
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        unitRunId: request.unitRunId,
        unit,
      },
      refusal,
    );
  }

  /** Where a command runs and with what; the scanned lists are not part of what was approved. */
  async #commandScope(
    request: SubmitUnitRequest,
    record: AgentRunRecord,
    readOnly: boolean,
  ): Promise<ExecutionScope> {
    const support = this.#deps.command;
    if (support === undefined) throw new Error('A command needs the command support');
    const input = request.input as CommandInput;
    const backend = support.sandbox() === 'UNAVAILABLE' ? 'UNISOLATED' : 'BWRAP';
    // A line of the read-only list runs where nothing can be written, whatever the AgentRun may.
    const roots = readOnly ? [] : [...writableRoots(record.ceiling)];
    return {
      kind: 'SANDBOX',
      backend,
      approvalDigest: approvalDigestOf({
        command: input.command,
        workdir: input.workdir,
        network: input.network,
        writableRoots: roots,
        backend,
      }),
      profile: {
        repositoryRoot: this.#deps.repositoryRoot,
        workdir: input.workdir,
        writableRoots: roots,
        network: input.network,
        homeReadOnly: [...support.homeReadOnly],
        homeMaskedFiles: [...support.homeMaskedFiles],
        ...(support.dataDir === undefined ? {} : { dataDir: support.dataDir }),
        ...(await this.#withLentRoots(record, support.scan())),
      },
    };
  }

  /** The roots the task has lent come back read-only for its commands (Orchestration 8.2). */
  async #withLentRoots(
    record: AgentRunRecord,
    scanned: Promise<Pick<SandboxProfile, 'maskedFiles' | 'maskedDirs' | 'protectedExisting'>>,
  ): Promise<Pick<SandboxProfile, 'maskedFiles' | 'maskedDirs' | 'protectedExisting'>> {
    const scan = await scanned;
    const lent = this.#delegations.delegatedRoots(record.mission);
    return lent.length === 0
      ? scan
      : { ...scan, protectedExisting: [...new Set([...scan.protectedExisting, ...lent])].sort() };
  }

  /** The folder the user allowed, read under the defaults and the credential rules (Core 5h). */
  #externalScope(external: Extract<ExternalResolution, { readonly ok: true }>): ExecutionScope {
    return {
      kind: 'REPOSITORY',
      repositoryRoot: external.root,
      exclusions: [...new Set([...this.#authorization.exclusions, ...external.exclusions])],
      external: { below: external.path },
    };
  }

  #scopeOf(unit: UnitDefinition, record: AgentRunRecord): ExecutionScope {
    if (unit.executionKind === 'MODEL') return record.agent.modelScope;
    if (unit.protectedCapabilities.includes('workspace.write'))
      return {
        kind: 'WORKSPACE',
        repositoryRoot: this.#deps.repositoryRoot,
        writableRoots: [...writableRoots(record.ceiling)],
        exclusions: [...record.ceiling.exclusions],
      };
    if (!unit.protectedCapabilities.includes('repo.read')) return { kind: 'NONE' };
    const lease = this.#authorization.lease;
    if (lease === undefined) throw new Error('A protected Unit needs a valid Lease');
    return {
      kind: 'REPOSITORY',
      repositoryRoot: lease.repositoryRoot,
      exclusions: [...lease.exclusions],
    };
  }

  async #startAttempt(
    request: SubmitUnitRequest,
    unit: UnitDefinition,
    record: AgentRunRecord,
    readOnly = false,
    external?: Extract<ExternalResolution, { readonly ok: true }>,
  ): Promise<void> {
    if (this.#host.control().openInput === undefined)
      throw new Error('A Unit starts only in the work of an input');
    let scope: ExecutionScope;
    try {
      scope =
        external !== undefined
          ? this.#externalScope(external)
          : unit.executionKind === 'COMMAND'
            ? await this.#commandScope(request, record, readOnly)
            : this.#scopeOf(unit, record);
    } catch (error) {
      // E.g. the repository is too large to scan for secrets: the command does not run unmasked.
      if (unit.executionKind !== 'COMMAND') throw error;
      this.#refuseUnit(request, unit, { reasonCode: 'ADMISSION_CHECK_FAILED' });
      return;
    }
    if (readOnly && unit.executionKind === 'COMMAND')
      this.#deps.audit({
        type: 'COMMAND_READ_ONLY',
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        command: (request.input as CommandInput).command,
        workdir: (request.input as CommandInput).workdir,
      });
    if (external !== undefined)
      this.#deps.audit({
        type: 'EXTERNAL_READ',
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        executionKind: unit.executionKind,
        path: pathOf(request.input) ?? '',
        root: external.root,
      });
    await this.#attempts.start({
      requestId: request.requestId,
      agentRunId: request.agentRunId,
      unitRunId: request.unitRunId,
      unit,
      input: external === undefined ? request.input : externalInput(request.input, external),
      scope,
      runEpoch: this.#host.runEpoch(),
      agent: record.agent,
      display: request.display,
    });
  }

  // ---- compaction (Kernel/Core 6a) -------------------------------------------------------

  /** What a compaction of this target is made with: its AgentRun's pinned agent. */
  compactionAgent(
    target: CompactionTarget,
  ): { readonly agent: PinnedAgent; readonly agentRunId?: string } | undefined {
    // One way to find the Agent of every target (`compactionAgentFrom`). The target says which:
    // main is the Agent of the Session's Turn-chat, an AgentRun is the Agent it was registered as.
    // Which AgentRun pays for it is the one thing that is not the Agent's.
    if (target.kind === 'MAIN') {
      const agent = this.#deps.compactionAgent();
      return agent === undefined ? undefined : { agent };
    }
    const record = this.#agentRuns.get(target.agentRunId);
    if (record === undefined) return undefined;
    const agent = this.#deps.compactionAgent(record.agentRef);
    if (agent === undefined) return undefined;
    // A SubAgent pays from its own ledger; a top-level AgentRun from the input's.
    return { agent, ...(record.parent === undefined ? {} : { agentRunId: target.agentRunId }) };
  }

  #targetOf(agentRunId: string): CompactionTarget {
    const record = this.#agentRuns.get(agentRunId);
    return record !== undefined && record.parent === undefined && record.agent.id === 'main'
      ? { kind: 'MAIN' }
      : { kind: 'AGENT_RUN', agentRunId };
  }

  /**
   * What an ordinary assembly calls for (Kernel/Execution): a compaction of its context to run
   * first, or waiting for one that is going on. The overflow trigger goes as far as
   * `overflowTargets` go, the automatic one runs once a round.
   */
  #checkpoint(
    info: AssemblyInfo,
  ):
    | { readonly kind: 'WAIT'; readonly going: Promise<unknown> }
    | { readonly kind: 'RUN'; readonly request: Parameters<Compacting['run']>[0] }
    | undefined {
    const { compactor, compaction } = this.#deps;
    if (compactor === undefined || compaction === undefined) return undefined;
    const target = this.#targetOf(info.agentRunId);
    // What a user's compaction of the same context is doing changes what this
    // assembly was made of: wait for it, and have the assembly made again.
    const going = compactor.runningFor(target);
    if (going !== undefined) return { kind: 'WAIT', going };
    const overflows = this.#overflows.get(info.agentRunId) ?? 0;
    const overflowShare = compaction.overflowTargets[overflows - 1];
    const size = Math.max(info.tokenCount, info.tokenBudget);
    if (overflows > 0)
      return overflowShare === undefined
        ? undefined
        : {
            kind: 'RUN',
            request: {
              trigger: 'OVERFLOW',
              target,
              currentTokens: size,
              goalTokens: Math.floor(size * overflowShare),
            },
          };
    if (
      !this.#compactedInRound.has(info.agentRunId) &&
      (info.kind === 'OVERSIZE' || info.tokenCount >= compaction.triggerRatio * info.tokenBudget)
    )
      return {
        kind: 'RUN',
        request: { trigger: 'AUTO', target, currentTokens: info.tokenCount },
      };
    return undefined;
  }

  compactionDue(info: AssemblyInfo): boolean {
    return this.#checkpoint(info) !== undefined;
  }

  async afterAssemble(info: AssemblyInfo): Promise<'PROCEED' | 'COMPACTED' | 'BUDGET'> {
    const step = this.#checkpoint(info);
    const { compactor } = this.#deps;
    if (step === undefined || compactor === undefined) return 'PROCEED';
    if (step.kind === 'WAIT') {
      await step.going;
      return 'COMPACTED';
    }
    this.#compactedInRound.add(info.agentRunId);
    this.#host.enqueue(() => {
      this.#activity.compacting(info.agentRunId);
    });
    const result = await compactor.run(step.request);
    if (result.kind === 'CHANGED') return 'COMPACTED';
    return result.kind === 'BUDGET' ? 'BUDGET' : 'PROCEED';
  }

  /** The model answered or refused a call: a new round has begun, or a size was refused. */
  modelAnswered(info: {
    readonly agentRunId: string;
    readonly completed: boolean;
    readonly overflow: boolean;
  }): void {
    if (info.completed) {
      this.#compactedInRound.delete(info.agentRunId);
      this.#overflows.delete(info.agentRunId);
    } else if (info.overflow)
      this.#overflows.set(info.agentRunId, (this.#overflows.get(info.agentRunId) ?? 0) + 1);
  }

  /** Workflow hands over the material that Kernel asked for. */
  reportCompactionSource(request: ReportCompactionSourceRequest): Response {
    const known = this.#deps.compactor?.reportSource(request.compactionId, request.entries);
    return known === true
      ? { requestId: request.requestId, outcome: 'ACCEPTED' }
      : {
          requestId: request.requestId,
          outcome: 'REJECTED',
          issuer: 'CORE',
          reasonCode: 'COMPACTION_UNKNOWN',
        };
  }

  /** Workflow says whether it put the result of a compaction in the log. */
  ackCompaction(request: AckCompactionRequest): Response {
    const known = this.#deps.compactor?.acknowledge(
      request.compactionId,
      request.stage,
      request.outcome,
    );
    return known === true
      ? { requestId: request.requestId, outcome: 'ACCEPTED' }
      : {
          requestId: request.requestId,
          outcome: 'REJECTED',
          issuer: 'CORE',
          reasonCode: 'COMPACTION_UNKNOWN',
        };
  }

  /**
   * `/compact`: the context of main is compacted while the run awaits input. Not awaited by the
   * actor; what comes of it reaches Workflow and the interface as events. It needs the Agent main
   * and nothing else: not an AgentRun of it, so it works as well right after a Session is opened.
   * Refused while main is being compacted already.
   */
  startMainCompaction(): boolean {
    const { compactor, compaction } = this.#deps;
    if (compactor === undefined || compaction === undefined) return false;
    if (this.compactionAgent({ kind: 'MAIN' }) === undefined) return false;
    if (compactor.runningFor({ kind: 'MAIN' }) !== undefined) return false;
    void compactor.run({ trigger: 'USER', target: { kind: 'MAIN' } }).catch(() => undefined);
    return true;
  }

  /** Is this AgentRun the one whose context the Session's conversation is made of (main)? */
  isMain(agentRunId: string): boolean {
    return this.#targetOf(agentRunId).kind === 'MAIN';
  }

  /** A pause, an abort, `/undo`, `/fork` or the end of the run stops what compacts. */
  cancelCompaction(): void {
    this.#deps.compactor?.cancel();
  }

  /** Execution waits before the next try; Core says so in the activity area (Kernel/Execution 4a). */
  retrying(retry: RetryingActivity): void {
    this.#activity.retrying(retry.spec, retry.unitAttemptId, retry.attempt, retry.retryAt);
  }

  async answerAuthorization(request: AnswerAuthorizationRequest): Promise<Response> {
    const { requestId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    if (!this.#authorization.offers(request.questionId, request.answer.scope))
      return this.#refuse(requestId, request, 'INVALID_INPUT');
    const settled = this.#authorization.answer(request.questionId, request.answer.scope);
    if (settled === undefined) return this.#refuse(requestId, request, 'QUESTION_NOT_PENDING');
    this.#host.toInteraction(settled.resolved);
    // More budget (rule 6): yes adds what was offered; no is not asked again for this input.
    if (settled.capability === 'budget.extend') {
      const first = settled.waiters[0];
      const waiter = first === undefined ? undefined : this.#waiting.get(first);
      if (settled.resolution !== 'GRANTED') this.#budgetDeclined = true;
      else if (waiter !== undefined)
        this.#extendBudget(
          this.#budgetOffer,
          first ?? requestId,
          waiter.request.agentRunId,
          'USER',
        );
    }
    // "This folder from now on" is kept by Session management; the run has it too, for now.
    if (request.answer.scope === 'FOLDER') await this.#deps.trustWebSearch();
    await this.#release(settled);
    for (const covered of this.#authorization.settleCovered()) {
      this.#host.toInteraction(covered.resolved);
      await this.#release(covered);
    }
    return this.#accept(requestId, request);
  }

  async #release(settled: QuestionResolved): Promise<void> {
    for (const requestId of settled.waiters) {
      const file = this.#waitingFiles.get(requestId);
      if (file !== undefined) {
        await this.#continueFile(file, settled.resolution === 'GRANTED');
        continue;
      }
      const waiting = this.#waiting.get(requestId);
      if (waiting === undefined) continue;
      this.#waiting.delete(requestId);
      await this.#decide(waiting);
    }
  }

  /**
   * Answers later than the message that asked: the request may wait on the user, and a handler
   * that waited here would block the answer behind it. The caller awaits `response` outside.
   */
  async readProjectFile(
    request: ReadProjectFileRequest,
  ): Promise<{ readonly response: Promise<FileResponse> }> {
    const { requestId } = request;
    const replay = this.#requests.lookup<FileResponse>(requestId, request);
    if (replay.kind === 'replay') return { response: Promise.resolve(replay.response) };
    const refused = (reasonCode: 'REQUEST_CONFLICT' | 'RUN_BLOCKED') => ({
      response: Promise.resolve(this.#refuse(requestId, request, reasonCode) as SyscallRejected),
    });
    if (replay.kind === 'conflict') return refused('REQUEST_CONFLICT');
    if (!readsProjectFile(this.#host.control()).accepted) return refused('RUN_BLOCKED');

    let done: WaitingFile['done'] = () => undefined;
    const response = new Promise<FileResponse>((resolve) => {
      done = (result) => {
        this.#waitingFiles.delete(requestId);
        this.#requests.remember(requestId, request, result);
        resolve(result);
      };
    });
    const file: WaitingFile = { request, done };
    const { decision, requested } = this.#authorization.requireRepoRead(requestId);
    if (requested !== undefined) this.#host.toInteraction(requested);
    if (decision.kind === 'ALLOWED') await this.#continueFile(file, true);
    else if (decision.kind === 'DECLINED') await this.#continueFile(file, false);
    else this.#waitingFiles.set(requestId, file);
    return { response };
  }

  async #continueFile(file: WaitingFile, granted: boolean): Promise<void> {
    const { requestId, path } = file.request;
    const accepted = { requestId, outcome: 'ACCEPTED' } as const;
    if (file.read !== undefined) {
      if (granted) await this.#deps.trust(path, file.read.sha256);
      this.#answerInstructions(file, file.read, granted);
      return;
    }
    if (!granted) {
      file.done({ requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode: 'USER_DECLINED' });
      return;
    }
    const { lease } = this.#authorization;
    if (lease === undefined) throw new Error('A project file needs a valid Lease');
    const read = await this.#deps.readProjectFile(path, {
      kind: 'REPOSITORY',
      repositoryRoot: lease.repositoryRoot,
      exclusions: [...lease.exclusions],
    });
    if (!read.exists) {
      file.done({ ...accepted, path, exists: false });
      return;
    }
    if (!isProjectInstructionPath(path)) {
      const { ref, sha256, text } = read;
      file.done({ ...accepted, path, exists: true, ref, sha256, text });
      return;
    }
    if (this.#deps.isTrusted(path, read.sha256)) {
      this.#answerInstructions(file, read, true);
      return;
    }
    if (this.#deps.preset === 'readonly') {
      this.#answerInstructions(file, read, false);
      return;
    }
    const { decision, requested } = this.#authorization.askInstructions(
      { path, sha256: read.sha256, contentRef: read.ref, truncated: read.truncated },
      requestId,
    );
    if (requested !== undefined) this.#host.toInteraction(requested);
    if (decision.kind === 'PENDING') {
      file.read = read;
      this.#waitingFiles.set(requestId, file);
    } else this.#answerInstructions(file, read, false);
  }

  #answerInstructions(
    file: WaitingFile,
    read: Extract<ProjectFileRead, { exists: true }>,
    trusted: boolean,
  ): void {
    file.done({
      requestId: file.request.requestId,
      outcome: 'ACCEPTED',
      path: file.request.path,
      exists: true,
      ref: read.ref,
      sha256: read.sha256,
      trusted,
    });
  }

  /** Only for the interface: goes into the AgentRun's next ActivityEvents as it came. */
  updateActivity(request: UpdateActivityRequest): Response {
    const { requestId, agentRunId, todos, step } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    if (this.#agentRuns.get(agentRunId)?.state !== 'ACTIVE')
      return this.#refuse(requestId, request, 'AGENT_RUN_NOT_FOUND');
    if (todos !== undefined) this.#activity.todos(agentRunId, todos);
    if (step !== undefined) this.#activity.step(agentRunId, step);
    return this.#accept(requestId, request);
  }

  /**
   * An AgentRun's clock stops while it only waits for the user: nothing dispatched or queued, and
   * a question open on one of its Units (Kernel/Monitor 3).
   */
  reconcile(): void {
    const waitingFor = new Set([...this.#waiting.values()].map((w) => w.request.agentRunId));
    // A paused run does not work, and the clocks do not count it (Kernel/Monitor 3).
    const { phase } = this.#host.control();
    const paused = phase === 'PAUSING' || phase === 'PAUSED';
    this.#clocks.reconcile(
      (agentRunId) =>
        paused ||
        ((waitingFor.has(agentRunId) || this.#waitingFiles.size > 0) &&
          (this.#inFlight.get(agentRunId) ?? 0) === 0) ||
        // Waiting for its SubAgents is not working (Kernel/Monitor 4).
        ((this.#inFlight.get(agentRunId) ?? 0) === 0 &&
          this.#delegations.isDelegated(this.#agentRuns.get(agentRunId)?.mission ?? agentRunId)),
    );
  }

  /** The run started converging: Units on a question end with it and get no report. */
  /**
   * INTERRUPTING (Kernel/Core 5c, 5e): what runs is cancelled and each attempt answers
   * INTERRUPTED(ABORTED), and nothing new starts, but the run stays open so that Workflow can
   * publish the reply that says what happened. Whether it then closes the run (memory pressure,
   * Orchestration) or asks for the next input (Turn-chat) is Workflow's to decide.
   */
  beginInterrupt(reason: InterruptReason, backstopMs: number, due: () => void): void {
    if (reason === 'MEMORY_PRESSURE') this.#memoryWarning = true;
    for (const settled of this.#authorization.cancelQuestions())
      this.#host.toInteraction(settled.resolved);
    this.#waiting.clear();
    this.#clocks.stop();
    this.#deps.abortExecutions();
    // If Workflow does not answer, the Kernel closes the run, so that nothing is held for ever.
    this.#cancelBackstop = this.#deps.schedule(backstopMs, () => {
      this.#host.enqueue(due);
    });
  }

  /** The interrupted work settled and the run is open again: Workflow answered in time. */
  endInterrupt(): void {
    this.#cancelBackstop?.();
    this.#cancelBackstop = undefined;
  }

  /** PAUSING: Execution holds what has not started and cancels what must not run on. */
  pause(drained: () => void): void {
    this.#deps.pauseExecutions(drained);
    this.reconcile();
  }

  async resume(): Promise<void> {
    // The Agent starts again with a clean count (Kernel/Core 5h).
    this.#externalFailures = [];
    await this.#deps.resumeExecutions();
    this.reconcile();
  }

  /** Nothing of this run is dispatched or queued, and a question waits for the user (7.4). */
  awaitsUser(questions: number): boolean {
    const inFlight = [...this.#inFlight.values()].reduce((sum, count) => sum + count, 0);
    return (
      inFlight === 0 && (this.#waiting.size > 0 || this.#waitingFiles.size > 0 || questions > 0)
    );
  }

  /** The AgentRuns that are active: a local question names one of them. */
  activeAgentRuns(): string[] {
    return [...this.#agentRuns].filter(([, record]) => record.state === 'ACTIVE').map(([id]) => id);
  }

  /** The activity area shows these (M2Design 7.5). */
  showAwaitingAnswer(agentRunId: string): void {
    this.#activity.awaitingAnswer(agentRunId);
  }

  showPaused(): void {
    for (const agentRunId of this.activeAgentRuns()) this.#activity.paused(agentRunId);
  }

  beginClosing(): void {
    for (const settled of this.#authorization.cancelQuestions())
      this.#host.toInteraction(settled.resolved);
    this.#waiting.clear();
    for (const file of [...this.#waitingFiles.values()])
      file.done(
        this.#refuse(file.request.requestId, file.request, 'RUN_BLOCKED') as SyscallRejected,
      );
    this.#clocks.stop();
    for (const cancel of this.#wakeTimers) cancel();
    this.#wakeTimers.clear();
    this.#deps.cancelExecutions(this.#host.runEpoch());
  }

  unknownEffects(): UnknownEffect[] {
    return this.#deps.unknownEffects();
  }

  /** Nothing is in flight any more, so the Lease can end. */
  finishClosing(): void {
    this.#authorization.endLease();
    this.#deps.executionsClosed();
  }
}
