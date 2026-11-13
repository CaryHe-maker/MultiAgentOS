import type { RepositoryListInput } from './executor/repository-list.js';
import type { FileEditInput, FileWriteInput } from './executor/file-write.js';
import type { CommandExecutorInput, GitInspectInput } from './executor/command.js';
import type { WebFetchInput, WebSearchInput } from './executor/web.js';
import type { SandboxBackend, SandboxScope } from './platform-common/sandbox.js';
import type { ExecutionResult } from './kernel-execution/execution-fact.js';
import type {
  AssembleExecutorInput,
  PruneExecutorInput,
  ExecutionLimits,
  ModelExecutorInput,
  OutputReadExecutorInput,
} from './kernel-execution/execution-request.js';
import type { ExecutorKind } from './platform-common/execution-kind.js';
import type {
  AgentPinRequest,
  DefinitionLookup,
  PinnedDefinitionSet,
} from './catalog/catalog-schemas.js';
import type { DefinitionByKind, DefinitionKind } from './catalog/definition-schemas.js';
import type { TokenUsage } from './executor/model-call.js';
import type {
  AnswerAuthorizationRequest,
  AnswerHumanRequest,
  InterruptRunRequest,
  PauseRunRequest,
  ResumeRunRequest,
  SteerRunRequest,
  CompactContextRequest,
  ConfirmUndoRequest,
  DiffRequest,
  ListCheckpointsRequest,
  RewindCheckpointRequest,
  CheckpointList,
  ReadArtifactRequest,
  CheckpointDiff,
  UndoRequest,
  RecoverRunRequest,
} from './kernel-control/interaction-requests.js';
import type { SessionAccepted, SyscallRejected } from './kernel-control/responses.js';
import type {
  DeleteSessionRequest,
  ListSessionsRequest,
  OpenSessionRequest,
  StartRunRequest,
  StartSessionRequest,
} from './kernel-control/session-requests.js';
import type {
  ReportSessionCommandRequest,
  ReportSessionListRequest,
} from './kernel-unit/session-replies.js';
import type {
  CloseRunRequest,
  EndAgentRunRequest,
  ProjectFileContent,
  ReadProjectFileRequest,
  DelegationReserved,
  RegisterAgentRunRequest,
  ReleaseDelegationRequest,
  RetainArtifactsRequest,
  ScheduleWakeRequest,
  ControlJobRequest,
  HaltAgentRunRequest,
  RestoreMissionRequest,
  CloseMissionRequest,
  TakeCheckpointRequest,
  JobControlContent,
  ReportCompactionSourceRequest,
  AckCompactionRequest,
  ReserveDelegationRequest,
  RequestHumanRequest,
  SubmitUnitRequest,
  UpdateActivityRequest,
} from './kernel-unit/workflow-syscalls.js';
import type { BoundaryContext } from './platform-common/common-schemas.js';
import type { InstanceLockInfo, SessionLockInfo } from './platform-persistence/locks.js';
import type { FileReadInput } from './executor/file-read.js';
import type { KernelToInteractionEvent } from './kernel-control/interaction-events.js';
import type { ShutdownRequest } from './kernel-control/interaction-requests.js';
import type { ArtifactContent, SyscallAck } from './kernel-control/responses.js';
import type { RequestState } from './kernel-execution/execution-fact.js';
import type {
  ExecutionRequest,
  ExecutionScope,
  OrientExecutorInput,
  SearchExecutorInput,
} from './kernel-execution/execution-request.js';
import type {
  CancelExecutionRequest,
  CancelRunExecutionsRequest,
  JobControlRequest,
  JobControlResult,
  SupervisorShutdownRequest,
} from './kernel-execution/supervisor-requests.js';
import type { KernelToWorkflowEvent } from './kernel-unit/workflow-events.js';
import type {
  ArtifactRef,
  CapabilityDescriptor,
  Envelope,
  ModuleError,
} from './platform-common/common-schemas.js';
import type { ContractValidationError } from './platform-common/validation.js';
import type {
  ExecutorFailedCode,
  ExecutorRejectedCode,
  ViolationCode,
} from './platform-common/reason-code.js';

/** Return value of the synchronous Ports. */
export type PortResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ModuleError };

export type { KernelToInteractionEvent, KernelToWorkflowEvent };

// --- Kernel core and Supervisor --------------------------------------------------------------

/** Implemented by the Supervisor. */
export interface SupervisorPort {
  /** Returns once the request is accepted, not when the execution ends. */
  execute(request: ExecutionRequest): Promise<void>;
  cancelRun(request: CancelRunExecutionsRequest): Promise<void>;
  /** Cancels one execution; its fact says why (PAUSED or ABORTED). */
  cancelExecution(request: CancelExecutionRequest): Promise<void>;
  /** Reads or stops a background command (Orchestration 6.2). */
  controlJob(request: JobControlRequest): Promise<JobControlResult>;
  shutdown(request: SupervisorShutdownRequest): Promise<void>;
}

export interface ExecutorInputByKind {
  readonly REPOSITORY_ORIENT: OrientExecutorInput;
  readonly REPOSITORY_SEARCH: SearchExecutorInput;
  readonly REPOSITORY_LIST: RepositoryListInput;
  readonly FILE_READ: FileReadInput;
  readonly CONTEXT_ASSEMBLE: AssembleExecutorInput;
  readonly CONTEXT_PRUNE: PruneExecutorInput;
  readonly MODEL: ModelExecutorInput;
  readonly FILE_WRITE: FileWriteInput;
  readonly FILE_EDIT: FileEditInput;
  readonly OUTPUT_READ: OutputReadExecutorInput;
  readonly COMMAND: CommandExecutorInput;
  readonly GIT_INSPECT: GitInspectInput;
  readonly WEB_SEARCH: WebSearchInput;
  readonly WEB_FETCH: WebFetchInput;
}

/**
 * Only `rg`, for REPOSITORY_SEARCH, and `git`, for Execution's snapshots, may be run. `env` is what
 * the process gets besides PATH, so a repository's or a user's git settings cannot reach it.
 */
export interface SubprocessRunner {
  run(
    command: 'rg' | 'git',
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly signal: AbortSignal;
      readonly maxOutputBytes: number;
      readonly env?: Readonly<Record<string, string>>;
      readonly stdin?: string;
      /** How `stdout` comes back; `base64` for what may not be text. */
      readonly encoding?: 'utf8' | 'base64';
    },
  ): Promise<{
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly truncated: boolean;
  }>;
}

export interface WorkspaceFile {
  /** Relative to the repository root, `/`-separated. */
  readonly path: string;
  readonly size: number;
}

/**
 * The repository as Execution's snapshots and undo see it; implemented by ExecutorSet. Nothing
 * follows a link, and a write lands by rename.
 */
export interface WorkspaceFiles {
  /** Regular files only, the given exclusion rules left out. */
  list(rules: readonly string[]): Promise<readonly WorkspaceFile[]>;
  /** Undefined when the file is not there. */
  read(path: string): Promise<Buffer | undefined>;
  /** An existing file keeps its other permission bits; the snapshot decides `executable`. */
  write(path: string, content: Buffer, executable: boolean): Promise<void>;
  /** Also removes the directories this leaves empty. */
  remove(path: string): Promise<void>;
}

/** The shadow git directory, by names relative to it. */
export interface ShadowFiles {
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Only MODEL uses it; the key never enters outputs, logs or artifacts. */
export interface ProviderCredentials {
  apiKeyFor(provider: string): string | undefined;
}

/**
 * Why a command was not started. The Supervisor decides these, from what it checks again before it
 * starts anything (Interface/KernelSupervisor 3, 6).
 */
export type SandboxRefusal =
  'APPROVAL_MISMATCH' | 'ENV_ASSERTION_FAILED' | 'SANDBOX_UNAVAILABLE' | 'WORKDIR_INVALID';

export type SandboxRunResult =
  | {
      readonly kind: 'RAN';
      readonly exitCode: number | null;
      readonly signal: string | null;
      /** stdout and stderr in the order they came; the head and the tail when it was cut. */
      readonly output: string;
      readonly truncated: boolean;
      readonly timedOut: boolean;
      readonly denials: number;
      readonly backend: SandboxBackend;
    }
  /**
   * The command runs on as a job (Orchestration 6.1): it was asked to detach, at once or at its
   * timeout. `output` is what it printed until then. The runner hands `process` over; the
   * Supervisor's job table keeps it and fills in `jobKey` before the Executor sees the result.
   */
  | {
      readonly kind: 'DETACHED';
      readonly output: string;
      readonly backend: SandboxBackend;
      readonly promoted: boolean;
      readonly process?: DetachedProcess;
      readonly jobKey?: string;
    }
  | { readonly kind: 'REFUSED'; readonly reason: SandboxRefusal };

/** How a detached command ended. */
export interface DetachedExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Stopped on request (`job_kill`, the end of its task or of the run) or at its longest time. */
  readonly stopped: boolean;
  /** It was asked to stop and did not confirm it: a fault, like STOP_UNCONFIRMED. */
  readonly unconfirmed: boolean;
}

/** A command that runs on after its execution ended; only the Supervisor's job table holds one. */
export interface DetachedProcess {
  /** Everything it prints from now on; set once, right after the hand-over. */
  onOutput(listener: (chunk: Buffer) => void): void;
  onExit(listener: (exit: DetachedExit) => void): void;
  /** SIGTERM, then SIGKILL; the exit says whether it was confirmed. Safe to repeat. */
  stop(): void;
}

/**
 * Runs one command in the sandbox of its scope. Only the Executor of COMMAND gets a working one.
 * When the process cannot be confirmed stopped it throws `StopUnconfirmedError`, which the
 * Supervisor turns into a STOP_UNCONFIRMED fact.
 */
export interface SandboxRunner {
  run(options: {
    readonly scope: SandboxScope;
    readonly command: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal: AbortSignal;
    /**
     * Detach instead of waiting (Orchestration 6.1): 0 right after it starts; at `timeoutMs` when
     * `promoteOnTimeout`, instead of stopping it. Only a runner that has a job table honours it.
     */
    readonly detach?: { readonly immediately: boolean; readonly promoteOnTimeout: boolean };
  }): Promise<SandboxRunResult>;
}

/** What every execution but COMMAND gets: nothing runs, whatever is asked. */
export const DENY_SANDBOX: SandboxRunner = {
  run: () => Promise.resolve({ kind: 'REFUSED', reason: 'SANDBOX_UNAVAILABLE' }),
};

export class StopUnconfirmedError extends Error {
  public constructor(
    public readonly pid: number | undefined,
    message = 'a command could not be confirmed stopped',
  ) {
    super(message);
    this.name = 'StopUnconfirmedError';
  }
}

/**
 * What a model call may say while it runs, for the person watching (docs/M2/Phase1Console.md 4).
 * It is best effort and never part of the result: an Executor calls it without waiting, ignores
 * anything it throws, and works the same when it is absent.
 */
export type ModelProgressEvent =
  /** A piece of the thinking. */
  | { readonly kind: 'REASONING'; readonly delta: string }
  /** The model has begun its answer for the user (its text is not passed on, only that it began). */
  | { readonly kind: 'ANSWER' }
  /** The model is writing the call of a tool, and the file it names once that has been written. */
  | { readonly kind: 'TOOL'; readonly name: string; readonly target?: string }
  | { readonly kind: 'END' };

export interface ExecutorEnvironment {
  readonly scope: ExecutionScope;
  readonly limits: ExecutionLimits;
  /** Fires at the deadline or when the run is cancelled. */
  readonly signal: AbortSignal;
  readonly subprocess: SubprocessRunner;
  readonly sandbox: SandboxRunner;
  readonly credentials: ProviderCredentials;
  /** Only the MODEL Executor gets one; present means the caller wants the call streamed. */
  readonly progress?: (event: ModelProgressEvent) => void;
  now(): Date;
}

/**
 * TERMINATED and STOP_UNCONFIRMED are decided by the Supervisor, never by an Executor. A tool's
 * result carries its preview and, when that cut something, the full output; a model's carries
 * its thinking. A failure may say when to retry (`retryAfterMs`).
 */
export type ExecutorOutcome =
  | {
      readonly outcome: 'COMPLETED';
      readonly result: ExecutionResult;
      readonly usage?: TokenUsage;
      readonly requestState?: RequestState;
    }
  | { readonly outcome: 'REJECTED'; readonly reasonCode: ExecutorRejectedCode }
  | {
      readonly outcome: 'FAILED';
      readonly reasonCode: ExecutorFailedCode;
      readonly retryable: boolean;
      readonly usage?: TokenUsage;
      readonly requestState?: RequestState;
      readonly retryAfterMs?: number;
    }
  | { readonly outcome: 'VIOLATION'; readonly reasonCode: ViolationCode };

/** Implemented by ExecutorSet and called by the Supervisor. */
export interface Executor<K extends ExecutorKind> {
  readonly executionKind: K;
  execute(
    input: ExecutorInputByKind[K],
    environment: ExecutorEnvironment,
  ): Promise<ExecutorOutcome>;
}

/** One Executor per kind; built by `createExecutorRegistry()` and injected into the Supervisor. */
export type ExecutorRegistry = { readonly [K in ExecutorKind]: Executor<K> };

// --- AgentToolPool ---------------------------------------------------------------------------

/**
 * Read-only access to AgentToolPool definitions. Returned values are deeply frozen.
 * Errors use CATALOG_ERROR_CODES: lookupInvalid, definitionNotFound, versionNotFound and
 * definitionUnavailable (QUARANTINED or REVOKED).
 */
export interface CatalogPort {
  /**
   * Exact lookup by kind, id and version. The generic `K` ties the result type to the kind
   * asked for: `getDefinition({ kind: 'MODEL', ... })` resolves to a ModelDefinition.
   */
  getDefinition<K extends DefinitionKind>(
    lookup: DefinitionLookup & { readonly kind: K },
    context: BoundaryContext,
  ): Promise<PortResult<DefinitionByKind[K]>>;
  /**
   * Resolves an agent version and its whole closure (model, prompt, units, tools) once. The
   * caller must use only the returned set, never look definitions up again.
   */
  pinAgent(
    request: AgentPinRequest,
    context: BoundaryContext,
  ): Promise<PortResult<PinnedDefinitionSet>>;
  capabilities(): readonly CapabilityDescriptor[];
}

export const FABRIC_ADDRESSES = [
  'inbox.workflow',
  'inbox.user-interaction',
  'gateway.admission',
  'gateway.session',
  'kernel-core.execution-facts',
  // The end of background commands (Orchestration 6.4).
  'kernel-core.job-facts',
  // The side channel of streaming model calls (docs/M2/Phase1Console.md 4): lossy by design.
  'kernel-core.model-progress',
  'inbox.user-interaction-stream',
] as const;
export type FabricAddress = (typeof FABRIC_ADDRESSES)[number];

/**
 * One client per communication subject. `schemaId` is a registered Schema ID such as
 * `kernel.unit.SubmitUnitRequest.v1`; the payload is validated against it and copied on every
 * delivery. The client fixes `producer`, `messageId` and `occurredAt` of the Envelope.
 */
export interface FabricPort {
  register<TRequest, TResponse>(
    schemaId: string,
    handler: (envelope: Envelope<TRequest>) => Promise<TResponse>,
    /** Only Gateway syscall routes may turn a malformed body with a valid requestId into a rejection. */
    onInvalid?: (envelope: Envelope<unknown>, error: ContractValidationError) => Promise<TResponse>,
  ): void;
  /** Waits for the handler's response. */
  request<TRequest, TResponse>(
    schemaId: string,
    payload: TRequest,
    context: BoundaryContext,
  ): Promise<TResponse>;
  /** Returns once the message entered the receiver's queue. */
  send<T>(
    address: FabricAddress,
    schemaId: string,
    payload: T,
    context: BoundaryContext,
  ): Promise<void>;
  subscribe<T>(address: FabricAddress, handler: (envelope: Envelope<T>) => Promise<void>): void;
  capabilities(): readonly CapabilityDescriptor[];
}

export const MODULE_IDS = [
  'fabric',
  'artifact-store',
  'persistence',
  'supervisor',
  'kernel-core',
  'gateway',
  'workflow',
  'user-interaction',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export interface HealthStatus {
  readonly status: 'UP' | 'DOWN' | 'DEGRADED';
  readonly checkedAt: string;
  readonly details: readonly string[];
}

export interface LifecyclePort {
  readonly manifest: {
    readonly moduleId: ModuleId;
    readonly version: string;
    readonly dependencies: readonly ModuleId[];
  };
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<HealthStatus>;
}

/**
 * A fault that no run can absorb. Only the composition root
 * receives it; the original error stays in local diagnostics and never crosses a subject.
 */
export interface SystemFault {
  /** The module that caught it, or the entry or process guard of the composition root. */
  readonly source: string;
  readonly phase: 'BOOT' | 'RUN' | 'SHUTDOWN';
  readonly error: unknown;
  readonly workflowRunId?: string;
}

/**
 * The system fault entry the composition root hands to a module. A plain function, not a
 * Fabric message and not a registered Schema: it starts a bounded shutdown and never throws.
 */
export type SystemFaultReporter = (fault: SystemFault) => void;

/** Injected into Workflow only. */
export interface WorkflowGatewayPort {
  registerAgentRun(
    request: RegisterAgentRunRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  reserveDelegation(
    request: ReserveDelegationRequest,
    context: BoundaryContext,
  ): Promise<DelegationReserved | SyscallRejected>;
  releaseDelegation(
    request: ReleaseDelegationRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  /** Wakes a sleeping task after some seconds, within the run (Orchestration 8.5). */
  scheduleWake(
    request: ScheduleWakeRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  /** Asks for a checkpoint; `CheckpointTaken` answers it (Orchestration 7.3). */
  takeCheckpoint(
    request: TakeCheckpointRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  /** Cancels the queued and running work of one AgentRun (Orchestration 5.1, 5.2). */
  haltAgentRun(
    request: HaltAgentRunRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  /** Opens again a task that ended after a rewind's cut (Orchestration 7.5). */
  restoreMission(
    request: RestoreMissionRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  /** Closes a sleeping task that will not wake (Orchestration 5.1, 7.5). */
  closeMission(
    request: CloseMissionRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  /** Reads or stops a background command of a task (Orchestration 6.2). */
  controlJob(
    request: ControlJobRequest,
    context: BoundaryContext,
  ): Promise<JobControlContent | SyscallRejected>;
  /** Keeps the results of a handover for the whole Session (Kernel/Core 5g). */
  retainArtifacts(
    request: RetainArtifactsRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  /** The material of a compaction, as Kernel asked for it with `CompactionSourceQuery`. */
  reportCompactionSource(
    request: ReportCompactionSourceRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  /** The result of a compaction is in the log, or could not be put there. */
  ackCompaction(
    request: AckCompactionRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  submitUnit(
    request: SubmitUnitRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  endAgentRun(
    request: EndAgentRunRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  closeRun(
    request: CloseRunRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  requestHuman(
    request: RequestHumanRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  updateActivity(
    request: UpdateActivityRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  readProjectFile(
    request: ReadProjectFileRequest,
    context: BoundaryContext,
  ): Promise<ProjectFileContent | SyscallRejected>;
  reportSessionCommand(
    request: ReportSessionCommandRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  reportSessionList(
    request: ReportSessionListRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
}

/** Injected into UserInteraction only. */
export interface InteractionGatewayPort {
  startSession(
    request: StartSessionRequest,
    context: BoundaryContext,
  ): Promise<SessionAccepted | SyscallRejected>;
  openSession(
    request: OpenSessionRequest,
    context: BoundaryContext,
  ): Promise<SessionAccepted | SyscallRejected>;
  startRun(
    request: StartRunRequest,
    context: BoundaryContext,
  ): Promise<SessionAccepted | SyscallRejected>;
  listSessions(
    request: ListSessionsRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  deleteSession(
    request: DeleteSessionRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  answerAuthorization(
    request: AnswerAuthorizationRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  answerHuman(
    request: AnswerHumanRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  readArtifact(
    request: ReadArtifactRequest,
    context: BoundaryContext,
  ): Promise<ArtifactContent | SyscallRejected>;
  pauseRun(
    request: PauseRunRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  resumeRun(
    request: ResumeRunRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  interruptRun(
    request: InterruptRunRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  steerRun(
    request: SteerRunRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  /** `/compact`: only while the run awaits input. */
  compactContext(
    request: CompactContextRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  undo(request: UndoRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  /** `/recover`: the long task the last process left goes on (Orchestration 7.6). */
  recoverRun(
    request: RecoverRunRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  confirmUndo(
    request: ConfirmUndoRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  diff(request: DiffRequest, context: BoundaryContext): Promise<CheckpointDiff | SyscallRejected>;
  /** Goes back to a checkpoint of the paused run (Orchestration 7.5). */
  rewindCheckpoint(
    request: RewindCheckpointRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  /** The checkpoints of the Session (Orchestration 7.4); looking changes nothing. */
  listCheckpoints(
    request: ListCheckpointsRequest,
    context: BoundaryContext,
  ): Promise<CheckpointList | SyscallRejected>;
  shutdown(
    request: ShutdownRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
}

export const PERSISTENCE_NAMESPACES = ['workflow', 'kernel-core', 'kernel-execution'] as const;
export type PersistenceNamespace = (typeof PERSISTENCE_NAMESPACES)[number];

export type StoragePath =
  | {
      readonly scope: 'SYSTEM';
      readonly file:
        | 'session-index'
        | 'session-refs'
        | 'trusted-instructions'
        | 'trusted-web-search'
        | 'memory-events'
        | 'shutdown-requests';
    }
  | {
      readonly scope: 'SESSION';
      readonly sessionId: string;
      readonly file: 'log' | 'audit' | 'artifact-owners' | 'snapshot-index';
    };

export interface AppendLogPort<T> {
  /** Returns only after the line is written and fsynced. */
  append(record: T): Promise<void>;
  /** Validates every line against the Schema. */
  readAll(): AsyncIterable<T>;
  /** Cuts back to the last complete line; 0 when nothing was incomplete. */
  repairTail(): Promise<{ readonly truncatedBytes: number }>;
}

export type LockResult =
  | { readonly outcome: 'ACQUIRED'; release(): Promise<void> }
  | { readonly outcome: 'HELD'; readonly owner: InstanceLockInfo | SessionLockInfo };

export interface SessionDirectoryPort {
  create(): Promise<void>;
  /** A fork: copies the other Session's whole log into this one. */
  copyLogFrom(fromSessionId: string): Promise<void>;
  remove(): Promise<void>;
  /** Provided in the `workflow` namespace only. */
  lock(): Promise<LockResult>;
}

/** Limited to one namespace by the composition root; a foreign path is refused on the spot. */
export interface SessionPersistencePort {
  appendLog<T>(namespace: PersistenceNamespace, path: StoragePath): AppendLogPort<T>;
  sessionDirectory(namespace: PersistenceNamespace, sessionId: string): SessionDirectoryPort;
  capabilities(): readonly CapabilityDescriptor[];
}

/** Injected into the composition root only. */
export interface InstanceLockPort {
  acquire(): Promise<LockResult>;
  /** May be called repeatedly. */
  release(): Promise<void>;
}

/** Global and content-addressed; Execution records who owns what (Infrastructure/ArtifactStore). */
export interface ArtifactStorePort {
  put(content: Uint8Array, mediaType: string): Promise<ArtifactRef>;
  /** Verifies sha256 and size again and throws instead of returning damaged content. */
  get(ref: ArtifactRef): Promise<Uint8Array>;
  /** Removes bodies outside `retained` last written before `olderThan`. */
  sweep(input: {
    readonly retained: ReadonlySet<string>;
    readonly olderThan: string;
  }): Promise<{ readonly removed: number }>;
  capabilities(): readonly CapabilityDescriptor[];
}
