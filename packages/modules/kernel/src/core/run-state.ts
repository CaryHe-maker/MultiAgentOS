import type {
  ArtifactRef,
  CloseReason,
  ExecutionScope,
  PinnedDefinitionRef,
  PinnedDefinitionSet,
  RunFailure,
  UnitDefinition,
  UnitInput,
} from '@multiagentos/contracts';
import { RequestLedger } from './request-ledger.js';

export interface AgentRunRecord {
  readonly agentRunId: string;
  readonly agentRef: PinnedDefinitionRef;
  /** Frozen definition closure captured by `registerAgentRun`. */
  readonly pinned: PinnedDefinitionSet;
  state: 'ACTIVE' | 'ENDED';
  readonly registeredAt: string;
  endedAt?: string;
  /** Delivered OK/FAILED model-call UnitReports; completed in stage 1.4. */
  rounds: number;
}

export type UnitDecision =
  | { readonly kind: 'ALLOWED'; readonly scope: ExecutionScope }
  | { readonly kind: 'PENDING'; readonly questionId: string }
  | { readonly kind: 'DECLINED'; readonly reasonCode: 'USER_DECLINED' }
  | { readonly kind: 'CANCELLED' };

export interface AwaitingAuthorization {
  readonly unit: UnitDefinition;
  readonly input: UnitInput;
  readonly agentRunId: string;
  readonly questionId: string;
}

export interface UnitCounters {
  submitted: number;
  ok: number;
  rejected: number;
  failed: number;
  notDelivered: number;
}

/**
 * The control part of a run's Core state block (docs/M1/Kernel/Interaction.md 4.2).
 * Stage 1.2 adds request records and AgentRun registration; later stages add Lease,
 * authorization and Outbox records to the same per-run state.
 */
export interface RunState {
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly goal: string;
  /** Real path of the repository root, resolved by Core when the run is created. */
  readonly repositoryRoot: string;
  readonly startedAt: string;
  runState: 'RUNNING' | 'CONVERGING' | 'CLOSED';
  /** Increases once, when the run enters CONVERGING. */
  runEpoch: number;
  closeReason?: CloseReason;
  failure?: RunFailure;
  reportRef?: ArtifactRef;
  convergingAt?: string;
  closedAt?: string;
  /** Executions that have been dispatched and have not reported a terminal fact yet. */
  readonly pendingExecutions: {
    unitAttemptId: string;
    executionId: string;
  }[];
  readonly requests: RequestLedger;
  readonly agentRuns: Map<string, AgentRunRecord>;
  readonly unitDecisions: Map<string, UnitDecision>;
  readonly awaitingAuthorization: Map<string, AwaitingAuthorization>;
  readonly units: UnitCounters;
}

export interface NewRunState {
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly goal: string;
  readonly repositoryRoot: string;
  readonly startedAt: string;
}

export function createRunState(input: NewRunState): RunState {
  return {
    ...input,
    runState: 'RUNNING',
    runEpoch: 1,
    pendingExecutions: [],
    requests: new RequestLedger(),
    agentRuns: new Map(),
    unitDecisions: new Map(),
    awaitingAuthorization: new Map(),
    units: { submitted: 0, ok: 0, rejected: 0, failed: 0, notDelivered: 0 },
  };
}
