import type {
  ArtifactRef,
  ExecutionOutcome,
  ExecutionScope,
  PinnedDefinitionSet,
  RequestState,
  UnitDefinition,
  UnitInput,
} from '@multiagentos/contracts';

/** The lifecycle of one accepted submitUnit inside Execution. */
export type AttemptState = 'QUEUED' | 'STARTING' | 'DISPATCHED' | 'CHECKED' | 'ABORTED';

/** One dispatch of a UnitAttempt. Technical retries create a new record. */
export interface ExecutionRecord {
  readonly executionId: string;
  /** Back-off of a technical retry; the Supervisor starts the Executor only after it. */
  notBefore?: string;
  dispatchedAt?: string;
  outcome?: ExecutionOutcome;
  requestState?: RequestState;
}

/**
 * Execution's per-attempt state. The queue and Core own their own records; this object only
 * contains what Execution needs to dispatch, settle and report a Unit.
 */
export interface UnitAttempt {
  readonly unitAttemptId: string;
  readonly requestId: string;
  readonly agentRunId: string;
  readonly unit: UnitDefinition;
  readonly input: UnitInput;
  readonly scope: ExecutionScope;
  readonly pinned: PinnedDefinitionSet;
  readonly runEpoch: number;
  state: AttemptState;
  readonly executions: ExecutionRecord[];
  retryCount: number;
  reservationId?: string;
  grantId?: string;
  outputRef?: ArtifactRef;
}
