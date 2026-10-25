import type {
  ExecutionResult,
  ExecutorFailedCode,
  ExecutorOutcome,
  ExecutorRejectedCode,
  ViolationCode,
} from '@multiagentos/contracts';

/** Outcome constructors, so every Executor reports with the reason codes of M1Interface 7.3. */
export const completed = (result: ExecutionResult): ExecutorOutcome => ({
  outcome: 'COMPLETED',
  result,
});

export const rejected = (reasonCode: ExecutorRejectedCode): ExecutorOutcome => ({
  outcome: 'REJECTED',
  reasonCode,
});

export const violation = (reasonCode: ViolationCode): ExecutorOutcome => ({
  outcome: 'VIOLATION',
  reasonCode,
});

export const failed = (reasonCode: ExecutorFailedCode, retryable: boolean): ExecutorOutcome => ({
  outcome: 'FAILED',
  reasonCode,
  retryable,
});

/**
 * Raised inside an Executor when its signal fires; the Executor answers with `aborted()`. The
 * Supervisor reports such an execution as TERMINATED, so the reason code here is never
 * delivered (issue #26, B5).
 */
export class ExecutionAborted extends Error {
  public constructor() {
    super('execution aborted');
    this.name = 'ExecutionAborted';
  }
}

export const aborted = (): ExecutorOutcome => failed('INTERNAL', false);

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExecutionAborted();
}

/**
 * Runs an Executor body and turns anything it throws into an outcome: an Executor never throws
 * (M1Interface 8). An abort becomes `aborted()`, any other error a non-retryable INTERNAL
 * failure, because it means a defect rather than a condition of the input.
 */
export async function guarded(body: () => Promise<ExecutorOutcome>): Promise<ExecutorOutcome> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ExecutionAborted) return aborted();
    return failed('INTERNAL', false);
  }
}
