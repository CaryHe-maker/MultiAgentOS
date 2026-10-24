import type {
  CancelRunExecutionsRequest,
  ExecutionFact,
  ExecutionFactSink,
  ExecutionRequest,
  ExecutorEnvironment,
  ExecutorOutcome,
  ExecutorRegistry,
  ProviderCredentials,
  RequestState,
  SubprocessRunner,
  TokenUsage,
} from '@multiagentos/contracts';
import { createExecutorEnvironment } from './environment.js';
import { ExecutionTable, type ExecutionEntry } from './execution-table.js';
import { toExecutionFact, toTerminationFact } from './fact-mapper.js';

export interface ExecutionRunnerDeps {
  readonly executors: ExecutorRegistry;
  readonly credentials: ProviderCredentials;
  readonly subprocess: SubprocessRunner;
  readonly facts: ExecutionFactSink;
  readonly cancelGraceMs: number;
  readonly now: () => Date;
}

interface TerminationExtras {
  readonly requestState?: RequestState;
  readonly usage?: TokenUsage;
}

/**
 * Accepts execution requests, schedules them, invokes the pinned Executor and
 * reports exactly one terminal fact per execution. A deadline or cancelRun
 * aborts a running execution; its result is settled within the cancellation
 * grace period, otherwise the execution becomes STOP_UNCONFIRMED.
 */
export class ExecutionRunner {
  readonly #executors: ExecutorRegistry;
  readonly #credentials: ProviderCredentials;
  readonly #subprocess: SubprocessRunner;
  readonly #facts: ExecutionFactSink;
  readonly #cancelGraceMs: number;
  readonly #now: () => Date;
  readonly #table = new ExecutionTable();
  readonly #cancelledEpochs = new Map<string, number>();
  #active = 0;
  #stopped = false;
  #lastFactError: string | undefined;

  public constructor(deps: ExecutionRunnerDeps) {
    this.#executors = deps.executors;
    this.#credentials = deps.credentials;
    this.#subprocess = deps.subprocess;
    this.#facts = deps.facts;
    this.#cancelGraceMs = deps.cancelGraceMs;
    this.#now = deps.now;
  }

  /** Returns after the request is accepted; the Executor starts outside this call. */
  public execute(request: ExecutionRequest, correlationId: string): void {
    if (this.#stopped) throw new Error('Supervisor execution runner has stopped');
    const entry: ExecutionEntry = {
      request,
      correlationId,
      abortController: new AbortController(),
      state: 'ACCEPTED',
      terminal: false,
      notBeforeTimer: undefined,
      deadlineTimer: undefined,
      graceTimer: undefined,
    };
    if (!this.#table.add(entry)) return;

    const cancelledEpoch = this.#cancelledEpochs.get(request.workflowRunId);
    if (cancelledEpoch !== undefined && request.runEpoch < cancelledEpoch) {
      this.#finalizeTerminated(entry, undefined, 'EXECUTION_CANCELLED');
      return;
    }
    this.#scheduleStart(entry);
  }

  /**
   * Cancels every execution of the run and records the epoch used to reject
   * late execute requests. Returns once the abort signals are raised.
   */
  public cancelRun(request: CancelRunExecutionsRequest): void {
    const previous = this.#cancelledEpochs.get(request.workflowRunId) ?? 0;
    this.#cancelledEpochs.set(request.workflowRunId, Math.max(previous, request.runEpoch));

    for (const entry of this.#table.values()) {
      if (entry.request.workflowRunId !== request.workflowRunId || entry.terminal) continue;
      if (entry.state === 'ACCEPTED') {
        this.#finalizeTerminated(entry, undefined, 'EXECUTION_CANCELLED');
      } else if (entry.state === 'RUNNING') {
        this.#abort(entry, 'EXECUTION_CANCELLED');
      }
    }
  }

  /** Stops scheduling, clears timers and best-effort reports unconfirmed in-flight work. */
  public stop(): void {
    this.#stopped = true;
    for (const entry of this.#table.values()) {
      this.#clearTimers(entry);
      if (entry.terminal) continue;
      if (entry.state === 'RUNNING') {
        const reason = entry.abortReason ?? 'EXECUTION_CANCELLED';
        entry.abortReason = reason;
        entry.abortController.abort();
        this.#finalize(entry, (endedAt) =>
          toTerminationFact(entry.request, entry.startedAt ?? endedAt, endedAt, {
            outcome: 'STOP_UNCONFIRMED',
            reasonCode: reason,
          }),
        );
      } else {
        // A request that never started has no execution fact to report.
        entry.terminal = true;
        entry.state = 'TERMINAL';
      }
    }
  }

  public activeCount(): number {
    return this.#active;
  }

  public healthDetails(): readonly string[] {
    return [
      `active executions: ${this.#active}`,
      ...(this.#lastFactError === undefined ? [] : [`last fact error: ${this.#lastFactError}`]),
    ];
  }

  #scheduleStart(entry: ExecutionEntry): void {
    const startAt =
      entry.request.notBefore === undefined
        ? this.#now().getTime()
        : Date.parse(entry.request.notBefore);
    const delay = Math.max(0, startAt - this.#now().getTime());
    const timer = setTimeout(() => {
      entry.notBeforeTimer = undefined;
      void this.#start(entry).catch(() => this.#finalizeUnexpectedFailure(entry));
    }, delay);
    entry.notBeforeTimer = timer;
  }

  async #start(entry: ExecutionEntry): Promise<void> {
    if (this.#stopped || entry.terminal || entry.state !== 'ACCEPTED') return;
    entry.state = 'RUNNING';
    entry.startedAt = this.#now().toISOString();
    this.#scheduleDeadline(entry);
    if (entry.abortReason !== undefined) {
      this.#finalizeTerminated(entry, entry.startedAt, entry.abortReason);
      return;
    }

    const executor = this.#executors[entry.request.executionKind];
    if (executor === undefined || executor.executionKind !== entry.request.executionKind) {
      this.#finalizeFailure(entry);
      return;
    }

    const environment = createExecutorEnvironment(entry.request, entry.abortController.signal, {
      credentials: this.#credentials,
      subprocess: this.#subprocess,
      now: this.#now,
    });

    this.#active += 1;
    try {
      const outcome = await runExecutor(this.#executors, entry.request, environment);
      if (entry.terminal || this.#stopped) return;
      if (entry.abortReason === undefined) this.#finishNormal(entry, outcome);
      else this.#finishAborted(entry, outcome);
    } catch {
      if (entry.terminal || this.#stopped) return;
      if (entry.abortReason === undefined) this.#finalizeFailure(entry);
      else this.#finalizeTerminated(entry, entry.startedAt, entry.abortReason);
    } finally {
      this.#active -= 1;
    }
  }

  #scheduleDeadline(entry: ExecutionEntry): void {
    const deadline = Date.parse(entry.request.limits.deadline);
    const now = this.#now().getTime();
    if (!Number.isFinite(deadline) || deadline <= now) {
      this.#abort(entry, 'UNIT_TIMEOUT');
      return;
    }
    const timer = setTimeout(() => {
      entry.deadlineTimer = undefined;
      this.#abort(entry, 'UNIT_TIMEOUT');
    }, deadline - now);
    entry.deadlineTimer = timer;
  }

  #abort(entry: ExecutionEntry, reason: 'UNIT_TIMEOUT' | 'EXECUTION_CANCELLED'): void {
    if (entry.terminal || this.#stopped || entry.abortReason !== undefined) return;
    entry.abortReason = reason;
    entry.abortController.abort();
    const timer = setTimeout(() => {
      entry.graceTimer = undefined;
      this.#stopUnconfirmed(entry);
    }, this.#cancelGraceMs);
    entry.graceTimer = timer;
  }

  #stopUnconfirmed(entry: ExecutionEntry): void {
    const reason = entry.abortReason;
    if (entry.terminal || reason === undefined) return;
    this.#finalize(entry, (endedAt) =>
      toTerminationFact(entry.request, entry.startedAt ?? endedAt, endedAt, {
        outcome: 'STOP_UNCONFIRMED',
        reasonCode: reason,
      }),
    );
  }

  #finishNormal(entry: ExecutionEntry, outcome: ExecutorOutcome): void {
    this.#finalize(entry, (endedAt) =>
      toExecutionFact(entry.request, entry.startedAt ?? endedAt, endedAt, outcome),
    );
  }

  #finishAborted(entry: ExecutionEntry, outcome: ExecutorOutcome): void {
    const reason = entry.abortReason;
    if (reason === undefined) {
      this.#finishNormal(entry, outcome);
      return;
    }
    if (outcome.outcome === 'VIOLATION') {
      // Security evidence is not hidden by a cancellation or timeout.
      this.#finishNormal(entry, outcome);
      return;
    }
    const extras = terminationExtras(outcome);
    this.#finalizeTerminated(entry, entry.startedAt, reason, extras);
  }

  #finalizeFailure(entry: ExecutionEntry): void {
    this.#finalize(entry, (endedAt) =>
      toExecutionFact(
        entry.request,
        entry.startedAt ?? endedAt,
        endedAt,
        failureOutcome(entry.request),
      ),
    );
  }

  #finalizeUnexpectedFailure(entry: ExecutionEntry): void {
    if (entry.terminal) return;
    this.#finalizeFailure(entry);
  }

  #finalizeTerminated(
    entry: ExecutionEntry,
    startedAt: string | undefined,
    reason: 'UNIT_TIMEOUT' | 'EXECUTION_CANCELLED',
    extras: TerminationExtras = {},
  ): void {
    this.#finalize(entry, (endedAt) =>
      toTerminationFact(entry.request, startedAt, endedAt, {
        outcome: 'TERMINATED',
        reasonCode: reason,
        ...extras,
      }),
    );
  }

  #finalize(entry: ExecutionEntry, buildFact: (endedAt: string) => ExecutionFact): void {
    if (entry.terminal) return;
    entry.terminal = true;
    entry.state = 'TERMINAL';
    this.#clearTimers(entry);
    entry.endedAt = this.#now().toISOString();
    void this.#report(buildFact(entry.endedAt));
  }

  #clearTimers(entry: ExecutionEntry): void {
    if (entry.notBeforeTimer !== undefined) clearTimeout(entry.notBeforeTimer);
    if (entry.deadlineTimer !== undefined) clearTimeout(entry.deadlineTimer);
    if (entry.graceTimer !== undefined) clearTimeout(entry.graceTimer);
    entry.notBeforeTimer = undefined;
    entry.deadlineTimer = undefined;
    entry.graceTimer = undefined;
  }

  async #report(fact: ExecutionFact): Promise<void> {
    try {
      await this.#facts.report(fact);
    } catch (error: unknown) {
      // A failed delivery does not create a second fact or retry the execution.
      this.#lastFactError = error instanceof Error ? error.message : String(error);
    }
  }
}

function terminationExtras(outcome: ExecutorOutcome): TerminationExtras {
  switch (outcome.outcome) {
    case 'COMPLETED':
    case 'FAILED':
      return {
        ...(outcome.requestState === undefined ? {} : { requestState: outcome.requestState }),
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      };
    default:
      return {};
  }
}

function failureOutcome(request: ExecutionRequest): ExecutorOutcome {
  return {
    outcome: 'FAILED',
    reasonCode: 'INTERNAL',
    retryable: false,
    ...(request.executionKind === 'MODEL' ? { requestState: 'UNKNOWN' as const } : {}),
  };
}

function runExecutor(
  registry: ExecutorRegistry,
  request: ExecutionRequest,
  environment: ExecutorEnvironment,
): Promise<ExecutorOutcome> {
  switch (request.executionKind) {
    case 'REPOSITORY_ORIENT':
      return registry.REPOSITORY_ORIENT.execute(request.input, environment);
    case 'REPOSITORY_SEARCH':
      return registry.REPOSITORY_SEARCH.execute(request.input, environment);
    case 'FILE_READ':
      return registry.FILE_READ.execute(request.input, environment);
    case 'CONTEXT_ASSEMBLE':
      return registry.CONTEXT_ASSEMBLE.execute(request.input, environment);
    case 'MODEL':
      return registry.MODEL.execute(request.input, environment);
  }
}
