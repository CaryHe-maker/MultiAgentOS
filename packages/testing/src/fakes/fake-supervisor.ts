import type {
  CancelExecutionRequest,
  CancelRunExecutionsRequest,
  ExecutionFact,
  ExecutionRequest,
  SupervisorPort,
  SupervisorShutdownRequest,
} from '@multiagentos/contracts';

/**
 * A Supervisor that does nothing by itself (Interface/KernelSupervisor): it keeps what it was asked and lets
 * a test decide how each execution ends. Like the real one it reports exactly one fact per
 * execution, answers a cancellation with TERMINATED and the reason, and ignores a cancellation of
 * an unknown, finished or other-epoch execution. It follows Interface/KernelSupervisor and does
 * not redefine what the real Supervisor does.
 */
export interface FakeSupervisor extends SupervisorPort {
  readonly executed: readonly ExecutionRequest[];
  readonly cancelledRuns: readonly CancelRunExecutionsRequest[];
  readonly cancelledExecutions: readonly CancelExecutionRequest[];
  readonly shutdowns: readonly SupervisorShutdownRequest[];
  /** The executions that were accepted and have no fact yet. */
  open(): readonly ExecutionRequest[];
  /** Ends an open execution with the given fact fields; false when it is not open. */
  finish(executionId: string, fact: FactBody): Promise<boolean>;
}

/** What a test says about the end of an execution; the identity fields come from the request. */
export type FactBody =
  | {
      readonly outcome: 'STOP_UNCONFIRMED';
      readonly reasonCode?: 'EXECUTION_CANCELLED' | 'UNIT_TIMEOUT';
    }
  | { readonly outcome: 'TERMINATED'; readonly reasonCode?: 'EXECUTION_CANCELLED' | 'UNIT_TIMEOUT' }
  | {
      readonly outcome: 'REJECTED';
      readonly reasonCode: 'OUT_OF_SCOPE' | 'NOT_FOUND' | 'LIMIT_EXCEEDED';
    }
  | { readonly outcome: 'FAILED'; readonly reasonCode: 'INTERNAL'; readonly retryable: boolean };

export function createFakeSupervisor(
  report: (fact: ExecutionFact) => void | Promise<void>,
  now: () => Date = () => new Date(),
): FakeSupervisor {
  const executed: ExecutionRequest[] = [];
  const cancelledRuns: CancelRunExecutionsRequest[] = [];
  const cancelledExecutions: CancelExecutionRequest[] = [];
  const shutdowns: SupervisorShutdownRequest[] = [];
  const open = new Map<string, ExecutionRequest>();

  const factOf = (
    request: ExecutionRequest,
    body: FactBody,
    cancelReason?: 'PAUSED' | 'ABORTED',
  ): ExecutionFact => {
    const at = now().toISOString();
    const base = {
      sessionId: request.sessionId,
      workflowRunId: request.workflowRunId,
      unitAttemptId: request.unitAttemptId,
      executionId: request.executionId,
      runEpoch: request.runEpoch,
      executionKind: request.executionKind,
      startedAt: at,
      endedAt: at,
    };
    // A MODEL execution also says whether the provider saw the request (Interface/Persistence).
    const model = request.executionKind === 'MODEL' ? { requestState: 'UNKNOWN' as const } : {};
    return {
      ...base,
      ...model,
      reasonCode: 'EXECUTION_CANCELLED',
      ...body,
      ...(body.outcome === 'TERMINATED' && cancelReason !== undefined ? { cancelReason } : {}),
    } as unknown as ExecutionFact;
  };

  const end = async (
    executionId: string,
    body: FactBody,
    cancelReason?: 'PAUSED' | 'ABORTED',
  ): Promise<boolean> => {
    const request = open.get(executionId);
    if (request === undefined) return false;
    open.delete(executionId);
    await report(factOf(request, body, cancelReason));
    return true;
  };

  return {
    get executed() {
      return executed;
    },
    get cancelledRuns() {
      return cancelledRuns;
    },
    get cancelledExecutions() {
      return cancelledExecutions;
    },
    get shutdowns() {
      return shutdowns;
    },
    open: () => [...open.values()],
    finish: (executionId, body) => end(executionId, body),
    execute: (request) => {
      executed.push(request);
      // A duplicate executionId is ignored: the first accepted request wins.
      if (
        !open.has(request.executionId) &&
        !executed.slice(0, -1).some((r) => r.executionId === request.executionId)
      )
        open.set(request.executionId, request);
      return Promise.resolve();
    },
    cancelRun: async (request) => {
      cancelledRuns.push(request);
      for (const pending of [...open.values()])
        if (pending.workflowRunId === request.workflowRunId && pending.runEpoch < request.runEpoch)
          await end(pending.executionId, { outcome: 'TERMINATED' });
    },
    cancelExecution: async (request) => {
      cancelledExecutions.push(request);
      const pending = open.get(request.executionId);
      if (pending === undefined || pending.runEpoch !== request.runEpoch) return;
      await end(request.executionId, { outcome: 'TERMINATED' }, request.reason);
    },
    shutdown: (request) => {
      shutdowns.push(request);
      return Promise.resolve();
    },
  };
}
