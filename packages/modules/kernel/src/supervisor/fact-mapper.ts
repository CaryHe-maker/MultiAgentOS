import type {
  ExecutionFactV1,
  ExecutionRequestV1,
  ExecutorOutcomeV1,
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
 * (M1 Supervisor 4; major 1 facts carry the Session and `retryAfterMs`).
 *
 * The ExecutionFactV1 union is discriminated by executionKind and outcome. The
 * mapper keeps those two switches explicit; the cast is the necessary bridge
 * between the contract union and the Executor's untied result type.
 */
export function toExecutionFact(
  request: ExecutionRequestV1,
  startedAt: string,
  endedAt: string,
  outcome: ExecutorOutcomeV1,
): ExecutionFactV1 {
  const base = {
    sessionId: request.sessionId,
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
        } as ExecutionFactV1;
      case 'REJECTED':
        return {
          ...base,
          outcome: 'REJECTED',
          reasonCode: outcome.reasonCode,
          // A rejection happens before the provider processes the request.
          requestState: 'NOT_SENT' satisfies RequestState,
        } as ExecutionFactV1;
      case 'FAILED':
        return {
          ...base,
          outcome: 'FAILED',
          reasonCode: outcome.reasonCode,
          retryable: outcome.retryable,
          requestState: outcome.requestState ?? 'UNKNOWN',
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
        } as ExecutionFactV1;
      case 'VIOLATION':
        return {
          ...base,
          outcome: 'VIOLATION',
          reasonCode: outcome.reasonCode,
          requestState: 'UNKNOWN',
        } as ExecutionFactV1;
    }
  }

  switch (outcome.outcome) {
    case 'COMPLETED':
      return { ...base, outcome: 'COMPLETED', result: outcome.result } as ExecutionFactV1;
    case 'REJECTED':
      return { ...base, outcome: 'REJECTED', reasonCode: outcome.reasonCode } as ExecutionFactV1;
    case 'FAILED':
      return {
        ...base,
        outcome: 'FAILED',
        reasonCode: outcome.reasonCode,
        retryable: outcome.retryable,
      } as ExecutionFactV1;
    case 'VIOLATION':
      return { ...base, outcome: 'VIOLATION', reasonCode: outcome.reasonCode } as ExecutionFactV1;
  }
}

/**
 * Builds the fact for a deadline or cancellation. A pre-start cancellation has no
 * `startedAt`; every other termination does. STOP_UNCONFIRMED never carries usage.
 */
export function toTerminationFact(
  request: ExecutionRequestV1,
  startedAt: string | undefined,
  endedAt: string,
  verdict: TerminationVerdict,
): ExecutionFactV1 {
  const base = {
    sessionId: request.sessionId,
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
    } as ExecutionFactV1;
  }

  return {
    ...base,
    outcome: verdict.outcome,
    reasonCode: verdict.reasonCode,
  } as ExecutionFactV1;
}
