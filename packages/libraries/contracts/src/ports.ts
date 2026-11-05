import type { RepositoryListInput } from './executor/repository-list.js';
import type { FileEditInput, FileWriteInput } from './executor/file-write.js';
import type { CommandExecutorInput, GitInspectInput } from './executor/command.js';
import type { SandboxBackend, SandboxScope } from './platform-common/sandbox.js';
import type { ExecutionResult } from './kernel-execution/execution-fact.js';
import type {
  AssembleExecutorInput,
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
  ConfirmUndoRequest,
  DiffTurnsRequest,
  ReadArtifactRequest,
  TurnDiff,
  UndoTurnsRequest,
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
  RegisterAgentRunRequest,
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
  shutdown(request: SupervisorShutdownRequest): Promise<void>;
}

export interface ExecutorInputByKind {
  readonly REPOSITORY_ORIENT: OrientExecutorInput;
  readonly REPOSITORY_SEARCH: SearchExecutorInput;
  readonly REPOSITORY_LIST: RepositoryListInput;
  readonly FILE_READ: FileReadInput;
  readonly CONTEXT_ASSEMBLE: AssembleExecutorInput;
  readonly MODEL: ModelExecutorInput;
  readonly FILE_WRITE: FileWriteInput;
  readonly FILE_EDIT: FileEditInput;
  readonly OUTPUT_READ: OutputReadExecutorInput;
  readonly COMMAND: CommandExecutorInput;
  readonly GIT_INSPECT: GitInspectInput;
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
  | { readonly kind: 'REFUSED'; readonly reason: SandboxRefusal };

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

export interface ExecutorEnvironment {
  readonly scope: ExecutionScope;
  readonly limits: ExecutionLimits;
  /** Fires at the deadline or when the run is cancelled. */
  readonly signal: AbortSignal;
  readonly subprocess: SubprocessRunner;
  readonly sandbox: SandboxRunner;
  readonly credentials: ProviderCredentials;
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
  undoTurns(
    request: UndoTurnsRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  confirmUndo(
    request: ConfirmUndoRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  diffTurns(
    request: DiffTurnsRequest,
    context: BoundaryContext,
  ): Promise<TurnDiff | SyscallRejected>;
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
      readonly file: 'session-index' | 'session-refs' | 'trusted-instructions' | 'memory-events';
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
