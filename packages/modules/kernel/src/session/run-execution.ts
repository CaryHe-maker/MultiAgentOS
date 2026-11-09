import {
  MEDIA_TYPES,
  newId,
  type ArtifactRef,
  type ExecutionScope,
  type CancelExecutionRequest,
  type CancelRunExecutionsRequest,
  type ExecutionFact,
  type ExecutionRequest,
  type ExecutorKind,
  type UnknownEffect,
} from '@multiagentos/contracts';
import {
  AttemptRequestBuilder,
  RequestBuildError,
  type BuiltRequest,
  type ExecutionConfig,
} from './attempt-request.js';
import type { Fingerprints } from './change-scan.js';
import { publishMessage, publishReport, type BuiltInResult } from './built-in-units.js';
import {
  AttemptQueues,
  type ConcurrencyClass,
  type QueueEntry,
  type QueueLimits,
} from './execution-queues.js';
import type { AttemptSpec, ResultCheck, RunAttempts } from './run-attempts.js';
import type { ProjectFileRead } from './run-work.js';
import type { SessionArtifacts } from './session-artifacts.js';

/** A question shows this much of `AGENTS.md` (M2Design 9.5). */
const PROJECT_FILE_DISPLAY_BYTES = 64 * 1024;

export interface RetryingActivity {
  readonly spec: AttemptSpec;
  readonly unitAttemptId: string;
  readonly attempt: number;
  readonly retryAt: string;
}

export interface RunExecutionDeps {
  readonly sessionId: string;
  readonly workflowRunId: string;
  readonly config: ExecutionConfig;
  readonly artifacts: SessionArtifacts;
  readonly dispatch: (request: ExecutionRequest) => Promise<void>;
  readonly cancelRun: (request: CancelRunExecutionsRequest) => Promise<void>;
  /** Cancels one execution; its fact comes back saying why (M2Design 7.6). */
  readonly cancelExecution: (request: CancelExecutionRequest) => Promise<void>;
  readonly retrying: (activity: RetryingActivity) => void;
  /** A write landed; awaited, so that whatever follows from it precedes the report. */
  readonly written: (path: string, sha256: string) => Promise<void>;
  /** Undefined when the file does not exist. */
  readonly readRepositoryFile: (path: string, scope: ExecutionScope) => Promise<string | undefined>;
  /**
   * Runs `work` as a control message of the actor; a timer only does this. The actor awaits what
   * `work` returns before it sends what the message produced.
   */
  readonly enqueue: (work: () => void | Promise<void>) => void;
  readonly schedule: (delayMs: number, due: () => void) => () => void;
  readonly now: () => Date;
  /**
   * Protected paths a command may not create (Kernel/Execution 4d, M2Design 6.1): the set that
   * exists before it runs, and the moving of whatever is new afterwards.
   */
  readonly protectedPaths?: {
    readonly snapshot: () => Promise<ReadonlySet<string>>;
    readonly quarantine: (before: ReadonlySet<string>) => Promise<readonly string[]>;
  };
  /**
   * Which files a command changed (M2Design 7.1): its write roots are scanned before it runs and
   * after, and the difference goes into the report. Undefined when the tree cannot be scanned.
   */
  readonly changes?: {
    readonly snapshot: (roots: readonly string[]) => Promise<Fingerprints | undefined>;
    readonly since: (
      before: Fingerprints,
      roots: readonly string[],
    ) => Promise<readonly string[] | undefined>;
  };
  readonly audit?: (entry: object) => void;
  /**
   * After an ordinary assembly came back (or was refused for its size): is a compaction needed
   * first? `COMPACTED` makes the assembly answer `CONTEXT_COMPACTED` so Workflow assembles again
   * (Kernel/Core 6a); `BUDGET` that the compaction could not be paid for.
   */
  readonly afterAssemble?: (info: AssemblyInfo) => Promise<'PROCEED' | 'COMPACTED' | 'BUDGET'>;
  /** Decided at once, inside the actor: is a compaction due for this assembly? */
  readonly compactionDue?: (info: AssemblyInfo) => boolean;
  /**
   * An ordinary assembly that needs no compaction came back with this size: how full the context
   * of its AgentRun is. Not a fact, nothing waits for it.
   */
  readonly contextLevel?: (level: {
    readonly executionId: string;
    readonly agentRunId: string;
    readonly used: number;
    readonly limit: number;
  }) => void;
  /** A model call of an AgentRun was answered: a size it was refused for is remembered. */
  readonly modelAnswered?: (info: {
    readonly agentRunId: string;
    readonly completed: boolean;
    readonly overflow: boolean;
  }) => void;
  /** What may execute at once over all AgentRuns (`kernel.maxConcurrentAttempts` and the like). */
  readonly limits: QueueLimits;
  /**
   * A model call was sent to the Supervisor: its thinking may now be streamed to the console, so
   * the Kernel remembers whose call it is. Not a fact, nothing waits for it.
   */
  readonly modelStarted?: (call: {
    readonly executionId: string;
    readonly agentRunId: string;
  }) => void;
  readonly newExecutionId?: () => string;
  readonly newAttemptId?: () => string;
}

/** What an ordinary assembly came to: its size, or that it was refused for being too big. */
export interface AssemblyInfo {
  readonly agentRunId: string;
  readonly kind: 'COMPLETED' | 'OVERSIZE';
  readonly tokenCount: number;
  readonly tokenBudget: number;
}

/** The roots a sandboxed command may write: what a scan before and after looks at. */
const commandRootsOf = (spec: AttemptSpec): readonly string[] =>
  spec.scope.kind === 'SANDBOX' ? spec.scope.profile.writableRoots : [];

interface Attempt extends QueueEntry {
  readonly spec: AttemptSpec;
  readonly unitAttemptId: string;
  readonly attempts: RunAttempts;
  executionId?: string;
  retries: number;
  /** Set once the "before" of a command was taken. */
  snapshotted?: boolean;
  /** The protected paths that existed when a command was first dispatched. */
  protectedBefore?: ReadonlySet<string>;
  /** The files under a command's write roots when it was first dispatched. */
  changedBefore?: Fingerprints | undefined;
  /** Built, and waiting for a call slot to be reserved (M2Design 7.2). */
  built?: { readonly request: BuiltRequest; readonly executionId: string };
  /** Set when a pause or an abort asked the Supervisor to cancel it: the fact will say so. */
  cancelReason?: 'PAUSED' | 'ABORTED';
  /** What a web tool was asked, kept for the audit line its fact completes (Core 5f). */
  webInput?: unknown;
}

/**
 * The class a Unit declares for the queue (M2Design 7.1). A command that cannot write, one of the
 * read-only list in a sandbox without a writable root, is a READ: it takes no part in the EXEC
 * mutex and is no barrier (M2Design 5.2).
 */
export function concurrencyClassOf(spec: Pick<AttemptSpec, 'unit' | 'scope'>): ConcurrencyClass {
  switch (spec.unit.executionKind) {
    case 'MODEL':
      return 'MODEL';
    case 'FILE_WRITE':
    case 'FILE_EDIT':
    case 'MESSAGE_PUBLISH':
    case 'REPORT_PUBLISH':
      return 'WRITE';
    case 'COMMAND':
      return spec.scope.kind === 'SANDBOX' &&
        spec.scope.backend === 'BWRAP' &&
        spec.scope.profile.writableRoots.length === 0
        ? 'READ'
        : 'EXEC';
    default:
      return 'READ';
  }
}

/** What a Unit attempt completes with; CONTEXT_PRUNE is Kernel's own and answers the compaction. */
type Completed = Exclude<
  Extract<ExecutionFact, { outcome: 'COMPLETED' }>,
  { executionKind: 'CONTEXT_PRUNE' }
>;
type NotCompleted = Exclude<ExecutionFact, { outcome: 'COMPLETED' }>;

/** The overview is a structure with its own token budget, not a preview of an output. */
const toolLimitOf = (fact: Completed, config: ExecutionConfig) => {
  const { executionKind } = fact;
  return executionKind === 'MODEL' ||
    executionKind === 'CONTEXT_ASSEMBLE' ||
    executionKind === 'REPOSITORY_ORIENT'
    ? undefined
    : config.executionLimits[executionKind];
};

/**
 * One run's attempts in Execution (Kernel/Execution): a queue for every AgentRun, started by
 * class and by the global limits (M2Design 7.1), the storage of results and technical retries. Every method runs inside a message of the Session
 * actor; I/O on local artifacts may be awaited there (Kernel/Interaction 5.4).
 */
export class RunExecution {
  readonly #deps: RunExecutionDeps;
  readonly #builder: AttemptRequestBuilder;
  readonly #queues = new AttemptQueues<Attempt>();
  readonly #byId = new Map<string, Attempt>();
  readonly #internal = new Map<string, (fact: ExecutionFact) => void>();
  readonly #effects: UnknownEffect[] = [];
  #seq = 0;
  #pumping = false;
  #again = false;
  #cancelFallback: (() => void) | undefined;
  /** While paused or pausing nothing new starts (Kernel/Execution 4e). */
  #held = false;
  #onDrained: (() => void) | undefined;
  readonly #drainTimers = new Set<() => void>();

  public constructor(deps: RunExecutionDeps) {
    this.#deps = deps;
    this.#builder = new AttemptRequestBuilder({
      config: deps.config,
      artifacts: deps.artifacts,
      now: deps.now,
    });
  }

  async createAttempt(spec: AttemptSpec, attempts: RunAttempts): Promise<string> {
    const unitAttemptId = this.#deps.newAttemptId?.() ?? newId('una');
    attempts.registerAttempt(unitAttemptId, spec.requestId);
    this.#seq += 1;
    const attempt: Attempt = {
      spec,
      unitAttemptId,
      attempts,
      retries: 0,
      seq: this.#seq,
      agentRunId: spec.agentRunId,
      cls: concurrencyClassOf(spec),
      state: 'QUEUED',
    };
    this.#byId.set(unitAttemptId, attempt);
    this.#queues.add(attempt);
    await this.#pump();
    return unitAttemptId;
  }

  #noteStop(attempt: Attempt, executionId: string): void {
    this.#effects.push({
      unitAttemptId: attempt.unitAttemptId,
      executionId,
      executionKind: attempt.spec.unit.executionKind as ExecutorKind,
      effect: 'EXECUTION_STOP_UNCONFIRMED',
    });
  }

  #noteUnconfirmed(attempt: Attempt, executionId: string): void {
    this.#effects.push({
      unitAttemptId: attempt.unitAttemptId,
      executionId,
      executionKind: 'MODEL',
      effect: 'MODEL_REQUEST_UNCONFIRMED',
    });
  }

  /** What may have happened without being confirmed; RunClosed reports it. */
  unknownEffects(): UnknownEffect[] {
    return [...this.#effects];
  }

  /** Starts whatever may start now. A call made while it runs makes it look again. */
  async #pump(): Promise<void> {
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#again = false;
        const started = this.#held ? [] : this.#queues.startable(this.#deps.limits);
        await Promise.all(started.map((attempt) => this.#run(attempt)));
      } while (this.#again);
    } finally {
      this.#pumping = false;
    }
  }

  async #finish(attempt: Attempt, check: Omit<ResultCheck, 'unitAttemptId'>): Promise<void> {
    attempt.attempts.submitResultCheck({ unitAttemptId: attempt.unitAttemptId, ...check });
    this.#queues.release(attempt);
    this.#checkDrained();
    await this.#pump();
  }

  /** The attempt is over without a result of its own: Core ended it, with a report or the run. */
  async #dropped(attempt: Attempt): Promise<void> {
    this.#queues.release(attempt);
    this.#checkDrained();
    await this.#pump();
  }

  /**
   * An attempt that never reached the Supervisor, in a run that was aborted since it was made:
   * it answers INTERRUPTED(ABORTED) like the ones that were cancelled.
   */
  async #interruptedUnsent(attempt: Attempt): Promise<void> {
    attempt.attempts.interruptUnsent(attempt.unitAttemptId, 'ABORTED');
    await this.#dropped(attempt);
  }

  async #run(attempt: Attempt): Promise<void> {
    const { unit, input } = attempt.spec;
    const { artifacts, config } = this.#deps;
    if (unit.executionKind === 'MESSAGE_PUBLISH' || unit.executionKind === 'REPORT_PUBLISH') {
      let result: BuiltInResult;
      try {
        result =
          unit.executionKind === 'MESSAGE_PUBLISH'
            ? await publishMessage(input, artifacts)
            : await publishReport(input, artifacts, config.maxReportBytes);
      } catch {
        result = { outcome: 'FAILED', reasonCode: 'INTERNAL' };
      }
      await this.#finish(attempt, result);
      return;
    }
    await this.#dispatch(attempt);
  }

  /**
   * What a command is judged against afterwards, taken once before its first dispatch: which
   * protected paths exist, and what the files under its write roots look like. Without the
   * protected paths nothing a command creates there could be taken away again (M2Design 12, 16),
   * so a command whose protected paths cannot be listed does not run; the list of changed files
   * only serves the report, and its absence does not stop anything. Returns whether to go on.
   */
  async #snapshotBeforeCommand(attempt: Attempt): Promise<boolean> {
    const { protectedPaths, changes } = this.#deps;
    if (attempt.spec.unit.executionKind !== 'COMMAND' || attempt.snapshotted === true) return true;
    attempt.snapshotted = true;
    if (protectedPaths !== undefined)
      try {
        attempt.protectedBefore = await protectedPaths.snapshot();
      } catch {
        return false;
      }
    const roots = commandRootsOf(attempt.spec);
    if (changes !== undefined && roots.length > 0)
      try {
        attempt.changedBefore = await changes.snapshot(roots);
      } catch {
        // The command still runs; only the list of what it changed will be missing.
      }
    return true;
  }

  async #dispatch(attempt: Attempt, notBefore?: string): Promise<void> {
    if (!(await this.#snapshotBeforeCommand(attempt))) {
      await this.#finish(attempt, {
        outcome: 'NOT_DISPATCHED',
        reasonCode: 'ADMISSION_CHECK_FAILED',
      });
      return;
    }
    const executionId = this.#deps.newExecutionId?.() ?? newId('exe');
    let built: BuiltRequest;
    const calibration = attempt.attempts.calibrationOf(attempt.spec.agent.id);
    try {
      built = await this.#builder.build(attempt.spec, {
        ...(calibration === undefined ? {} : { calibration }),
        sessionId: this.#deps.sessionId,
        workflowRunId: this.#deps.workflowRunId,
        unitAttemptId: attempt.unitAttemptId,
        executionId,
        ...(notBefore === undefined ? {} : { notBefore, retry: true }),
      });
    } catch (error) {
      await this.#finish(attempt, {
        outcome: error instanceof RequestBuildError ? 'NOT_DISPATCHED' : 'FAILED',
        reasonCode: error instanceof RequestBuildError ? error.reasonCode : 'INTERNAL',
      });
      return;
    }
    // A parked attempt leaves the count, so what waits behind it may start.
    if ((await this.#reserveAndSend(attempt, built, executionId)) === 'WAITING') {
      this.#checkDrained();
      await this.#pump();
    }
  }

  /**
   * The one path from a built request to a sent one: a call slot and tokens are asked for (a retry
   * has them already), and then it goes out. Every slot in use is no failure: the attempt waits,
   * uncounted, and asks again when one is free (M2Design 7.2). Any other refusal means Core has
   * ended the attempt, with a report or with the run.
   */
  async #reserveAndSend(
    attempt: Attempt,
    built: BuiltRequest,
    executionId: string,
  ): Promise<'SENT' | 'WAITING' | 'DROPPED'> {
    if (attempt.cancelReason === 'ABORTED' && attempt.executionId === undefined) {
      await this.#interruptedUnsent(attempt);
      return 'DROPPED';
    }
    // A pause stops what has not been sent: it waits where the call-slot waiters do.
    if (this.#held && attempt.executionId === undefined) {
      attempt.built = { request: built, executionId };
      this.#queues.park(attempt);
      return 'WAITING';
    }
    if (built.reservation !== undefined && attempt.executionId === undefined) {
      const decision = attempt.attempts.requestReservation({
        unitAttemptId: attempt.unitAttemptId,
        ...built.reservation,
      });
      if (!decision.granted) {
        if (decision.reason !== 'WAIT_CAPACITY') {
          delete attempt.built;
          await this.#dropped(attempt);
          return 'DROPPED';
        }
        attempt.built = { request: built, executionId };
        this.#queues.park(attempt);
        return 'WAITING';
      }
    }
    delete attempt.built;
    this.#send(attempt, built, executionId);
    return 'SENT';
  }

  #send(attempt: Attempt, built: BuiltRequest, executionId: string): void {
    attempt.attempts.registerExecution(attempt.unitAttemptId, executionId);
    attempt.executionId = executionId;
    if (built.request.executionKind === 'MODEL')
      this.#deps.modelStarted?.({ executionId, agentRunId: attempt.spec.agentRunId });
    if (built.request.executionKind === 'WEB_SEARCH' || built.request.executionKind === 'WEB_FETCH')
      attempt.webInput = built.request.input;
    // Cross-subject I/O never holds the actor (Kernel/Interaction 5.4).
    this.#deps.dispatch(built.request).catch(() => {
      this.#deps.enqueue(() => {
        const model = attempt.spec.unit.executionKind === 'MODEL';
        if (model) this.#noteUnconfirmed(attempt, executionId);
        void this.#finish(attempt, {
          executionId,
          outcome: 'FAILED',
          reasonCode: 'INTERNAL',
          ...(model ? { requestState: 'UNKNOWN' as const } : {}),
        });
      });
    });
  }

  /**
   * Called at the end of every message of the Session actor (M2Design 7.2): the call slots given
   * back since are offered to the attempts that wait, oldest first, and the first that finds none
   * ends the round, so a younger one never passes an older one.
   */
  async drainCapacityWaiters(): Promise<void> {
    if (this.#held) return;
    for (const attempt of this.#queues.waiting()) {
      const pending = attempt.built;
      if (pending === undefined || !this.#queues.resume(attempt, this.#deps.limits)) break;
      if ((await this.#reserveAndSend(attempt, pending.request, pending.executionId)) === 'WAITING')
        break;
    }
  }

  /**
   * Kernel's own executions (a prune or a summary of a compaction) have no Unit attempt: the
   * compaction that started one hears its fact here, once.
   */
  expectInternal(unitAttemptId: string, handler: (fact: ExecutionFact) => void): void {
    this.#internal.set(unitAttemptId, handler);
  }

  /** One terminal fact of the Supervisor; anything stale is dropped here. */
  async handleFact(fact: ExecutionFact): Promise<void> {
    const internal = this.#internal.get(fact.unitAttemptId);
    if (internal !== undefined) {
      this.#internal.delete(fact.unitAttemptId);
      internal(fact);
      return;
    }
    if (fact.executionKind === 'CONTEXT_PRUNE') return;
    const attempt = this.#byId.get(fact.unitAttemptId);
    if (
      attempt === undefined ||
      attempt.executionId !== fact.executionId ||
      fact.runEpoch !== attempt.spec.runEpoch ||
      fact.executionKind !== attempt.spec.unit.executionKind
    )
      return;
    if (await this.#createdProtected(attempt, fact)) return;
    this.#auditWeb(attempt, fact);
    if (fact.executionKind === 'MODEL')
      this.#deps.modelAnswered?.({
        agentRunId: attempt.spec.agentRunId,
        completed: fact.outcome === 'COMPLETED',
        overflow: fact.outcome === 'REJECTED' && fact.reasonCode === 'CONTEXT_OVERFLOW',
      });
    // An assembly that came out too big is not delivered: a compaction runs first. That waits for
    // Workflow, so it cannot be waited for here, inside the actor's own message (Kernel/Core 6a).
    const due = this.#assemblyDue(attempt, fact);
    if (due !== undefined) {
      void this.#compactBeforeDelivering(attempt, fact, due);
      return;
    }
    await this.#settle(attempt, fact);
  }

  /** What the rest of a fact comes to once nothing holds it back. */
  async #settle(attempt: Attempt, fact: ExecutionFact): Promise<void> {
    // Kernel's own execution of a compaction never gets here: it was answered to its asker.
    if (fact.executionKind === 'CONTEXT_PRUNE') return;
    if (
      fact.outcome === 'TERMINATED' &&
      fact.reasonCode === 'EXECUTION_CANCELLED' &&
      fact.cancelReason !== undefined
    ) {
      await this.#finish(attempt, {
        executionId: fact.executionId,
        outcome: 'INTERRUPTED',
        interruptedBy: fact.cancelReason,
        ...(fact.executionKind === 'MODEL'
          ? {
              requestState: fact.requestState,
              ...(fact.usage === undefined ? {} : { usage: fact.usage }),
            }
          : {}),
      });
      return;
    }
    if (fact.outcome === 'COMPLETED') {
      await this.#completed(attempt, fact);
      return;
    }
    if (fact.outcome === 'FAILED' && fact.retryable && (await this.#retried(attempt, fact))) return;
    if (fact.outcome === 'STOP_UNCONFIRMED') this.#noteStop(attempt, fact.executionId);
    if (fact.executionKind === 'MODEL' && fact.requestState === 'UNKNOWN')
      this.#noteUnconfirmed(attempt, fact.executionId);
    await this.#finish(attempt, {
      executionId: fact.executionId,
      outcome: fact.outcome,
      reasonCode: fact.reasonCode,
      ...(fact.executionKind === 'MODEL'
        ? {
            requestState: fact.requestState,
            ...(fact.usage === undefined ? {} : { usage: fact.usage }),
          }
        : {}),
    });
  }

  /**
   * The checkpoint of a compaction (M2Design 9.6): an ordinary assembly that came out too big, or
   * was refused for it, is not delivered until the compaction has run. What it is, when it is due.
   */
  #assemblyDue(attempt: Attempt, fact: ExecutionFact): AssemblyInfo | undefined {
    const { compactionDue } = this.#deps;
    if (compactionDue === undefined || (attempt.spec.input as { final?: boolean }).final === true)
      return undefined;
    const { perCallInputLimit } = attempt.spec.agent.budget;
    const info: AssemblyInfo | undefined =
      fact.outcome === 'COMPLETED' && fact.executionKind === 'CONTEXT_ASSEMBLE'
        ? {
            agentRunId: attempt.spec.agentRunId,
            kind: 'COMPLETED',
            tokenCount: fact.result.output.tokenCount,
            tokenBudget: perCallInputLimit,
          }
        : fact.outcome === 'REJECTED' && fact.reasonCode === 'LIMIT_EXCEEDED'
          ? {
              agentRunId: attempt.spec.agentRunId,
              kind: 'OVERSIZE',
              tokenCount: perCallInputLimit,
              tokenBudget: perCallInputLimit,
            }
          : undefined;
    if (info === undefined) return undefined;
    if (compactionDue(info)) return info;
    // An assembly that is made again after a compaction tells its size then, not this one.
    if (info.kind === 'COMPLETED')
      this.#deps.contextLevel?.({
        executionId: fact.executionId,
        agentRunId: info.agentRunId,
        used: info.tokenCount,
        limit: info.tokenBudget,
      });
    return undefined;
  }

  /** Runs outside the actor; what comes of it goes back in as a message of the actor. */
  async #compactBeforeDelivering(
    attempt: Attempt,
    fact: ExecutionFact,
    info: AssemblyInfo,
  ): Promise<void> {
    // A compaction that breaks must not break the call it was to make room for.
    const verdict =
      (await this.#deps.afterAssemble?.(info).catch(() => 'PROCEED' as const)) ?? 'PROCEED';
    this.#deps.enqueue(async () => {
      // Aborted, paused or closed meanwhile: the attempt was answered by that, not by this.
      if (this.#byId.get(attempt.unitAttemptId) !== attempt) return;
      if (verdict === 'PROCEED') await this.#settle(attempt, fact);
      else
        await this.#finish(attempt, {
          executionId: attempt.executionId ?? '',
          outcome: 'REJECTED',
          reasonCode: verdict === 'COMPACTED' ? 'CONTEXT_COMPACTED' : 'BUDGET_WRAP_UP',
        });
    });
  }

  /**
   * What a web tool was asked goes on record with how it ended (Kernel/Core 5f). What a request
   * the Executor refused as holding a secret said is not written: the audit must not become the
   * place where the secret is kept.
   */
  #auditWeb(attempt: Attempt, fact: ExecutionFact): void {
    if (fact.executionKind !== 'WEB_SEARCH' && fact.executionKind !== 'WEB_FETCH') return;
    const ended = fact.outcome === 'COMPLETED' ? {} : { reasonCode: fact.reasonCode };
    const secret = fact.outcome !== 'COMPLETED' && fact.reasonCode === 'SECRET_IN_REQUEST';
    const input = secret ? undefined : (attempt.webInput as Record<string, unknown> | undefined);
    this.#deps.audit?.({
      type: fact.executionKind,
      unitAttemptId: attempt.unitAttemptId,
      agentRunId: attempt.spec.agentRunId,
      outcome: fact.outcome,
      ...ended,
      ...(fact.executionKind === 'WEB_SEARCH'
        ? { queries: input?.['queries'] }
        : { url: input?.['url'] }),
    });
  }

  /**
   * A command that made a protected path has it moved out, and its result is replaced by the
   * refusal, whatever the command printed (M2Design 6.1, "new protection").
   */
  async #createdProtected(attempt: Attempt, fact: ExecutionFact): Promise<boolean> {
    const guard = this.#deps.protectedPaths;
    if (
      guard === undefined ||
      fact.executionKind !== 'COMMAND' ||
      fact.outcome === 'STOP_UNCONFIRMED' ||
      attempt.protectedBefore === undefined
    )
      return false;
    let moved: readonly string[];
    try {
      moved = await guard.quarantine(attempt.protectedBefore);
    } catch {
      return false;
    }
    if (moved.length === 0) return false;
    this.#deps.audit?.({
      type: 'PROTECTED_PATH_CREATED',
      unitAttemptId: attempt.unitAttemptId,
      paths: moved,
    });
    await this.#finish(attempt, {
      executionId: fact.executionId,
      outcome: 'REJECTED',
      reasonCode: 'PROTECTED_PATH_CREATED',
    });
    return true;
  }

  async #completed(attempt: Attempt, fact: Completed): Promise<void> {
    const { artifacts, config } = this.#deps;
    const model =
      fact.executionKind === 'MODEL'
        ? {
            requestState: fact.requestState,
            ...(fact.usage === undefined ? {} : { usage: fact.usage }),
          }
        : {};
    const ended = (outcome: 'FAILED' | 'REJECTED', reasonCode: 'INTERNAL' | 'LIMIT_EXCEEDED') =>
      this.#finish(attempt, { executionId: fact.executionId, outcome, reasonCode, ...model });
    const { result } = fact;
    const limit = toolLimitOf(fact, config);
    const fullText = 'fullOutput' in result ? result.fullOutput?.text : undefined;
    if (
      limit !== undefined &&
      (Buffer.byteLength(result.artifact.text, 'utf8') >
        Math.min(limit.previewMaxBytes, limit.maxOutputBytes) ||
        (fullText !== undefined && Buffer.byteLength(fullText, 'utf8') > limit.maxFullOutputBytes))
    ) {
      await ended('REJECTED', 'LIMIT_EXCEEDED');
      return;
    }
    let refs: { outputRef: ArtifactRef; fullRef?: ArtifactRef; reasoningRef?: ArtifactRef };
    try {
      const retention = fact.executionKind === 'CONTEXT_ASSEMBLE' ? 'EXPIRING' : 'SESSION';
      const outputRef = await artifacts.put(
        result.artifact.text,
        result.artifact.mediaType,
        retention,
      );
      const reasoning = 'reasoning' in result ? result.reasoning?.text : undefined;
      refs = {
        outputRef,
        ...(fullText === undefined
          ? {}
          : {
              fullRef: await artifacts.put(fullText, result.artifact.mediaType, 'EXPIRING', {
                fullOutput: true,
              }),
            }),
        ...(reasoning === undefined
          ? {}
          : {
              reasoningRef: await artifacts.put(reasoning, 'text/plain; charset=utf-8', 'SESSION'),
            }),
      };
    } catch {
      await ended('FAILED', 'INTERNAL');
      return;
    }
    let changedFiles: readonly string[] | undefined;
    if (fact.executionKind === 'FILE_WRITE' || fact.executionKind === 'FILE_EDIT') {
      const { path, sha256 } = fact.result.output;
      changedFiles = [path];
      try {
        await this.#deps.written(path, sha256);
      } catch {
        await ended('FAILED', 'INTERNAL');
        return;
      }
    }
    if (
      fact.executionKind === 'COMMAND' &&
      attempt.changedBefore !== undefined &&
      this.#deps.changes !== undefined
    ) {
      try {
        changedFiles = await this.#deps.changes.since(
          attempt.changedBefore,
          commandRootsOf(attempt.spec),
        );
      } catch {
        // The command ran; only the list of what it changed is missing.
      }
    }
    await this.#finish(attempt, {
      executionId: fact.executionId,
      outcome: 'COMPLETED',
      output: result.output,
      ...refs,
      ...model,
      ...(changedFiles === undefined ? {} : { changedFiles }),
    });
  }

  /** True when the attempt was retried, or Core already ended it. */
  async #retried(
    attempt: Attempt,
    fact: Extract<NotCompleted, { outcome: 'FAILED' }>,
  ): Promise<boolean> {
    const retryAfterMs = 'retryAfterMs' in fact ? fact.retryAfterMs : undefined;
    const { retryAfterMaxMs, retryBackoffBaseMs } = this.#deps.config;
    if (retryAfterMs !== undefined && retryAfterMs > retryAfterMaxMs) return false;
    const decision = attempt.attempts.retryExecution({
      unitAttemptId: attempt.unitAttemptId,
      previousExecutionId: fact.executionId,
      ...(fact.executionKind === 'MODEL'
        ? {
            requestState: fact.requestState,
            ...(fact.usage === undefined ? {} : { usage: fact.usage }),
          }
        : {}),
    });
    if (!decision.allowed) {
      if (decision.reason !== 'BUDGET_WRAP_UP' && decision.reason !== 'BUDGET_EXHAUSTED')
        return false;
      await this.#dropped(attempt);
      return true;
    }
    attempt.retries += 1;
    const backoffMs = retryBackoffBaseMs * 2 ** (attempt.retries - 1);
    const retryAt = new Date(
      this.#deps.now().getTime() + Math.max(backoffMs, retryAfterMs ?? 0),
    ).toISOString();
    this.#deps.retrying({
      spec: attempt.spec,
      unitAttemptId: attempt.unitAttemptId,
      attempt: attempt.retries,
      retryAt,
    });
    await this.#dispatch(attempt, retryAt);
    return true;
  }

  /** Goes through the same path and exclusion checks as `file-read` (Kernel/Execution 4). */
  async readProjectFile(path: string, scope: ExecutionScope): Promise<ProjectFileRead> {
    const text = await this.#deps.readRepositoryFile(path, scope);
    if (text === undefined) return { exists: false };
    const ref = await this.#deps.artifacts.put(text, MEDIA_TYPES.fileText, 'SESSION');
    return {
      exists: true,
      ref,
      sha256: ref.sha256,
      text,
      truncated: Buffer.byteLength(text, 'utf8') > PROJECT_FILE_DISPLAY_BYTES,
    };
  }

  /**
   * The run started converging at `runEpoch`. Queued attempts end here; the one in flight is
   * cancelled, and when the Supervisor never confirms, the fallback judges it unconfirmed.
   */
  cancel(runEpoch: number): void {
    for (const attempt of this.#queues.drainQueued())
      attempt.attempts.abandon(attempt.unitAttemptId);
    // One that waits for a call slot, or is being built, was never sent: nothing to stop.
    for (const attempt of [...this.#queues.running(), ...this.#queues.waiting()]) {
      if (attempt.executionId !== undefined) continue;
      attempt.attempts.abandon(attempt.unitAttemptId);
      this.#queues.release(attempt);
    }
    const sent = this.#queues.running().filter((attempt) => attempt.executionId !== undefined);
    if (sent.length === 0) return;
    const { config, enqueue, schedule, workflowRunId, cancelRun } = this.#deps;
    this.#cancelFallback = schedule(config.cancelGraceMs + config.convergenceMarginMs, () => {
      enqueue(() => {
        for (const attempt of sent) {
          if (attempt.executionId === undefined || !this.#queues.running().includes(attempt))
            continue;
          this.#noteStop(attempt, attempt.executionId);
          void this.#finish(attempt, {
            executionId: attempt.executionId,
            outcome: 'STOP_UNCONFIRMED',
          });
        }
      });
    });
    cancelRun({ workflowRunId, runEpoch }).catch(() => undefined);
  }

  #cancelSent(attempt: Attempt, reason: 'PAUSED' | 'ABORTED'): void {
    if (attempt.executionId === undefined || attempt.cancelReason !== undefined) return;
    attempt.cancelReason = reason;
    this.#deps
      .cancelExecution({
        executionId: attempt.executionId,
        runEpoch: attempt.spec.runEpoch,
        reason,
      })
      .catch(() => undefined);
  }

  /** The pause is complete once nothing is executing; Core then moves from PAUSING to PAUSED. */
  #checkDrained(): void {
    if (this.#onDrained === undefined || this.#queues.running().length > 0) return;
    const notify = this.#onDrained;
    this.#onDrained = undefined;
    for (const stop of this.#drainTimers) stop();
    this.#drainTimers.clear();
    notify();
  }

  /**
   * PAUSING (M2Design 4.4): nothing new starts; what is executing is handled by class. A READ may
   * finish within `pauseDrainMs`; a WRITE always finishes, since cancelling it could leave half a
   * file; a MODEL call and an EXEC are cancelled at once. `drained` is called when none is left.
   */
  pause(drained: () => void): void {
    this.#held = true;
    this.#onDrained = drained;
    const { config, schedule, enqueue } = this.#deps;
    for (const attempt of this.#queues.running()) {
      if (attempt.executionId === undefined) continue;
      if (attempt.cls === 'MODEL' || attempt.cls === 'EXEC') this.#cancelSent(attempt, 'PAUSED');
      else if (attempt.cls === 'READ')
        this.#drainTimers.add(
          schedule(config.pauseDrainMs, () => {
            enqueue(() => {
              if (this.#queues.running().includes(attempt)) this.#cancelSent(attempt, 'PAUSED');
            });
          }),
        );
    }
    this.#checkDrained();
  }

  /** What was held starts again, oldest first. */
  async resume(): Promise<void> {
    this.#held = false;
    this.#onDrained = undefined;
    for (const stop of this.#drainTimers) stop();
    this.#drainTimers.clear();
    await this.drainCapacityWaiters();
    await this.#pump();
  }

  /**
   * ABORT (M2Design 4.5): everything that exists now is cancelled and answers INTERRUPTED(ABORTED),
   * queued attempts included. Attempts made afterwards, such as the closing reply, are no concern of
   * this: the run's admission decides what may still be submitted. `runEpoch` does not move.
   */
  abort(): void {
    this.#held = false;
    this.#onDrained = undefined;
    for (const stop of this.#drainTimers) stop();
    this.#drainTimers.clear();
    for (const attempt of this.#queues.drainQueued())
      attempt.attempts.interruptUnsent(attempt.unitAttemptId, 'ABORTED');
    const sent: Attempt[] = [];
    for (const attempt of [...this.#queues.running(), ...this.#queues.waiting()]) {
      if (attempt.executionId !== undefined) {
        sent.push(attempt);
        this.#cancelSent(attempt, 'ABORTED');
        continue;
      }
      if (attempt.state === 'WAITING') {
        // Parked, never sent: it ends here. One still being built ends when the build returns.
        attempt.attempts.interruptUnsent(attempt.unitAttemptId, 'ABORTED');
        this.#queues.release(attempt);
      } else attempt.cancelReason = 'ABORTED';
    }
    if (sent.length === 0) return;
    const { config, enqueue, schedule } = this.#deps;
    this.#cancelFallback = schedule(config.cancelGraceMs + config.convergenceMarginMs, () => {
      enqueue(() => {
        for (const attempt of sent) {
          if (attempt.executionId === undefined || !this.#queues.running().includes(attempt))
            continue;
          this.#noteStop(attempt, attempt.executionId);
          void this.#finish(attempt, {
            executionId: attempt.executionId,
            outcome: 'STOP_UNCONFIRMED',
          });
        }
      });
    });
    // The pump looks again: what ended queues no more behind it.
    void this.#pump();
  }

  /** Nothing is in flight any more. */
  closed(): void {
    this.#cancelFallback?.();
    this.#cancelFallback = undefined;
  }
}
