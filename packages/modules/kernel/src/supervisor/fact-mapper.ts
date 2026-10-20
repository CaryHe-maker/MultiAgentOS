import type {
  ExecutionFact,
  ExecutionRequest,
  ExecutorOutcome,
  RequestState,
  TokenUsage,
} from '@multiagentos/contracts';

export type TerminationReason = 'UNIT_TIMEOUT' | 'EXECUTION_CANCELLED';
export type TerminationOutcome = 'TERMINATED' | 'STOP_UNCONFIRMED';

export interface TerminationVerdict {
  readonly outcome: TerminationOutcome;
  readonly reasonCode: TerminationReason;
  /** MODEL only; absent means NOT_SENT before start, otherwise UNKNOWN. */
  readonly requestState?: RequestState;
  /** MODEL only, and only for TERMINATED. */
  readonly usage?: TokenUsage;
}

/**
 * Maps an Executor verdict to the one terminal fact of an execution
 * (docs/M1/Kernel/Supervisor.md 4 and M1Interface 7.3).
 *
 * The ExecutionFact union is discriminated by executionKind and outcome. The
 * mapper keeps those two switches explicit; the cast is the necessary bridge
 * between the contract union and the Executor's untied result type.
 */
export function toExecutionFact(
  request: ExecutionRequest,
  startedAt: string,
  endedAt: string,
  outcome: ExecutorOutcome,
): ExecutionFact {
  const base = {
    workflowRunId: request.workflowRunId,
    unitAttemptId: request.unitAttemptId,
    executionId: request.executionId,
    runEpoch: request.runEpoch,
    executionKind: request.executionKind,
    startedAt,
    endedAt,
  };

  if (request.executionKind === 'MODEL') {
    switch (outcome.outcome) {
      case 'COMPLETED':
        return {
          ...base,
          outcome: 'COMPLETED',
          result: outcome.result,
          requestState: 'SENT',
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        } as ExecutionFact;
      case 'REJECTED':
        return {
          ...base,
          outcome: 'REJECTED',
          reasonCode: outcome.reasonCode,
          // A rejection happens before the provider processes the request.
          requestState: 'NOT_SENT' satisfies RequestState,
        } as ExecutionFact;
      case 'FAILED':
        return {
          ...base,
          outcome: 'FAILED',
          reasonCode: outcome.reasonCode,
          retryable: outcome.retryable,
          requestState: outcome.requestState ?? 'UNKNOWN',
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        } as ExecutionFact;
      case 'VIOLATION':
        return {
          ...base,
          outcome: 'VIOLATION',
          reasonCode: outcome.reasonCode,
          requestState: 'UNKNOWN',
        } as ExecutionFact;
    }
  }

  switch (outcome.outcome) {
    case 'COMPLETED':
      return { ...base, outcome: 'COMPLETED', result: outcome.result } as ExecutionFact;
    case 'REJECTED':
      return { ...base, outcome: 'REJECTED', reasonCode: outcome.reasonCode } as ExecutionFact;
    case 'FAILED':
      return {
        ...base,
        outcome: 'FAILED',
        reasonCode: outcome.reasonCode,
        retryable: outcome.retryable,
      } as ExecutionFact;
    case 'VIOLATION':
      return { ...base, outcome: 'VIOLATION', reasonCode: outcome.reasonCode } as ExecutionFact;
  }
}

/**
 * Builds the fact for a deadline or cancellation. A pre-start cancellation has no
 * `startedAt`; every other termination does. STOP_UNCONFIRMED never carries usage.
 */
export function toTerminationFact(
  request: ExecutionRequest,
  startedAt: string | undefined,
  endedAt: string,
  verdict: TerminationVerdict,
): ExecutionFact {
  const base = {
    workflowRunId: request.workflowRunId,
    unitAttemptId: request.unitAttemptId,
    executionId: request.executionId,
    runEpoch: request.runEpoch,
    executionKind: request.executionKind,
    ...(startedAt === undefined ? {} : { startedAt }),
    endedAt,
  };

  if (request.executionKind === 'MODEL') {
    const requestState = verdict.requestState ?? (startedAt === undefined ? 'NOT_SENT' : 'UNKNOWN');
    const usage = verdict.outcome === 'TERMINATED' ? verdict.usage : undefined;
    return {
      ...base,
      outcome: verdict.outcome,
      reasonCode: verdict.reasonCode,
      requestState,
      ...(usage === undefined ? {} : { usage }),
    } as ExecutionFact;
  }

  return {
    ...base,
    outcome: verdict.outcome,
    reasonCode: verdict.reasonCode,
  } as ExecutionFact;
}
