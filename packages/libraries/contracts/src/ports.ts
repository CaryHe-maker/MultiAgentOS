import type { RepositoryListInput } from './executor/repository-list.js';
import type { ExecutionResultV1 } from './kernel-execution/execution-fact.js';
import type {
  AssembleExecutorInputV1,
  ExecutionLimitsV1,
  ModelExecutorInputV1,
} from './kernel-execution/execution-request.js';
import type { ExecutorKindV1 } from './platform-common/execution-kind.js';
import type {
  AgentPinRequest,
  DefinitionLookup,
  PinnedDefinitionSet,
} from './catalog/catalog-schemas.js';
import type { DefinitionByKind, DefinitionKind } from './catalog/definition-schemas.js';
import type { TokenUsage } from './executor/model-call.js';
import type {
  AnswerAuthorizationRequestV1,
  AnswerHumanRequest,
  ReadArtifactRequestV1,
} from './kernel-control/interaction-requests.js';
import type { SessionAccepted, SyscallRejectedV1 } from './kernel-control/responses.js';
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
  CloseRunRequestV1,
  EndAgentRunRequestV1,
  ProjectFileContent,
  ReadProjectFileRequest,
  RegisterAgentRunRequestV1,
  RequestHumanRequest,
  SubmitUnitRequestV1,
} from './kernel-unit/workflow-syscalls.js';
import type { BoundaryContextV1 } from './platform-common/common-schemas.js';
import type { InstanceLockInfo, SessionLockInfo } from './platform-persistence/locks.js';
import type { FileReadInput } from './executor/file-read.js';
import type {
  KernelToInteractionEvent,
  InteractionInboxEvent,
} from './kernel-control/interaction-events.js';
import type {
  AnswerAuthorizationRequest,
  CancelRunRequest,
  CreateRunRequest,
  ReadArtifactRequest,
  ShutdownRequest,
} from './kernel-control/interaction-requests.js';
import type {
  ArtifactContent,
  RunCreated,
  SyscallAck,
  SyscallRejected,
} from './kernel-control/responses.js';
import type {
  ExecutionFact,
  ExecutionResult,
  RequestState,
} from './kernel-execution/execution-fact.js';
import type {
  AssembleExecutorInput,
  ExecutionLimits,
  ExecutionRequest,
  ExecutionScope,
  ModelExecutorInput,
  OrientExecutorInput,
  SearchExecutorInput,
} from './kernel-execution/execution-request.js';
import type {
  CancelRunExecutionsRequest,
  SupervisorShutdownRequest,
} from './kernel-execution/supervisor-requests.js';
import type { KernelToWorkflowEvent, WorkflowInboxEvent } from './kernel-unit/workflow-events.js';
import type {
  CloseRunRequest,
  EndAgentRunRequest,
  RegisterAgentRunRequest,
  SubmitUnitRequest,
} from './kernel-unit/workflow-syscalls.js';
import type {
  ArtifactRef,
  BoundaryContext,
  CapabilityDescriptor,
  EnvelopeV1,
  ModuleError,
} from './platform-common/common-schemas.js';
import type { ContractValidationError } from './platform-common/validation.js';
import type { ExecutorKind } from './platform-common/execution-kind.js';
import type {
  ExecutorFailedCode,
  ExecutorRejectedCode,
  ViolationCode,
} from './platform-common/reason-code.js';

/** Return value of the synchronous Ports (M1Interface 3.3). */
export type PortResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ModuleError };

// --- Gateway ports (M1Interface 4.1) ---------------------------------------------------------

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
}

/** Injected into UserInteraction only. */
export interface InteractionGatewayPort {
  createRun(
    request: CreateRunRequest,
    context: BoundaryContext,
  ): Promise<RunCreated | SyscallRejected>;
  answerAuthorization(
    request: AnswerAuthorizationRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  cancelRun(
    request: CancelRunRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
  readArtifact(
    request: ReadArtifactRequest,
    context: BoundaryContext,
  ): Promise<ArtifactContent | SyscallRejected>;
  shutdown(
    request: ShutdownRequest,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected>;
}

// --- Inbox ports (M1Interface 5.1) -----------------------------------------------------------

export interface InboxEvent<T> {
  readonly eventId: string;
  readonly workflowRunId: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly event: T;
}

/** Implemented by the receiver. `deliver` validates and enqueues; it does not process. */
export interface InboxPort<E extends InboxEvent<unknown>> {
  deliver(event: E): Promise<void>;
}
export type WorkflowInboxPort = InboxPort<WorkflowInboxEvent>;
export type InteractionInboxPort = InboxPort<InteractionInboxEvent>;
export type { KernelToInteractionEvent, KernelToWorkflowEvent };

// --- Kernel core and Supervisor (M1Interface 7.4) ---------------------------------------------

/** Implemented by the Supervisor. */
export interface SupervisorPort {
  /** Returns once the request is accepted, not when the execution ends. */
  execute(request: ExecutionRequest): Promise<void>;
  cancelRun(request: CancelRunExecutionsRequest): Promise<void>;
  shutdown(request: SupervisorShutdownRequest): Promise<void>;
}

/** Implemented by the Kernel core. Returning means the fact entered the run Inbox. */
export interface ExecutionFactSink {
  report(fact: ExecutionFact): Promise<void>;
}

// --- ExecutorSet (M1Interface 8) --------------------------------------------------------------

export interface ExecutorInputByKind {
  readonly REPOSITORY_ORIENT: OrientExecutorInput;
  readonly REPOSITORY_SEARCH: SearchExecutorInput;
  readonly FILE_READ: FileReadInput;
  readonly CONTEXT_ASSEMBLE: AssembleExecutorInput;
  readonly MODEL: ModelExecutorInput;
}

export interface ExecutorInputByKindV1 {
  readonly REPOSITORY_ORIENT: OrientExecutorInput;
  readonly REPOSITORY_SEARCH: SearchExecutorInput;
  readonly REPOSITORY_LIST: RepositoryListInput;
  readonly FILE_READ: FileReadInput;
  readonly CONTEXT_ASSEMBLE: AssembleExecutorInputV1;
  readonly MODEL: ModelExecutorInputV1;
}

/** Only `rg` may be run, and only by REPOSITORY_SEARCH. */
export interface SubprocessRunner {
  run(
    command: 'rg',
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly signal: AbortSignal;
      readonly maxOutputBytes: number;
    },
  ): Promise<{
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly truncated: boolean;
  }>;
}

/** Only MODEL uses it; the key never enters outputs, logs or artifacts. */
export interface ProviderCredentials {
  apiKeyFor(provider: string): string | undefined;
}

export interface ExecutorEnvironment {
  readonly scope: ExecutionScope;
  readonly limits: ExecutionLimits;
  /** Fires at the deadline or when the run is cancelled. */
  readonly signal: AbortSignal;
  readonly subprocess: SubprocessRunner;
  readonly credentials: ProviderCredentials;
  now(): Date;
}

export interface ExecutorEnvironmentV1 extends Omit<ExecutorEnvironment, 'limits'> {
  readonly limits: ExecutionLimitsV1;
}

/** As ExecutorOutcome, with previews and thinking in the result and `retryAfterMs` on a failure. */
export type ExecutorOutcomeV1 =
  | {
      readonly outcome: 'COMPLETED';
      readonly result: ExecutionResultV1;
      readonly usage?: TokenUsage;
      readonly requestState?: RequestState;
    }
  | Extract<ExecutorOutcome, { outcome: 'REJECTED' | 'VIOLATION' }>
  | (Extract<ExecutorOutcome, { outcome: 'FAILED' }> & { readonly retryAfterMs?: number });

export interface ExecutorV1<K extends ExecutorKindV1> {
  readonly executionKind: K;
  execute(
    input: ExecutorInputByKindV1[K],
    environment: ExecutorEnvironmentV1,
  ): Promise<ExecutorOutcomeV1>;
}

export type ExecutorRegistryV1 = { readonly [K in ExecutorKindV1]: ExecutorV1<K> };

/** TERMINATED and STOP_UNCONFIRMED are decided by the Supervisor, never by an Executor. */
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
    }
  | {
      readonly outcome: 'VIOLATION';
      readonly reasonCode: ViolationCode;
    };

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

// --- AgentToolPool (M1Interface 9.3) ----------------------------------------------------------

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

// --- Platform ports (M1Interface 10) ----------------------------------------------------------

/** Injected into the Kernel core only and used by Execution. */
export interface ArtifactStorePort {
  put(workflowRunId: string, content: Uint8Array, mediaType: string): Promise<ArtifactRef>;
  /** Verifies sha256 and size again and throws instead of returning damaged content. */
  get(workflowRunId: string, ref: ArtifactRef): Promise<Uint8Array>;
  capabilities(): readonly CapabilityDescriptor[];
}

export const PERSISTENCE_NAMESPACES = ['workflow', 'kernel-core'] as const;
export type PersistenceNamespace = (typeof PERSISTENCE_NAMESPACES)[number];

export interface RepositoryPort<T extends { readonly id: string }> {
  get(id: string): Promise<T | undefined>;
  /** Written to a temporary file first and then renamed atomically. */
  put(record: T): Promise<void>;
}

export interface AuditLogPort<T> {
  /** Appends one line of JSON. */
  append(entry: T): Promise<void>;
}

/** Each Owner gets the ports of its own namespace only. */
export interface PersistencePort {
  repository<T extends { readonly id: string }>(
    namespace: PersistenceNamespace,
    workflowRunId: string,
  ): RepositoryPort<T>;
  auditLog<T>(namespace: PersistenceNamespace, workflowRunId: string): AuditLogPort<T>;
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
 * `kernel.unit.SubmitUnitRequest.v0`; the payload is validated against it and copied on every
 * delivery. The client fixes `producer`, `messageId` and `occurredAt` of the Envelope.
 */
export interface FabricPort {
  register<TRequest, TResponse>(
    schemaId: string,
    handler: (envelope: EnvelopeV1<TRequest>) => Promise<TResponse>,
    /** Only Gateway syscall routes may turn a malformed body with a valid requestId into a rejection. */
    onInvalid?: (
      envelope: EnvelopeV1<unknown>,
      error: ContractValidationError,
    ) => Promise<TResponse>,
  ): void;
  /** Waits for the handler's response. */
  request<TRequest, TResponse>(
    schemaId: string,
    payload: TRequest,
    context: BoundaryContextV1,
  ): Promise<TResponse>;
  /** Returns once the message entered the receiver's queue. */
  send<T>(
    address: FabricAddress,
    schemaId: string,
    payload: T,
    context: BoundaryContextV1,
  ): Promise<void>;
  subscribe<T>(address: FabricAddress, handler: (envelope: EnvelopeV1<T>) => Promise<void>): void;
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
 * A fault that no run can absorb (docs/M1/SystemFaultHandling.md 2). Only the composition root
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

// --- Major 1 (Interface/WorkflowKernel, InteractionKernel, Persistence) ------------------------

export interface RunInboxEvent<T> {
  readonly eventId: string;
  readonly sessionId: string;
  readonly workflowRunId: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly event: T;
}

/** Injected into Workflow only; the M1 port stays until the release, for `analyze`. */
export interface WorkflowGatewayPortV1 {
  registerAgentRun(
    request: RegisterAgentRunRequestV1,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
  submitUnit(
    request: SubmitUnitRequestV1,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
  endAgentRun(
    request: EndAgentRunRequestV1,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
  closeRun(
    request: CloseRunRequestV1,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
  requestHuman(
    request: RequestHumanRequest,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
  readProjectFile(
    request: ReadProjectFileRequest,
    context: BoundaryContextV1,
  ): Promise<ProjectFileContent | SyscallRejectedV1>;
  reportSessionCommand(
    request: ReportSessionCommandRequest,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
  reportSessionList(
    request: ReportSessionListRequest,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
}

/** Injected into UserInteraction only. */
export interface InteractionGatewayPortV1 {
  startSession(
    request: StartSessionRequest,
    context: BoundaryContextV1,
  ): Promise<SessionAccepted | SyscallRejectedV1>;
  openSession(
    request: OpenSessionRequest,
    context: BoundaryContextV1,
  ): Promise<SessionAccepted | SyscallRejectedV1>;
  startRun(
    request: StartRunRequest,
    context: BoundaryContextV1,
  ): Promise<SessionAccepted | SyscallRejectedV1>;
  listSessions(
    request: ListSessionsRequest,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
  deleteSession(
    request: DeleteSessionRequest,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
  answerAuthorization(
    request: AnswerAuthorizationRequestV1,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
  answerHuman(
    request: AnswerHumanRequest,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
  readArtifact(
    request: ReadArtifactRequestV1,
    context: BoundaryContextV1,
  ): Promise<ArtifactContent | SyscallRejectedV1>;
  shutdown(
    request: ShutdownRequest,
    context: BoundaryContextV1,
  ): Promise<SyscallAck | SyscallRejectedV1>;
}

export const PERSISTENCE_NAMESPACES_V1 = ['workflow', 'kernel-core', 'kernel-execution'] as const;
export type PersistenceNamespaceV1 = (typeof PERSISTENCE_NAMESPACES_V1)[number];

export type StoragePath =
  | {
      readonly scope: 'SYSTEM';
      readonly file: 'session-index' | 'session-refs' | 'trusted-instructions';
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
  remove(): Promise<void>;
  /** Provided in the `workflow` namespace only. */
  lock(): Promise<LockResult>;
}

/** Limited to one namespace by the composition root; a foreign path is refused on the spot. */
export interface SessionPersistencePort {
  appendLog<T>(namespace: PersistenceNamespaceV1, path: StoragePath): AppendLogPort<T>;
  sessionDirectory(namespace: PersistenceNamespaceV1, sessionId: string): SessionDirectoryPort;
  capabilities(): readonly CapabilityDescriptor[];
}

/** Injected into the composition root only. */
export interface InstanceLockPort {
  acquire(): Promise<LockResult>;
  /** May be called repeatedly. */
  release(): Promise<void>;
}

/** Global and content-addressed; Execution records who owns what (Infrastructure/ArtifactStore). */
export interface ArtifactStorePortV1 {
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
