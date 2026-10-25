import {
  canonicalJson,
  MEDIA_TYPES,
  newId,
  ReportPublishInputSchema,
  validate,
  type ArtifactRef,
  type ArtifactStorePort,
  type ExecutionFact,
  type ExecutorKind,
  type KernelConfig,
  type ProtocolRegistry,
  type ReportPublishInput,
  type ReportPublishOutput,
  type RunSummary,
  type UnknownEffect,
  type UnitDefinition,
} from '@multiagentos/contracts';
import type {
  AttemptSpec,
  CoreSyscalls,
  ExecutionDuties,
  ResultCheck,
  RetryDecision,
} from '../interfaces/index.js';
import { ArtifactOwnership } from './artifact-ownership.js';
import type { ExecutionRecord, UnitAttempt } from './attempt.js';
import type { AttemptDispatcher } from './dispatcher.js';
import { AttemptQueue } from './queue.js';
import { ExecutionRequestBuilder, RequestBuildError } from './request-builder.js';

export interface ExecutionDeps {
  /** Execution calls Core only through the private syscall surface. */
  readonly core: CoreSyscalls;
  /** The Supervisor-facing dispatch; stage 2.4 adds retry/back-off around it. */
  readonly dispatcher: AttemptDispatcher;
  /** The run whose artifacts Execution owns and writes. */
  readonly workflowRunId: string;
  readonly artifacts: ArtifactStorePort;
  readonly config: KernelConfig;
  readonly registry: ProtocolRegistry;
  /** Optional injection point for tests and recovery; defaults to an empty index. */
  readonly ownership?: ArtifactOwnership;
  readonly now?: () => Date;
  readonly newAttemptId?: () => string;
  readonly newExecutionId?: () => string;
  /**
   * Called after Execution settles or dispatches an attempt outside the actor's current
   * dispatch. The actor uses it to flush what asynchronous work queued: events of built-in
   * Units (report-publish), late dispatch failures and the execute request of an attempt whose
   * start had to read artifacts first; while a handler is running the actor defers to its
   * normal flush.
   */
  readonly onSettled?: () => void;
}

/**
 * One run's Execution state (docs/M1/Kernel/Execution.md). Stages 2.1–2.2 established the
 * attempt lifecycle, FIFO, artifact ownership, report-publish and RunSummary. Stage 2.3 adds
 * the five ExecutionRequests, context/model input resolution and reservation requests.
 */
export class Execution implements ExecutionDuties {
  readonly #core: CoreSyscalls;
  readonly #dispatcher: AttemptDispatcher;
  readonly #workflowRunId: string;
  readonly #artifacts: ArtifactStorePort;
  readonly #config: KernelConfig;
  readonly #now: () => Date;
  readonly #newAttemptId: () => string;
  readonly #newExecutionId: () => string;
  readonly #onSettled: (() => void) | undefined;
  readonly #builder: ExecutionRequestBuilder;
  readonly #ownership: ArtifactOwnership;
  readonly #queue = new AttemptQueue();
  readonly #byRequest = new Map<string, UnitAttempt>();
  readonly #byAttempt = new Map<string, UnitAttempt>();
  #active: UnitAttempt | undefined;
  #modelRequests = 0;

  public constructor(deps: ExecutionDeps) {
    if (!Number.isSafeInteger(deps.config.maxReportBytes) || deps.config.maxReportBytes <= 0)
      throw new Error('maxReportBytes must be a positive safe integer');
    this.#core = deps.core;
    this.#dispatcher = deps.dispatcher;
    this.#workflowRunId = deps.workflowRunId;
    this.#artifacts = deps.artifacts;
    this.#config = deps.config;
    this.#now = deps.now ?? (() => new Date());
    this.#newAttemptId = deps.newAttemptId ?? (() => newId('una'));
    this.#newExecutionId = deps.newExecutionId ?? (() => newId('exe'));
    this.#onSettled = deps.onSettled;
    this.#ownership = deps.ownership ?? new ArtifactOwnership();
    this.#builder = new ExecutionRequestBuilder({
      config: this.#config,
      registry: deps.registry,
      workflowRunId: this.#workflowRunId,
      now: this.#now,
      readArtifact: (ref) => this.readArtifact(ref),
    });
  }

  public createAttempt(spec: AttemptSpec): Promise<string> {
    const existing = this.#byRequest.get(spec.requestId);
    if (existing !== undefined) {
      if (!sameSpec(existing, spec))
        return Promise.reject(new Error(`Conflicting attempt for requestId ${spec.requestId}`));
      return Promise.resolve(existing.unitAttemptId);
    }

    const attempt: UnitAttempt = {
      unitAttemptId: this.#newAttemptId(),
      requestId: spec.requestId,
      agentRunId: spec.agentRunId,
      unit: spec.unit,
      input: spec.input,
      scope: spec.scope,
      pinned: spec.pinned,
      runEpoch: spec.runEpoch,
      state: 'QUEUED',
      executions: [],
      retryCount: 0,
    };
    this.#byRequest.set(attempt.requestId, attempt);
    this.#byAttempt.set(attempt.unitAttemptId, attempt);
    this.#core.registerAttempt({
      unitAttemptId: attempt.unitAttemptId,
      requestId: attempt.requestId,
      agentRunId: attempt.agentRunId,
      runEpoch: attempt.runEpoch,
      executionKind: attempt.unit.executionKind,
      requiresLease: attempt.unit.protectedCapabilities.includes('repo.read'),
    });
    this.#queue.enqueue(attempt);
    this.#pump();
    return Promise.resolve(attempt.unitAttemptId);
  }

  /**
   * Routes one terminal execution fact. A retryable MODEL/other failure may create a new
   * execution instance; all other outcomes settle through Core exactly once.
   */
  public async handleExecutionFact(fact: ExecutionFact): Promise<void> {
    const attempt = this.#byAttempt.get(fact.unitAttemptId);
    if (attempt === undefined) return;
    if (attempt.state === 'CHECKED' || attempt.state === 'ABORTED') return;
    if (fact.runEpoch !== attempt.runEpoch) return;
    if (fact.executionKind !== attempt.unit.executionKind) return;
    const execution = attempt.executions.find((entry) => entry.executionId === fact.executionId);
    if (execution === undefined || execution.outcome !== undefined) return;

    execution.outcome = fact.outcome;
    if (fact.executionKind === 'MODEL') execution.requestState = fact.requestState;

    if (fact.outcome === 'COMPLETED') {
      await this.#completeExecution(attempt, execution, fact);
      return;
    }

    if (fact.outcome === 'FAILED' && fact.retryable) {
      const retried = await this.#retryAttempt(attempt, execution, fact);
      if (retried) return;
    }

    this.#finish(attempt, this.#resultCheck(attempt, execution, fact));
  }

  async #completeExecution(
    attempt: UnitAttempt,
    execution: ExecutionRecord,
    fact: Extract<ExecutionFact, { outcome: 'COMPLETED' }>,
  ): Promise<void> {
    const deliverable = this.#core.currentRunEpoch() === attempt.runEpoch;
    let outputRef: ArtifactRef | undefined;
    if (deliverable) {
      try {
        const content = Buffer.from(fact.result.artifact.text, 'utf8');
        outputRef = await this.#artifacts.put(
          this.#workflowRunId,
          content,
          fact.result.artifact.mediaType,
        );
        this.#ownership.register(outputRef, attempt.unitAttemptId);
        attempt.outputRef = outputRef;
      } catch {
        this.#finish(attempt, {
          unitAttemptId: attempt.unitAttemptId,
          executionId: execution.executionId,
          outcome: 'FAILED',
          reasonCode: 'INTERNAL',
          ...(fact.executionKind === 'MODEL' ? { requestState: 'SENT' as const } : {}),
          ...(fact.executionKind === 'MODEL' && fact.usage !== undefined
            ? { usage: fact.usage }
            : {}),
        });
        return;
      }
    }

    this.#finish(attempt, {
      unitAttemptId: attempt.unitAttemptId,
      executionId: execution.executionId,
      outcome: 'COMPLETED',
      output: fact.result.output,
      ...(outputRef === undefined ? {} : { outputRef }),
      ...(fact.executionKind === 'MODEL' && fact.usage !== undefined ? { usage: fact.usage } : {}),
      ...(fact.executionKind === 'MODEL' ? { requestState: fact.requestState } : {}),
    });
  }

  /** Returns true when the attempt was retried or otherwise ended; false means settle now. */
  async #retryAttempt(
    attempt: UnitAttempt,
    execution: ExecutionRecord,
    fact: Extract<ExecutionFact, { outcome: 'FAILED' }>,
  ): Promise<boolean> {
    let decision: RetryDecision;
    try {
      decision = this.#core.retryExecution({
        unitAttemptId: attempt.unitAttemptId,
        previousExecutionId: execution.executionId,
        ...(fact.executionKind === 'MODEL' ? { requestState: fact.requestState } : {}),
        ...(fact.executionKind === 'MODEL' && fact.usage !== undefined
          ? { usage: fact.usage }
          : {}),
      });
    } catch {
      return false;
    }

    if (decision.allowed) {
      if (decision.reservationId !== undefined) attempt.reservationId = decision.reservationId;
      if (decision.grantId !== undefined) attempt.grantId = decision.grantId;
      await this.#dispatchRetry(attempt);
      return true;
    }
    if (decision.reason === 'BUDGET_WRAP_UP' || decision.reason === 'BUDGET_EXHAUSTED') {
      // Core already delivered the budget UnitReport and abandoned the attempt.
      this.#abandonAttempt(attempt);
      return true;
    }
    return false;
  }

  async #dispatchRetry(attempt: UnitAttempt): Promise<void> {
    const retryCount = attempt.retryCount + 1;
    const notBefore = new Date(
      this.#now().getTime() + this.#config.retryBackoffBaseMs * 2 ** Math.max(0, retryCount - 1),
    ).toISOString();
    const execution: ExecutionRecord = {
      executionId: this.#newExecutionId(),
      notBefore,
    };
    attempt.retryCount = retryCount;
    attempt.executions.push(execution);

    try {
      this.#core.registerExecution({
        unitAttemptId: attempt.unitAttemptId,
        executionId: execution.executionId,
        runEpoch: attempt.runEpoch,
      });
      let built;
      try {
        built = await this.#builder.build(attempt, execution);
      } catch {
        this.#finish(attempt, {
          unitAttemptId: attempt.unitAttemptId,
          executionId: execution.executionId,
          outcome: 'FAILED',
          reasonCode: 'INTERNAL',
          ...(attempt.unit.executionKind === 'MODEL' ? { requestState: 'NOT_SENT' as const } : {}),
        });
        return;
      }
      attempt.state = 'DISPATCHED';
      execution.dispatchedAt = this.#now().toISOString();
      if (attempt.unit.executionKind === 'MODEL') this.#modelRequests += 1;
      await this.#dispatcher.dispatch(built.request);
    } catch {
      this.#onDispatchFailure(attempt, execution);
    }
  }

  #resultCheck(
    attempt: UnitAttempt,
    execution: ExecutionRecord,
    fact: Exclude<ExecutionFact, { outcome: 'COMPLETED' }>,
  ): ResultCheck {
    return {
      unitAttemptId: attempt.unitAttemptId,
      executionId: execution.executionId,
      outcome: fact.outcome,
      reasonCode: fact.reasonCode,
      ...(fact.executionKind === 'MODEL' && fact.usage !== undefined ? { usage: fact.usage } : {}),
      ...(fact.executionKind === 'MODEL' ? { requestState: fact.requestState } : {}),
      ...(fact.outcome === 'STOP_UNCONFIRMED' ? { stopVerdictBy: 'SUPERVISOR' as const } : {}),
    };
  }

  public abortQueued(): {
    readonly inFlight: readonly { readonly unitAttemptId: string; readonly executionId: string }[];
  } {
    const queued = this.#queue.clear();
    for (const attempt of queued) attempt.state = 'ABORTED';

    const inFlight: { unitAttemptId: string; executionId: string }[] = [];
    const active = this.#active;
    if (active !== undefined && active.state !== 'ABORTED' && active.state !== 'CHECKED') {
      const execution = active.executions.find((entry) => entry.outcome === undefined);
      if (execution === undefined) {
        active.state = 'ABORTED';
        this.#active = undefined;
      } else {
        inFlight.push({
          unitAttemptId: active.unitAttemptId,
          executionId: execution.executionId,
        });
      }
    }
    return { inFlight };
  }

  /** Convergence fallback: Core judged these executions as not confirmed stopped. */
  public synthesizeStopUnconfirmed(executionIds: readonly string[]): void {
    for (const executionId of executionIds) {
      const found = this.#findExecution(executionId);
      if (found === undefined || found.execution.outcome !== undefined) continue;
      found.execution.outcome = 'STOP_UNCONFIRMED';
      this.#finish(found.attempt, {
        unitAttemptId: found.attempt.unitAttemptId,
        executionId,
        outcome: 'STOP_UNCONFIRMED',
        stopVerdictBy: 'CORE',
      });
    }
  }

  /** Artifact ownership is checked against this run's index before any store read. */
  public ownsArtifact(ref: ArtifactRef): boolean {
    return this.#ownership.owns(ref);
  }

  /** Read content only after ownership passed; ArtifactStore verifies integrity again. */
  public async readArtifact(
    ref: ArtifactRef,
  ): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
    if (!this.#ownership.owns(ref)) return { ok: false };
    try {
      const content = await this.#artifacts.get(this.#workflowRunId, ref);
      return { ok: true, text: Buffer.from(content).toString('utf8') };
    } catch {
      return { ok: false };
    }
  }

  public collectUnknownEffects(): UnknownEffect[] {
    const effects: UnknownEffect[] = [];
    for (const attempt of this.#byAttempt.values()) {
      const kind = attempt.unit.executionKind;
      if (!isExecutorKind(kind)) continue;
      for (const execution of attempt.executions) {
        if (execution.outcome === 'STOP_UNCONFIRMED') {
          effects.push({
            unitAttemptId: attempt.unitAttemptId,
            executionId: execution.executionId,
            executionKind: kind,
            effect: 'EXECUTION_STOP_UNCONFIRMED',
          });
        } else if (
          execution.outcome === undefined &&
          kind === 'MODEL' &&
          execution.requestState === 'UNKNOWN'
        ) {
          effects.push({
            unitAttemptId: attempt.unitAttemptId,
            executionId: execution.executionId,
            executionKind: 'MODEL',
            effect: 'MODEL_REQUEST_UNCONFIRMED',
          });
        }
      }
    }
    return effects;
  }

  /** MODEL execution instances dispatched to the Supervisor, technical retries included. */
  public modelRequestCount(): number {
    return this.#modelRequests;
  }

  /** Publish the run summary; this is allowed after the run stopped being RUNNING. */
  public async publishRunSummary(summary: RunSummary): Promise<ArtifactRef> {
    const content = Buffer.from(canonicalJson(summary), 'utf8');
    const ref = await this.#artifacts.put(this.#workflowRunId, content, MEDIA_TYPES.runSummary);
    this.#ownership.register(ref, 'RUN_SUMMARY');
    return ref;
  }

  #pump(): void {
    if (this.#active !== undefined) return;
    const next = this.#queue.dequeue();
    if (next === undefined) return;
    if (next.state !== 'QUEUED') {
      this.#pump();
      return;
    }
    if (this.#core.currentRunEpoch() !== next.runEpoch) {
      next.state = 'ABORTED';
      this.#pump();
      return;
    }
    next.state = 'STARTING';
    this.#active = next;
    // Building the request reads artifacts, so the attempt may dispatch after the message that
    // started it was already flushed; without this its execute request would wait for the next
    // unrelated message.
    void this.#startAttempt(next).finally(() => this.#onSettled?.());
  }

  async #startAttempt(attempt: UnitAttempt): Promise<void> {
    if (attempt.state !== 'STARTING') return;
    if (this.#core.currentRunEpoch() !== attempt.runEpoch) {
      this.#abortAttempt(attempt);
      return;
    }
    if (attempt.unit.executionKind === 'REPORT_PUBLISH') {
      await this.#publishReport(attempt);
      return;
    }

    const execution: ExecutionRecord = { executionId: this.#newExecutionId() };
    let built;
    try {
      built = await this.#builder.build(attempt, execution);
    } catch (error) {
      if (this.#core.currentRunEpoch() !== attempt.runEpoch) {
        this.#abandonAttempt(attempt);
      } else if (error instanceof RequestBuildError) {
        this.#finish(attempt, {
          unitAttemptId: attempt.unitAttemptId,
          outcome: 'NOT_DISPATCHED',
          reasonCode: error.reasonCode,
        });
      } else {
        this.#finish(attempt, {
          unitAttemptId: attempt.unitAttemptId,
          outcome: 'FAILED',
          reasonCode: 'INTERNAL',
        });
      }
      return;
    }
    if (attempt.state !== 'STARTING') return;
    if (this.#core.currentRunEpoch() !== attempt.runEpoch) {
      this.#abandonAttempt(attempt);
      return;
    }

    if (built.reservation !== undefined) {
      let decision;
      try {
        decision = this.#core.requestReservation({
          unitAttemptId: attempt.unitAttemptId,
          estimatedTokens: built.reservation.estimatedTokens,
          final: built.reservation.final,
        });
      } catch {
        this.#finish(attempt, {
          unitAttemptId: attempt.unitAttemptId,
          outcome: 'FAILED',
          reasonCode: 'INTERNAL',
        });
        return;
      }
      if (!decision.granted) {
        // Core already delivered the budget/final-call UnitReport for most reasons; a
        // RUN_CONVERGING rejection just ends the attempt with the run.
        this.#abandonAttempt(attempt);
        return;
      }
      attempt.reservationId = decision.reservationId;
      attempt.grantId = decision.grantId;
    }

    try {
      attempt.executions.push(execution);
      this.#core.registerExecution({
        unitAttemptId: attempt.unitAttemptId,
        executionId: execution.executionId,
        runEpoch: attempt.runEpoch,
      });
      attempt.state = 'DISPATCHED';
      execution.dispatchedAt = this.#now().toISOString();
      if (attempt.unit.executionKind === 'MODEL') this.#modelRequests += 1;
      await this.#dispatcher.dispatch(built.request);
    } catch {
      this.#onDispatchFailure(attempt, execution);
    }
  }

  #abandonAttempt(attempt: UnitAttempt): void {
    if (attempt.state === 'CHECKED' || attempt.state === 'ABORTED') return;
    attempt.state = 'CHECKED';
    if (this.#active === attempt) this.#active = undefined;
    this.#pump();
  }

  /** Built-in Unit: write the report without involving the Supervisor or an Executor. */
  async #publishReport(attempt: UnitAttempt): Promise<void> {
    try {
      const input = validate<ReportPublishInput>(ReportPublishInputSchema, attempt.input);
      if (!input.ok) {
        this.#finish(attempt, {
          unitAttemptId: attempt.unitAttemptId,
          outcome: 'NOT_DISPATCHED',
          reasonCode: 'INVALID_INPUT',
        });
        return;
      }
      const report = input.value.report;
      const content = Buffer.from(canonicalJson(report), 'utf8');
      if (content.byteLength > this.#config.maxReportBytes) {
        this.#finish(attempt, {
          unitAttemptId: attempt.unitAttemptId,
          outcome: 'REJECTED',
          reasonCode: 'LIMIT_EXCEEDED',
        });
        return;
      }
      const ref = await this.#artifacts.put(
        this.#workflowRunId,
        content,
        MEDIA_TYPES.analysisReport,
      );
      if (attempt.state !== 'STARTING') return;
      this.#ownership.register(ref, attempt.unitAttemptId);
      const output: ReportPublishOutput = {
        conclusionCount: report.conclusions.length,
        unconfirmedCount: report.unconfirmed.length,
        degraded: report.degraded,
      };
      attempt.outputRef = ref;
      this.#finish(attempt, {
        unitAttemptId: attempt.unitAttemptId,
        outcome: 'COMPLETED',
        output,
        outputRef: ref,
      });
    } catch {
      this.#finish(attempt, {
        unitAttemptId: attempt.unitAttemptId,
        outcome: 'FAILED',
        reasonCode: 'INTERNAL',
      });
    }
  }

  #onDispatchFailure(attempt: UnitAttempt, execution: ExecutionRecord): void {
    if (attempt.state === 'CHECKED' || attempt.state === 'ABORTED') return;
    execution.outcome = 'FAILED';
    if (attempt.unit.executionKind === 'MODEL') execution.requestState = 'UNKNOWN';
    this.#finish(attempt, {
      unitAttemptId: attempt.unitAttemptId,
      executionId: execution.executionId,
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
      ...(attempt.unit.executionKind === 'MODEL' ? { requestState: 'UNKNOWN' as const } : {}),
    });
  }

  #abortAttempt(attempt: UnitAttempt): void {
    attempt.state = 'ABORTED';
    if (this.#active === attempt) this.#active = undefined;
    this.#pump();
  }

  #finish(attempt: UnitAttempt, check: ResultCheck): void {
    if (attempt.state === 'CHECKED' || attempt.state === 'ABORTED') return;
    attempt.state = 'CHECKED';
    this.#core.submitResultCheck(check);
    if (this.#active === attempt) this.#active = undefined;
    this.#pump();
    this.#onSettled?.();
  }

  #findExecution(
    executionId: string,
  ): { readonly attempt: UnitAttempt; readonly execution: ExecutionRecord } | undefined {
    for (const attempt of this.#byAttempt.values()) {
      const execution = attempt.executions.find((entry) => entry.executionId === executionId);
      if (execution !== undefined) return { attempt, execution };
    }
    return undefined;
  }
}

export function createExecution(deps: ExecutionDeps): Execution {
  return new Execution(deps);
}

export { ArtifactOwnership } from './artifact-ownership.js';
export type { ExecutionRecord, UnitAttempt } from './attempt.js';
export type { AttemptDispatcher } from './dispatcher.js';

function sameSpec(attempt: UnitAttempt, spec: AttemptSpec): boolean {
  return (
    attempt.agentRunId === spec.agentRunId &&
    attempt.runEpoch === spec.runEpoch &&
    attempt.unit.id === spec.unit.id &&
    attempt.unit.version === spec.unit.version &&
    attempt.unit.digest === spec.unit.digest &&
    canonicalJson(attempt.input) === canonicalJson(spec.input) &&
    canonicalJson(attempt.scope) === canonicalJson(spec.scope)
  );
}

function isExecutorKind(kind: UnitDefinition['executionKind']): kind is ExecutorKind {
  return (
    kind === 'REPOSITORY_ORIENT' ||
    kind === 'REPOSITORY_SEARCH' ||
    kind === 'FILE_READ' ||
    kind === 'CONTEXT_ASSEMBLE' ||
    kind === 'MODEL'
  );
}
