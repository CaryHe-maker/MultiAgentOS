import type {
  AttemptRegistration,
  ExecutionRegistration,
  ResultCheck,
} from '../interfaces/index.js';

interface TrackedAttempt {
  readonly registration: AttemptRegistration;
  executionId?: string;
  retryFrom?: string;
  checked: boolean;
}

/** Core-owned identity projection; Execution retains the FIFO and execution history. */
export class AttemptIdentityRegistry {
  readonly #workflowRunId: string;
  readonly #currentRunEpoch: () => number;
  readonly #attempts = new Map<string, TrackedAttempt>();
  readonly #executionIds = new Set<string>();

  constructor(workflowRunId: string, currentRunEpoch: () => number) {
    this.#workflowRunId = workflowRunId;
    this.#currentRunEpoch = currentRunEpoch;
  }

  registerAttempt(attempt: AttemptRegistration): void {
    if (this.#attempts.has(attempt.unitAttemptId)) throw new Error('Duplicate unitAttemptId');
    if (attempt.runEpoch !== this.#currentRunEpoch()) throw new Error('Stale attempt epoch');
    this.#attempts.set(attempt.unitAttemptId, {
      registration: Object.freeze({ ...attempt }),
      checked: false,
    });
  }

  registerExecution(execution: ExecutionRegistration): void {
    const tracked = this.#attempts.get(execution.unitAttemptId);
    if (tracked === undefined || tracked.checked) throw new Error('Execution has no open attempt');
    if (tracked.registration.runEpoch !== execution.runEpoch)
      throw new Error('Execution epoch does not match its attempt');
    if (execution.runEpoch !== this.#currentRunEpoch()) throw new Error('Stale execution epoch');
    if (this.#executionIds.has(execution.executionId)) throw new Error('Duplicate executionId');
    if (tracked.executionId !== undefined && tracked.retryFrom !== tracked.executionId)
      throw new Error('Retry was not authorized');
    this.#executionIds.add(execution.executionId);
    tracked.executionId = execution.executionId;
    delete tracked.retryFrom;
  }

  /** Core calls this only after retryExecution granted a retry for the current instance. */
  authorizeRetry(unitAttemptId: string, previousExecutionId: string): void {
    const tracked = this.#attempts.get(unitAttemptId);
    if (
      tracked === undefined ||
      tracked.checked ||
      tracked.registration.runEpoch !== this.#currentRunEpoch() ||
      tracked.executionId !== previousExecutionId ||
      tracked.retryFrom !== undefined
    )
      throw new Error('Retry does not match the current execution');
    tracked.retryFrom = previousExecutionId;
  }

  /** No mutation on failure: Core audits a stale or alien result and discards it. */
  check(
    workflowRunId: string,
    currentRunEpoch: number,
    check: ResultCheck,
    leaseIsValid: (agentRunId: string) => boolean,
  ): boolean {
    if (workflowRunId !== this.#workflowRunId) return false;
    const tracked = this.#attempts.get(check.unitAttemptId);
    if (tracked === undefined || tracked.checked) return false;
    if (tracked.registration.runEpoch !== currentRunEpoch) return false;
    if (tracked.registration.requiresLease && !leaseIsValid(tracked.registration.agentRunId))
      return false;
    if (tracked.executionId !== check.executionId) return false;
    if (check.outcome === 'NOT_DISPATCHED' && check.executionId !== undefined) return false;
    if (check.executionId === undefined && tracked.executionId !== undefined) return false;
    if (
      check.executionId === undefined &&
      check.outcome !== 'NOT_DISPATCHED' &&
      tracked.registration.executionKind !== 'REPORT_PUBLISH'
    )
      return false;
    return true;
  }

  /** Called only after Core has accepted and settled the result. */
  markChecked(unitAttemptId: string): void {
    const tracked = this.#attempts.get(unitAttemptId);
    if (tracked === undefined || tracked.checked) throw new Error('Attempt is not open');
    tracked.checked = true;
  }
}
