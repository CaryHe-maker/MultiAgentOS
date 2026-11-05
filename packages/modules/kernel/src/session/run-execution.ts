import {
  MEDIA_TYPES,
  newId,
  type ArtifactRef,
  type ExecutionScope,
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
import { AttemptQueues, type ConcurrencyClass, type QueueEntry } from './execution-queues.js';
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
  readonly retrying: (activity: RetryingActivity) => void;
  /** A write landed; awaited, so that whatever follows from it precedes the report. */
  readonly written: (path: string, sha256: string) => Promise<void>;
  /** Undefined when the file does not exist. */
  readonly readRepositoryFile: (path: string, scope: ExecutionScope) => Promise<string | undefined>;
  /** Runs `work` as a control message of the actor; a timer only does this. */
  readonly enqueue: (work: () => void) => void;
  readonly schedule: (delayMs: number, due: () => void) => () => void;
  readonly now: () => Date;
  /**
   * Protected paths a command may not create (Kernel/Execution 9, M2Design 6.1): the set that
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
  /** UnitAttempts executing at once over all AgentRuns (`kernel.maxConcurrentAttempts`). */
  readonly maxConcurrentAttempts?: number;
  /** Commands that write executing at once (`kernel.maxConcurrentExec`). */
  readonly maxConcurrentExec?: number;
  /** Every Unit a barrier and one attempt at a time (`kernel.serialExecution`). */
  readonly serialExecution?: boolean;
  readonly newExecutionId?: () => string;
  readonly newAttemptId?: () => string;
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
  /** The protected paths that existed when a command was first dispatched. */
  protectedBefore?: ReadonlySet<string>;
  changedBefore?: Fingerprints | undefined;
  /** Built, and waiting for a call slot to be reserved (M2Design 7.2). */
  built?: { readonly request: BuiltRequest; readonly executionId: string };
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

type Completed = Extract<ExecutionFact, { outcome: 'COMPLETED' }>;
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
  readonly #effects: UnknownEffect[] = [];
  #seq = 0;
  #pumping = false;
  #again = false;
  #cancelFallback: (() => void) | undefined;

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

  get #limits() {
    return {
      maxAttempts: this.#deps.maxConcurrentAttempts ?? 6,
      maxExec: this.#deps.maxConcurrentExec ?? 1,
      serial: this.#deps.serialExecution === true,
    };
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
        const started = this.#queues.startable(this.#limits);
        await Promise.all(started.map((attempt) => this.#run(attempt)));
      } while (this.#again);
    } finally {
      this.#pumping = false;
    }
  }

  async #finish(attempt: Attempt, check: Omit<ResultCheck, 'unitAttemptId'>): Promise<void> {
    attempt.attempts.submitResultCheck({ unitAttemptId: attempt.unitAttemptId, ...check });
    this.#queues.release(attempt);
    await this.#pump();
  }

  /** The attempt is over without a result of its own: Core ended it, with a report or the run. */
  async #dropped(attempt: Attempt): Promise<void> {
    this.#queues.release(attempt);
    await this.#pump();
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

  async #dispatch(attempt: Attempt, notBefore?: string): Promise<void> {
    const guard = this.#deps.protectedPaths;
    if (
      guard !== undefined &&
      attempt.spec.unit.executionKind === 'COMMAND' &&
      attempt.protectedBefore === undefined
    ) {
      try {
        attempt.protectedBefore = await guard.snapshot();
      } catch {
        // Without a "before" there is nothing to compare; the sandbox still protects what exists.
      }
    }
    const { changes } = this.#deps;
    const roots = commandRootsOf(attempt.spec);
    if (
      changes !== undefined &&
      attempt.spec.unit.executionKind === 'COMMAND' &&
      attempt.changedBefore === undefined &&
      roots.length > 0
    ) {
      try {
        attempt.changedBefore = await changes.snapshot(roots);
      } catch {
        // Without a "before" the report names no files.
      }
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
    // A retry has its reservation already; only the first dispatch asks for one.
    if (built.reservation !== undefined && attempt.executionId === undefined) {
      const decision = attempt.attempts.requestReservation({
        unitAttemptId: attempt.unitAttemptId,
        ...built.reservation,
      });
      if (!decision.granted) {
        if (decision.reason === 'WAIT_CAPACITY') {
          // Every call slot is in use: it waits, uncounted, and asks again when one is free.
          attempt.built = { request: built, executionId };
          this.#queues.park(attempt);
          await this.#pump();
          return;
        }
        // Core has already ended the attempt, with a report or with the run.
        await this.#dropped(attempt);
        return;
      }
    }
    this.#send(attempt, built, executionId);
  }

  #send(attempt: Attempt, built: BuiltRequest, executionId: string): void {
    attempt.attempts.registerExecution(attempt.unitAttemptId, executionId);
    attempt.executionId = executionId;
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
    for (const attempt of this.#queues.waiting()) {
      const pending = attempt.built;
      if (pending === undefined || !this.#queues.resume(attempt, this.#limits)) break;
      const reservation = pending.request.reservation;
      if (reservation === undefined) {
        delete attempt.built;
        this.#send(attempt, pending.request, pending.executionId);
        continue;
      }
      const decision = attempt.attempts.requestReservation({
        unitAttemptId: attempt.unitAttemptId,
        ...reservation,
      });
      if (decision.granted) {
        delete attempt.built;
        this.#send(attempt, pending.request, pending.executionId);
        continue;
      }
      if (decision.reason === 'WAIT_CAPACITY') {
        this.#queues.park(attempt);
        break;
      }
      delete attempt.built;
      await this.#dropped(attempt);
    }
  }

  /** One terminal fact of the Supervisor; anything stale is dropped here. */
  async handleFact(fact: ExecutionFact): Promise<void> {
    const attempt = this.#byId.get(fact.unitAttemptId);
    if (
      attempt === undefined ||
      attempt.executionId !== fact.executionId ||
      fact.runEpoch !== attempt.spec.runEpoch ||
      fact.executionKind !== attempt.spec.unit.executionKind
    )
      return;
    if (await this.#createdProtected(attempt, fact)) return;
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

  /** Nothing is in flight any more. */
  closed(): void {
    this.#cancelFallback?.();
    this.#cancelFallback = undefined;
  }
}
