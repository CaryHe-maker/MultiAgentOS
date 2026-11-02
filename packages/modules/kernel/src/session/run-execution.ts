import {
  MEDIA_TYPES,
  newId,
  type ArtifactRef,
  type ExecutionScope,
  type CancelRunExecutionsRequest,
  type ExecutionFactV1,
  type ExecutionRequestV1,
  type ExecutorKind,
  type UnknownEffect,
} from '@multiagentos/contracts';
import {
  AttemptRequestBuilder,
  RequestBuildError,
  type BuiltRequest,
  type ExecutionConfig,
} from './attempt-request.js';
import { publishMessage, publishReport, type BuiltInResult } from './built-in-units.js';
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
  readonly dispatch: (request: ExecutionRequestV1) => Promise<void>;
  readonly cancelRun: (request: CancelRunExecutionsRequest) => Promise<void>;
  readonly retrying: (activity: RetryingActivity) => void;
  /** Undefined when the file does not exist. */
  readonly readRepositoryFile: (path: string, scope: ExecutionScope) => Promise<string | undefined>;
  /** Runs `work` as a control message of the actor; a timer only does this. */
  readonly enqueue: (work: () => void) => void;
  readonly schedule: (delayMs: number, due: () => void) => () => void;
  readonly now: () => Date;
  readonly newExecutionId?: () => string;
  readonly newAttemptId?: () => string;
}

interface Attempt {
  readonly spec: AttemptSpec;
  readonly unitAttemptId: string;
  readonly attempts: RunAttempts;
  executionId?: string;
  retries: number;
}

type Completed = Extract<ExecutionFactV1, { outcome: 'COMPLETED' }>;
type NotCompleted = Exclude<ExecutionFactV1, { outcome: 'COMPLETED' }>;

const toolLimitOf = (fact: Completed, config: ExecutionConfig) => {
  const { executionKind } = fact;
  return executionKind === 'MODEL' || executionKind === 'CONTEXT_ASSEMBLE'
    ? undefined
    : config.executionLimits[executionKind];
};

/**
 * One run's attempts in Execution (Kernel/Execution): a FIFO with one attempt at a time, the
 * storage of results and technical retries. Every method runs inside a message of the Session
 * actor; I/O on local artifacts may be awaited there (Kernel/Interaction 5.4).
 */
export class RunExecution {
  readonly #deps: RunExecutionDeps;
  readonly #builder: AttemptRequestBuilder;
  readonly #queue: Attempt[] = [];
  readonly #byId = new Map<string, Attempt>();
  readonly #effects: UnknownEffect[] = [];
  #active: Attempt | undefined;
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
    const attempt: Attempt = { spec, unitAttemptId, attempts, retries: 0 };
    this.#byId.set(unitAttemptId, attempt);
    this.#queue.push(attempt);
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

  async #pump(): Promise<void> {
    if (this.#active !== undefined) return;
    const next = this.#queue.shift();
    if (next === undefined) return;
    this.#active = next;
    await this.#run(next);
  }

  async #finish(attempt: Attempt, check: Omit<ResultCheck, 'unitAttemptId'>): Promise<void> {
    attempt.attempts.submitResultCheck({ unitAttemptId: attempt.unitAttemptId, ...check });
    if (this.#active === attempt) this.#active = undefined;
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
    const executionId = this.#deps.newExecutionId?.() ?? newId('exe');
    let built: BuiltRequest;
    try {
      built = await this.#builder.build(attempt.spec, {
        sessionId: this.#deps.sessionId,
        workflowRunId: this.#deps.workflowRunId,
        unitAttemptId: attempt.unitAttemptId,
        executionId,
        ...(notBefore === undefined ? {} : { notBefore }),
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
        // Core has already ended the attempt, with a report or with the run.
        if (this.#active === attempt) this.#active = undefined;
        await this.#pump();
        return;
      }
    }
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

  /** One terminal fact of the Supervisor; anything stale is dropped here. */
  async handleFact(fact: ExecutionFactV1): Promise<void> {
    const attempt = this.#byId.get(fact.unitAttemptId);
    if (
      attempt === undefined ||
      attempt.executionId !== fact.executionId ||
      fact.runEpoch !== attempt.spec.runEpoch ||
      fact.executionKind !== attempt.spec.unit.executionKind
    )
      return;
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
    await this.#finish(attempt, {
      executionId: fact.executionId,
      outcome: 'COMPLETED',
      output: result.output,
      ...refs,
      ...model,
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
      if (this.#active === attempt) this.#active = undefined;
      await this.#pump();
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
    for (const attempt of this.#queue.splice(0)) attempt.attempts.abandon(attempt.unitAttemptId);
    const active = this.#active;
    if (active === undefined) return;
    if (active.executionId === undefined) {
      active.attempts.abandon(active.unitAttemptId);
      this.#active = undefined;
      return;
    }
    const { config, enqueue, schedule, workflowRunId, cancelRun } = this.#deps;
    this.#cancelFallback = schedule(config.cancelGraceMs + config.convergenceMarginMs, () => {
      enqueue(() => {
        if (this.#active !== active || active.executionId === undefined) return;
        this.#noteStop(active, active.executionId);
        void this.#finish(active, {
          executionId: active.executionId,
          outcome: 'STOP_UNCONFIRMED',
        });
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
