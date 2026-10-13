/**
 * Kernel-private interfaces of docs/M1/Kernel/Interaction.md 3.4 and `KernelConfig`
 * (Interaction 9). Components depend on these types, never on each other, and none of them
 * enters `@multiagentos/contracts`. `reservationId` (prefix `rsv`) comes from Monitor and
 * `grantId` (prefix `grt`) from Scheduler; neither leaves the Kernel core.
 */
import type {
  ArtifactContent,
  ArtifactRef,
  BoundaryContext,
  BudgetState,
  ExecutionFact,
  ExecutionOutcome,
  ExecutionScope,
  GatewayForward,
  PinnedDefinitionSet,
  ReasonCode,
  RequestState,
  RunCreated,
  RunSummary,
  SyscallAck,
  SyscallRejected,
  TokenUsage,
  UnitDefinition,
  UnitInput,
  UnitOutput,
  UnknownEffect,
} from '@multiagentos/contracts';

export * from './kernel-config.js';

// --- Execution -> Core: internal syscalls -----------------------------------------------------

export type ReservationDecision =
  | { readonly granted: true; readonly reservationId: string; readonly grantId: string }
  | {
      readonly granted: false;
      /** For the three budget reasons Core has already delivered the UnitReport. */
      readonly reason: 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED' | 'FINAL_CALL_USED' | 'RUN_CONVERGING';
    };

export type RetryDecision =
  | { readonly allowed: true; readonly reservationId?: string; readonly grantId?: string }
  | {
      readonly allowed: false;
      readonly reason:
        | 'RUN_CONVERGING'
        | 'RETRY_LIMIT'
        | 'REQUEST_MAY_BE_SENT'
        | 'BUDGET_WRAP_UP'
        | 'BUDGET_EXHAUSTED';
    };

export interface ResultCheck {
  readonly unitAttemptId: string;
  /** Absent when the attempt ended before it was dispatched. */
  readonly executionId?: string;
  readonly outcome: ExecutionOutcome | 'NOT_DISPATCHED';
  readonly reasonCode?: ReasonCode;
  readonly output?: UnitOutput;
  readonly outputRef?: ArtifactRef;
  readonly usage?: TokenUsage;
  readonly requestState?: RequestState;
  /** Who decided a STOP_UNCONFIRMED. */
  readonly stopVerdictBy?: 'SUPERVISOR' | 'CORE';
}

/** A Core-owned projection of the identity needed for a synchronous result decision. */
export interface AttemptRegistration {
  readonly unitAttemptId: string;
  readonly requestId: string;
  readonly agentRunId: string;
  readonly runEpoch: number;
  readonly executionKind: UnitDefinition['executionKind'];
  readonly requiresLease: boolean;
}

export interface ExecutionRegistration {
  readonly unitAttemptId: string;
  readonly executionId: string;
  readonly runEpoch: number;
}

export interface CoreSyscalls {
  /** Must precede reservation or any result check, including an in-process built-in Unit. */
  registerAttempt(attempt: AttemptRegistration): void;
  /** Must precede registration of a Supervisor.execute message for this executionId. */
  registerExecution(execution: ExecutionRegistration): void;
  requestReservation(request: {
    readonly unitAttemptId: string;
    readonly estimatedTokens: number;
    readonly final: boolean;
  }): ReservationDecision;
  /** Synchronous on purpose: nothing can run between the runEpoch check and the Outbox. */
  submitResultCheck(check: ResultCheck): void;
  retryExecution(request: {
    readonly unitAttemptId: string;
    readonly previousExecutionId: string;
    readonly requestState?: RequestState;
  }): RetryDecision;
  currentRunEpoch(): number;
}

// --- Core -> Execution: duties ----------------------------------------------------------------

export interface AttemptSpec {
  readonly requestId: string;
  readonly agentRunId: string;
  readonly unit: UnitDefinition;
  readonly input: UnitInput;
  /** Derived by Core. */
  readonly scope: ExecutionScope;
  /** The definitions pinned for this AgentRun. */
  readonly pinned: PinnedDefinitionSet;
  readonly runEpoch: number;
}

export interface ExecutionDuties {
  /** Returns the unitAttemptId; the attempt joins the FIFO and starts when Execution is idle. */
  createAttempt(spec: AttemptSpec): Promise<string>;
  /** Called by the run actor's dispatch for EXECUTION_FACT, not through Core. */
  handleExecutionFact(fact: ExecutionFact): Promise<void>;
  abortQueued(): {
    readonly inFlight: readonly { readonly unitAttemptId: string; readonly executionId: string }[];
  };
  /** Convergence fallback: a stop that Core judged unconfirmed. */
  synthesizeStopUnconfirmed(executionIds: readonly string[]): void;
  ownsArtifact(ref: ArtifactRef): boolean;
  readArtifact(
    ref: ArtifactRef,
  ): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }>;
  collectUnknownEffects(): UnknownEffect[];
  /** MODEL execution instances dispatched to the Supervisor, technical retries included. */
  modelRequestCount(): number;
  publishRunSummary(summary: RunSummary): Promise<ArtifactRef>;
}

// --- Core -> Monitor: duties ------------------------------------------------------------------

export type Settlement =
  | { readonly type: 'ACTUAL'; readonly usage: TokenUsage }
  | { readonly type: 'NOT_SENT' }
  | { readonly type: 'UNKNOWN' };

export type SettlementAnomaly =
  | {
      readonly type: 'ACTUAL_EXCEEDED_ESTIMATE';
      readonly reservationId: string;
      readonly estimatedTokens: number;
      readonly actualTokens: number;
    }
  | {
      readonly type: 'CONFLICTING_SETTLEMENT';
      readonly reservationId: string;
      readonly previousTokens: number;
      readonly offeredTokens: number;
    };

export interface SettlementResult {
  readonly budgetState: BudgetState;
  readonly anomalies: readonly SettlementAnomaly[];
}

export interface BudgetSummary {
  readonly limit: number;
  readonly used: number;
  readonly unknown: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly finalBudgetState: BudgetState;
}

export interface MonitorDuties {
  reserve(request: {
    readonly estimatedTokens: number;
    readonly final: boolean;
  }):
    | { readonly ok: true; readonly reservationId: string }
    | { readonly ok: false; readonly reasonCode: 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED' };
  /** Idempotent by reservationId. */
  settle(reservationId: string, settlement: Settlement): SettlementResult;
  budgetState(): BudgetState;
  /** Settles what is still reserved as unknown consumption. */
  finalize(): BudgetSummary;
}

// --- Core -> Scheduler: duties ----------------------------------------------------------------

export interface SchedulerDuties {
  acquire(
    provider: string,
  ): { readonly ok: true; readonly grantId: string } | { readonly ok: false };
  /** Idempotent. */
  release(grantId: string): void;
  stopGranting(): void;
  releaseAll(): number;
}

/** Capacity shared by all runs. In M1 it lives in the process, with capacity 1 per provider. */
export interface ProviderCapacityPort {
  /** Returns a token, or null when the provider is busy. */
  tryAcquire(provider: string): string | null;
  release(token: string): void;
}

// --- Run management ---------------------------------------------------------------------------

/** Implements the GatewayForward handler and the ExecutionFactSink. */
export interface RunRegistry {
  handleForward(
    forward: GatewayForward,
    context: Readonly<BoundaryContext>,
  ): Promise<SyscallAck | SyscallRejected | RunCreated | ArtifactContent>;
  report(fact: ExecutionFact): Promise<void>;
}
