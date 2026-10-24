import {
  validate,
  type ArtifactContent,
  type ArtifactRef,
  type AdmissionProjection,
  type BoundaryContext,
  type CancelRunExecutionsRequest,
  type CatalogPort,
  type CloseReason,
  type CloseRunRequest,
  type CoreRejectedCode,
  type ExecutionScope,
  type GatewayForward,
  type KernelConfig,
  type ProtocolRegistry,
  type SyscallAck,
  type RunSummary,
  type SyscallRejected,
  type SystemFaultReporter,
  type UnitDefinition,
  type UnitInput,
  type UnitReport,
  type UnknownEffect,
} from '@multiagentos/contracts';
import type {
  AttemptSpec,
  CoreSyscalls,
  MonitorDuties,
  SchedulerDuties,
} from '../interfaces/index.js';
import type { AuditSink, CoreAuditEntry } from './audit.js';
import { CoreAttempts } from './attempts.js';
import { finalizeRunEvents } from './finalize-run.js';
import type { CoreEvent, CoreEventSink } from './events.js';
import type { CoreException, CoreExceptionOutcome } from './exceptions.js';
import { AuthorizationManager, type AuthorizationResolution } from './authorization.js';
import type { RunRequestHandler, RunResponse } from './run-registry.js';
import type { AgentRunRecord, RunState } from './run-state.js';
import { deriveExecutionScope } from './scope.js';

/** The part of Execution that Core needs before stage 1.4 adds attempts and results. */
interface ConvergenceState {
  readonly pending: Set<string>;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export interface CoreExecutionPort {
  createAttempt(spec: AttemptSpec): Promise<string>;
  abortQueued(): {
    readonly inFlight: readonly {
      readonly unitAttemptId: string;
      readonly executionId: string;
    }[];
  };
  synthesizeStopUnconfirmed(executionIds: readonly string[]): void;
  ownsArtifact(ref: ArtifactRef): boolean;
  readArtifact(
    ref: ArtifactRef,
  ): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }>;
  collectUnknownEffects(): UnknownEffect[];
  modelRequestCount(): number;
  publishRunSummary(summary: RunSummary): Promise<ArtifactRef>;
}

export type { CoreEvent, CoreEventSink } from './events.js';

export interface CoreSupervisorPort {
  cancelRun(request: CancelRunExecutionsRequest): Promise<void>;
}

export interface CoreRequestHandlerDeps {
  readonly catalog: CatalogPort;
  readonly registry: ProtocolRegistry;
  readonly execution: CoreExecutionPort;
  readonly monitor: MonitorDuties;
  readonly scheduler: SchedulerDuties;
  readonly audit: AuditSink;
  readonly config: KernelConfig;
  readonly events?: CoreEventSink;
  readonly admission?: (projection: AdmissionProjection) => void;
  readonly supervisor?: CoreSupervisorPort;
  readonly onRunClosed?: (run: RunState) => void;
  readonly reportSystemFault?: SystemFaultReporter;
  readonly now?: () => Date;
}

const UNSUPPORTED_KINDS = new Set(['FILE_WRITE', 'COMMAND', 'TEST']);

/**
 * Core's run-scoped request handling (docs/M1/Kernel/Interaction.md 4.5 and 5.1).
 * Stage 1.2 covers idempotency, the state matrix and the AgentRun lifecycle. Permission,
 * attempts, results, convergence and events are added by stages 1.3–1.5.
 */
export class CoreRequestHandler implements RunRequestHandler {
  readonly #catalog: CatalogPort;
  readonly #registry: ProtocolRegistry;
  readonly #execution: CoreExecutionPort;
  readonly #monitor: MonitorDuties;
  readonly #scheduler: SchedulerDuties;
  readonly #audit: AuditSink;
  readonly #config: KernelConfig;
  readonly #events: CoreEventSink | undefined;
  readonly #admission: CoreRequestHandlerDeps['admission'];
  readonly #supervisor: CoreSupervisorPort | undefined;
  readonly #onRunClosed: CoreRequestHandlerDeps['onRunClosed'];
  readonly #reportSystemFault: SystemFaultReporter | undefined;
  readonly #now: () => Date;
  readonly #convergences = new Map<string, ConvergenceState>();
  readonly #convergenceStarts = new Map<string, Promise<void>>();
  readonly #completing = new Set<string>();
  readonly #settledExecutions = new Set<string>();
  readonly #startedRuns = new Set<string>();
  readonly #settleRequested = new Set<string>();
  #authorization: AuthorizationManager | undefined;
  #authorizationRunId: string | undefined;
  #attempts: CoreAttempts | undefined;
  #attemptsRunId: string | undefined;

  public constructor(deps: CoreRequestHandlerDeps) {
    this.#catalog = deps.catalog;
    this.#registry = deps.registry;
    this.#execution = deps.execution;
    this.#monitor = deps.monitor;
    this.#scheduler = deps.scheduler;
    this.#audit = deps.audit;
    this.#config = deps.config;
    this.#events = deps.events;
    this.#admission = deps.admission;
    this.#supervisor = deps.supervisor;
    this.#onRunClosed = deps.onRunClosed;
    this.#reportSystemFault = deps.reportSystemFault;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * Handles `RUN_INIT`: the run is now active and Workflow receives its first event.
   * The run timer is scheduled by the actor (stage 4.4); time starts when this method runs.
   */
  public startRun(run: RunState): Promise<void> {
    if (run.runState !== 'RUNNING' || this.#startedRuns.has(run.workflowRunId))
      return Promise.resolve();
    this.#startedRuns.add(run.workflowRunId);
    this.#emit({ type: 'RunStart', goal: run.goal });
    return Promise.resolve();
  }

  public async handleForward(
    forward: GatewayForward,
    context: Readonly<BoundaryContext>,
    run: RunState,
  ): Promise<RunResponse> {
    const response = await this.#dispatchForward(forward, context, run);
    await this.settleConvergence(run);
    return response;
  }

  async #dispatchForward(
    forward: GatewayForward,
    context: Readonly<BoundaryContext>,
    run: RunState,
  ): Promise<RunResponse> {
    switch (forward.requestType) {
      case 'registerAgentRun':
        return this.#registerAgentRun(forward.request, context, run);
      case 'submitUnit':
        return this.#submitUnit(forward.request, run);
      case 'endAgentRun':
        return this.#endAgentRun(forward.request, run);
      case 'closeRun':
        return this.#closeRun(forward.request, run);
      case 'answerAuthorization':
        return this.#answerAuthorization(forward.request, run);
      case 'cancelRun':
        return this.#cancelRun(forward.request, run);
      case 'readArtifact':
        return this.#readArtifact(forward.request, run);
      case 'createRun':
      case 'shutdown':
        return Promise.reject(new Error('RunRegistry handles createRun and shutdown'));
    }
  }

  async #registerAgentRun(
    request: Extract<GatewayForward, { requestType: 'registerAgentRun' }>['request'],
    context: Readonly<BoundaryContext>,
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState !== 'RUNNING') return this.#runBlocked(run, request.requestId, request);

    if (run.agentRuns.has(request.agentRunId))
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_EXISTS');
    if ([...run.agentRuns.values()].some((agentRun) => agentRun.state === 'ACTIVE'))
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_ACTIVE');

    const pinned = await this.#catalog.pinAgent(
      { id: request.agentRef.id, version: request.agentRef.version },
      { ...context, workflowRunId: run.workflowRunId },
    );
    if (!pinned.ok) return this.#reject(run, request.requestId, request, 'DEFINITION_UNAVAILABLE');
    if (pinned.value.agent.digest !== request.agentRef.digest)
      return this.#reject(run, request.requestId, request, 'DEFINITION_MISMATCH');
    if (pinned.value.model.provider !== this.#config.provider)
      return this.#reject(run, request.requestId, request, 'FORBIDDEN');

    const agentRun: AgentRunRecord = {
      agentRunId: request.agentRunId,
      agentRef: request.agentRef,
      pinned: pinned.value,
      state: 'ACTIVE',
      registeredAt: this.#now().toISOString(),
      rounds: 0,
    };
    run.agentRuns.set(request.agentRunId, agentRun);
    await this.#audit.append({
      at: agentRun.registeredAt,
      workflowRunId: run.workflowRunId,
      type: 'AGENT_RUN_REGISTERED',
      requestId: request.requestId,
      agentRunId: request.agentRunId,
    });
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  async #submitUnit(
    request: Extract<GatewayForward, { requestType: 'submitUnit' }>['request'],
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState !== 'RUNNING') return this.#runBlocked(run, request.requestId, request);

    const agentRun = run.agentRuns.get(request.agentRunId);
    if (agentRun === undefined)
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_NOT_FOUND');
    if (agentRun.state === 'ENDED')
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_ENDED');

    const unit = agentRun.pinned.units.find(
      (candidate) =>
        candidate.id === request.unitRef.id &&
        candidate.version === request.unitRef.version &&
        candidate.digest === request.unitRef.digest,
    );
    if (unit === undefined) return this.#reject(run, request.requestId, request, 'FORBIDDEN');
    if (UNSUPPORTED_KINDS.has(unit.executionKind))
      return this.#reject(run, request.requestId, request, 'UNSUPPORTED_CAPABILITY');

    const inputSchema = this.#registry.resolveContract(unit.inputContract);
    if (!validate(inputSchema, request.input).ok)
      return this.#reject(run, request.requestId, request, 'INVALID_INPUT');

    const authorization = this.#authorizationFor(run);
    const check = authorization.check(request.requestId, unit);
    if (check.requested !== undefined) {
      this.#emit(check.requested);
      await this.#audit.append({
        at: this.#now().toISOString(),
        workflowRunId: run.workflowRunId,
        type: 'AUTHORIZATION_ASKED',
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        questionId: check.requested.questionId,
      });
    }

    if (check.decision.kind === 'ALLOWED') {
      const scope = deriveExecutionScope(unit, agentRun, authorization.lease);
      run.unitDecisions.set(request.requestId, { kind: 'ALLOWED', scope });
      await this.#startAttempt(run, agentRun, unit, request.input, request.requestId, scope);
    } else if (check.decision.kind === 'PENDING') {
      run.unitDecisions.set(request.requestId, {
        kind: 'PENDING',
        questionId: check.decision.questionId,
      });
      run.awaitingAuthorization.set(request.requestId, {
        unit,
        input: request.input,
        agentRunId: request.agentRunId,
        questionId: check.decision.questionId,
      });
    } else {
      run.unitDecisions.set(request.requestId, {
        kind: 'DECLINED',
        reasonCode: 'USER_DECLINED',
      });
      await this.#emitDenied(run, request.requestId, request.agentRunId, unit);
    }

    run.units.submitted += 1;
    await this.#audit.append({
      at: this.#now().toISOString(),
      workflowRunId: run.workflowRunId,
      type: 'UNIT_ACCEPTED',
      requestId: request.requestId,
      agentRunId: request.agentRunId,
    });
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  async #endAgentRun(
    request: Extract<GatewayForward, { requestType: 'endAgentRun' }>['request'],
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState !== 'RUNNING')
      return this.#remember(run, request.requestId, request, ack(request.requestId));

    const agentRun = run.agentRuns.get(request.agentRunId);
    if (agentRun === undefined)
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_NOT_FOUND');
    if (agentRun.state === 'ENDED')
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_ENDED');

    agentRun.state = 'ENDED';
    agentRun.endedAt = this.#now().toISOString();
    await this.#audit.append({
      at: agentRun.endedAt,
      workflowRunId: run.workflowRunId,
      type: 'AGENT_RUN_ENDED',
      requestId: request.requestId,
      agentRunId: request.agentRunId,
    });
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  async #closeRun(request: CloseRunRequest, run: RunState): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState !== 'RUNNING')
      return this.#remember(run, request.requestId, request, ack(request.requestId));

    if (request.outcome === 'COMPLETED') {
      if (!this.#execution.ownsArtifact(request.reportRef))
        return this.#reject(run, request.requestId, request, 'INVALID_ARTIFACT_REF');
      await this.#converge(run, 'COMPLETED', undefined, request.reportRef);
    } else {
      await this.#converge(run, 'FAILED', request.failure);
    }
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  async #answerAuthorization(
    request: Extract<GatewayForward, { requestType: 'answerAuthorization' }>['request'],
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState !== 'RUNNING')
      return this.#reject(run, request.requestId, request, 'QUESTION_NOT_PENDING');

    const answer = this.#authorizationFor(run).answer(request.questionId, request.answer);
    if (answer === undefined)
      return this.#reject(run, request.requestId, request, 'QUESTION_NOT_PENDING');
    await this.#applyAuthorizationResolution(run, answer);
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  /** Used by attempt and result checks to confirm the repo.read Lease is still valid. */
  public isLeaseValid(run: RunState): boolean {
    return this.#authorizationFor(run).isLeaseValid();
  }

  /** Called by Core's authorization timer in stage 1.5. */
  public async expireAuthorization(run: RunState): Promise<AuthorizationResolution | undefined> {
    if (run.runState !== 'RUNNING') return undefined;
    const answer = this.#authorizationFor(run).expire();
    if (answer === undefined) return undefined;
    await this.#applyAuthorizationResolution(run, answer);
    return answer;
  }

  /** Called when the run starts converging in stage 1.5. */
  public async cancelAuthorization(run: RunState): Promise<AuthorizationResolution | undefined> {
    const answer = this.#authorizationFor(run).cancel();
    if (answer === undefined) return undefined;
    await this.#applyAuthorizationResolution(run, answer);
    return answer;
  }

  /** Called by Core in convergence step ③, after in-flight results were settled. */
  public invalidateLease(run: RunState): void {
    this.#authorizationFor(run).invalidateLease();
  }

  async #cancelRun(
    request: Extract<GatewayForward, { requestType: 'cancelRun' }>['request'],
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState === 'RUNNING') await this.#converge(run, 'CANCELLED');
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  async #readArtifact(
    request: Extract<GatewayForward, { requestType: 'readArtifact' }>['request'],
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (!this.#execution.ownsArtifact(request.ref))
      return this.#reject(run, request.requestId, request, 'INVALID_ARTIFACT_REF');
    const content = await this.#execution.readArtifact(request.ref);
    if (!content.ok) return this.#reject(run, request.requestId, request, 'INVALID_ARTIFACT_REF');
    const response: ArtifactContent = {
      requestId: request.requestId,
      outcome: 'ACCEPTED',
      ref: request.ref,
      text: content.text,
    };
    return this.#remember(run, request.requestId, request, response);
  }

  /** The run actor passes this object to Execution in stage 4. */
  public coreSyscalls(run: RunState): CoreSyscalls {
    return this.#attemptsFor(run);
  }

  #attemptsFor(run: RunState): CoreAttempts {
    if (this.#attempts === undefined || this.#attemptsRunId !== run.workflowRunId) {
      this.#attempts = new CoreAttempts({
        run,
        execution: this.#execution,
        monitor: this.#monitor,
        scheduler: this.#scheduler,
        audit: this.#audit,
        ...(this.#events === undefined ? {} : { events: this.#events }),
        provider: this.#config.provider,
        technicalRetryLimit: this.#config.technicalRetryLimit,
        now: this.#now,
        leaseIsValid: () => this.#authorizationFor(run).isLeaseValid(),
        onViolation: (reasonCode, unitRequestId) => {
          void this.#converge(run, 'VIOLATION', {
            code: reasonCode,
            category: 'INTEGRITY',
            source: 'KERNEL',
            ...(unitRequestId === undefined ? {} : { unitRequestId }),
          });
        },
        onStopUnconfirmed: (unitRequestId) => {
          void this.#converge(run, 'FAILED', {
            code: 'EXECUTION_STOP_UNCONFIRMED',
            category: 'INTERNAL',
            source: 'KERNEL',
            ...(unitRequestId === undefined ? {} : { unitRequestId }),
          });
        },
        onKernelInternal: () => {
          void this.#converge(run, 'FAILED', {
            code: 'KERNEL_INTERNAL',
            category: 'INTERNAL',
            source: 'KERNEL',
          });
        },
        onResultSettled: (executionId) => this.#onResultSettled(run, executionId),
      });
      this.#attemptsRunId = run.workflowRunId;
    }
    return this.#attempts;
  }

  async #startAttempt(
    run: RunState,
    agentRun: AgentRunRecord,
    unit: UnitDefinition,
    input: UnitInput,
    requestId: string,
    scope: ExecutionScope,
  ): Promise<void> {
    const spec: AttemptSpec = {
      requestId,
      agentRunId: agentRun.agentRunId,
      unit,
      input,
      scope,
      pinned: agentRun.pinned,
      runEpoch: run.runEpoch,
    };
    await this.#attemptsFor(run).startAttempt(spec);
  }

  async #emitDenied(
    run: RunState,
    requestId: string,
    agentRunId: string,
    unit: UnitDefinition,
  ): Promise<void> {
    const report: UnitReport = {
      type: 'UnitReport',
      requestId,
      agentRunId,
      unitRef: {
        kind: 'UNIT',
        id: unit.id,
        version: unit.version,
        digest: unit.digest,
      },
      executionKind: unit.executionKind as UnitReport['executionKind'],
      status: 'REJECTED',
      reasonCode: 'USER_DECLINED',
      budgetState: this.#monitor.budgetState(),
    } as UnitReport;
    run.units.rejected += 1;
    this.#emit(report);
    await this.#audit.append({
      at: this.#now().toISOString(),
      workflowRunId: run.workflowRunId,
      type: 'UNIT_REPORTED',
      requestId,
      agentRunId,
      reasonCode: 'USER_DECLINED',
    });
  }

  #authorizationFor(run: RunState): AuthorizationManager {
    if (this.#authorization === undefined || this.#authorizationRunId !== run.workflowRunId) {
      this.#authorization = new AuthorizationManager({
        repositoryRoot: run.repositoryRoot,
        provider: this.#config.provider,
        repositoryExclusions: this.#config.repositoryExclusions,
        authorizationTimeoutMs: this.#config.authorizationTimeoutMs,
        now: this.#now,
      });
      this.#authorizationRunId = run.workflowRunId;
    }
    return this.#authorization;
  }

  async #applyAuthorizationResolution(
    run: RunState,
    answer: AuthorizationResolution,
  ): Promise<void> {
    const authorization = this.#authorizationFor(run);
    for (const requestId of answer.released) {
      const waiting = run.awaitingAuthorization.get(requestId);
      if (waiting === undefined) continue;
      if (answer.resolution === 'GRANTED') {
        const agentRun = run.agentRuns.get(waiting.agentRunId);
        if (agentRun === undefined) {
          run.unitDecisions.set(requestId, {
            kind: 'DECLINED',
            reasonCode: 'USER_DECLINED',
          });
          await this.#emitDenied(run, requestId, waiting.agentRunId, waiting.unit);
        } else {
          const scope = deriveExecutionScope(waiting.unit, agentRun, authorization.lease);
          run.unitDecisions.set(requestId, { kind: 'ALLOWED', scope });
          await this.#startAttempt(run, agentRun, waiting.unit, waiting.input, requestId, scope);
        }
      } else if (answer.resolution === 'CANCELLED') {
        run.unitDecisions.set(requestId, { kind: 'CANCELLED' });
      } else {
        run.unitDecisions.set(requestId, {
          kind: 'DECLINED',
          reasonCode: 'USER_DECLINED',
        });
        await this.#emitDenied(run, requestId, waiting.agentRunId, waiting.unit);
      }
      run.awaitingAuthorization.delete(requestId);
    }
    this.#emit(answer.resolved);
    await this.#audit.append({
      at: this.#now().toISOString(),
      workflowRunId: run.workflowRunId,
      type: 'AUTHORIZATION_RESOLVED',
      questionId: answer.resolved.questionId,
      resolution: answer.resolution,
    });
  }

  async #tryAudit(entry: Omit<CoreAuditEntry, 'at'>): Promise<void> {
    try {
      await this.#audit.append({ at: this.#now().toISOString(), ...entry });
    } catch {
      // Closing and convergence must not wait indefinitely on audit storage
      // (Interaction 6 step ③); stage 1.6 decides how to escalate it.
    }
  }

  #emit(event: CoreEvent): void {
    this.#events?.emit(event);
  }

  /**
   * Core's non-halting exception entry (Core 9). It validates the input against the current
   * run state and routes to the same convergence, authorization or structured-result path.
   */
  public async handleCoreException(
    run: RunState,
    exception: CoreException,
  ): Promise<CoreExceptionOutcome> {
    let outcome: CoreExceptionOutcome = 'IGNORED';
    switch (exception.kind) {
      case 'KERNEL_FAULT':
        await this.#tryAudit({
          type: 'SYSTEM_FAULT_ABORT',
          workflowRunId: run.workflowRunId,
          faultId: exception.faultId,
        });
        if (run.runState === 'CLOSED') {
          outcome = 'ALREADY_CLOSED';
        } else if (run.runState === 'CONVERGING') {
          outcome = 'IGNORED';
        } else {
          await this.#converge(run, 'FAILED', {
            code: 'KERNEL_INTERNAL',
            category: 'INTERNAL',
            source: 'KERNEL',
            detail: exception.faultId,
          });
          outcome = 'HANDLED';
        }
        break;
      case 'RUN_TIMEOUT':
        if (run.runState === 'RUNNING') {
          await this.#converge(run, 'RUN_TIMEOUT');
          outcome = 'HANDLED';
        }
        break;
      case 'AUTHORIZATION_TIMEOUT':
        if (run.runState === 'RUNNING') {
          await this.expireAuthorization(run);
          outcome = 'HANDLED';
        }
        break;
      case 'VIOLATION':
        if (run.runState === 'RUNNING' || run.runState === 'CONVERGING') {
          await this.#converge(run, 'VIOLATION', {
            code: exception.reasonCode,
            category: 'INTEGRITY',
            source: 'KERNEL',
            ...(exception.unitRequestId === undefined
              ? {}
              : { unitRequestId: exception.unitRequestId }),
          });
          outcome = 'HANDLED';
        }
        break;
      case 'STOP_UNCONFIRMED':
        if (run.runState === 'RUNNING') {
          await this.#converge(run, 'FAILED', {
            code: 'EXECUTION_STOP_UNCONFIRMED',
            category: 'INTERNAL',
            source: 'KERNEL',
            ...(exception.unitRequestId === undefined
              ? {}
              : { unitRequestId: exception.unitRequestId }),
          });
          outcome = 'HANDLED';
        }
        break;
      case 'EXECUTION_FAILED':
      case 'SETTLEMENT_ANOMALY':
        // These keep their existing structured result/audit path; they never stop the run.
        break;
    }
    await this.settleConvergence(run);
    return outcome;
  }

  async #converge(
    run: RunState,
    closeReason: CloseReason,
    failure?: RunState['failure'],
    reportRef?: ArtifactRef,
  ): Promise<void> {
    const start = this.#beginConvergence(run, closeReason, failure, reportRef);
    this.#convergenceStarts.set(run.workflowRunId, start);
    try {
      await start;
    } catch (error) {
      this.#failConvergence(run, error);
    } finally {
      if (this.#convergenceStarts.get(run.workflowRunId) === start)
        this.#convergenceStarts.delete(run.workflowRunId);
    }
  }

  #failConvergence(run: RunState, error: unknown): void {
    this.#convergences.get(run.workflowRunId)?.reject(error);
    this.#reportFault(run, error);
  }

  #reportFault(run: RunState, error: unknown): void {
    if (this.#reportSystemFault !== undefined) {
      this.#reportSystemFault({
        source: 'kernel-core',
        phase: 'RUN',
        error,
        workflowRunId: run.workflowRunId,
      });
      return;
    }
    process.stderr.write(
      `kernel-core convergence failure: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
  }

  /** Stage 1.5 timer hook: the run exceeded KernelConfig.runTimeoutMs. */
  public async runTimedOut(run: RunState): Promise<void> {
    if (run.runState !== 'RUNNING') return;
    await this.#converge(run, 'RUN_TIMEOUT');
    await this.settleConvergence(run);
  }

  /** Stage 1.5 timer hook: the authorization question reached expiresAt. */
  public async authorizationTimedOut(run: RunState): Promise<void> {
    await this.expireAuthorization(run);
  }

  /** Stage 1.5 timer hook: the convergence grace period expired. */
  public async convergenceDeadline(run: RunState): Promise<void> {
    if (run.runState !== 'CONVERGING') return;
    const state = this.#convergences.get(run.workflowRunId);
    if (state === undefined) return;
    const executionIds = [...state.pending];
    await this.#tryAudit({ type: 'CONVERGENCE_DEADLINE', workflowRunId: run.workflowRunId });
    if (executionIds.length > 0) this.#execution.synthesizeStopUnconfirmed(executionIds);
    state.pending.clear();
    this.#requestSettlement(run);
    await this.settleConvergence(run);
  }

  /** Starts a shutdown convergence without waiting for it to finish. */
  public async beginShutdown(run: RunState): Promise<void> {
    if (run.runState === 'RUNNING') await this.#converge(run, 'CANCELLED');
  }

  /** Starts a fault convergence without waiting for it to finish. */
  public async beginAbort(run: RunState, faultId: string): Promise<void> {
    if (run.runState === 'RUNNING')
      await this.#converge(run, 'FAILED', {
        code: 'KERNEL_INTERNAL',
        category: 'INTERNAL',
        source: 'KERNEL',
        detail: faultId,
      });
    await this.#tryAudit({
      type: 'SYSTEM_FAULT_ABORT',
      workflowRunId: run.workflowRunId,
      faultId,
    });
  }

  /** Used by RunRegistry/System shutdown after the user requests shutdown. */
  public async shutdownRun(run: RunState): Promise<void> {
    await this.beginShutdown(run);
    await this.settleConvergence(run);
    await this.whenConverged(run);
  }

  /** Used by the composition root's abortAllRuns. */
  public async abortRun(run: RunState, faultId: string): Promise<void> {
    await this.beginAbort(run, faultId);
    await this.settleConvergence(run);
    await this.whenConverged(run);
  }

  public whenConverged(run: RunState): Promise<void> {
    if (run.runState === 'CLOSED') return Promise.resolve();
    return this.#convergences.get(run.workflowRunId)?.promise ?? Promise.resolve();
  }

  /**
   * The only place a started convergence is completed. The run actor calls this after every
   * dispatch; public handlers also call it at the end of their own processing so direct callers
   * (and tests built before the actor) keep the same completion boundary.
   */
  public async settleConvergence(run: RunState): Promise<void> {
    const starting = this.#convergenceStarts.get(run.workflowRunId);
    if (starting !== undefined) {
      try {
        await starting;
      } catch {
        return;
      }
    }
    if (!this.#settleRequested.delete(run.workflowRunId)) return;
    if (this.#completing.has(run.workflowRunId)) {
      await this.whenConverged(run);
      return;
    }
    try {
      await this.#completeConvergence(run);
    } catch (error) {
      this.#failConvergence(run, error);
    }
  }

  #requestSettlement(run: RunState): void {
    this.#settleRequested.add(run.workflowRunId);
  }

  async #beginConvergence(
    run: RunState,
    closeReason: CloseReason,
    failure?: RunState['failure'],
    reportRef?: ArtifactRef,
  ): Promise<void> {
    if (run.runState === 'CLOSED') return;
    if (run.runState === 'CONVERGING') {
      if (closeReason === 'VIOLATION' && run.closeReason !== 'VIOLATION') {
        run.closeReason = 'VIOLATION';
        if (failure !== undefined) run.failure = failure;
        delete run.reportRef;
        this.#admission?.({
          workflowRunId: run.workflowRunId,
          runState: 'CONVERGING',
          closeReason: 'VIOLATION',
        });
        await this.#tryAudit({
          type: 'CLOSE_REASON_UPGRADED',
          workflowRunId: run.workflowRunId,
        });
      }
      return;
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const state: ConvergenceState = { pending: new Set<string>(), promise, resolve, reject };
    this.#convergences.set(run.workflowRunId, state);

    run.runState = 'CONVERGING';
    run.runEpoch += 1;
    run.convergingAt = this.#now().toISOString();
    run.closeReason = closeReason;
    if (failure !== undefined) run.failure = failure;
    if (reportRef !== undefined) run.reportRef = reportRef;
    this.#admission?.({
      workflowRunId: run.workflowRunId,
      runState: 'CONVERGING',
      closeReason,
    });

    await this.cancelAuthorization(run);
    await this.#tryAudit({ type: 'CONVERGENCE_STARTED', workflowRunId: run.workflowRunId });
    this.#scheduler.stopGranting();
    const aborted = this.#execution.abortQueued();
    for (const entry of aborted.inFlight)
      if (!this.#settledExecutions.has(entry.executionId)) state.pending.add(entry.executionId);
    if (state.pending.size > 0)
      void this.#supervisor
        ?.cancelRun({ workflowRunId: run.workflowRunId, runEpoch: run.runEpoch })
        .catch(() => undefined);
    if (state.pending.size === 0) this.#requestSettlement(run);
  }

  #onResultSettled(run: RunState, executionId: string): void {
    this.#settledExecutions.add(executionId);
    const state = this.#convergences.get(run.workflowRunId);
    if (state === undefined) return;
    state.pending.delete(executionId);
    if (state.pending.size === 0) this.#requestSettlement(run);
  }

  async #completeConvergence(run: RunState): Promise<void> {
    if (run.runState === 'CLOSED' || this.#completing.has(run.workflowRunId)) return;
    this.#completing.add(run.workflowRunId);
    try {
      const budget = this.#monitor.finalize();
      const now = this.#now();
      const closedAt = now.toISOString();
      for (const agentRun of run.agentRuns.values()) {
        if (agentRun.state === 'ACTIVE') {
          agentRun.state = 'ENDED';
          agentRun.endedAt = closedAt;
        }
      }
      this.#authorizationFor(run).invalidateLease();
      this.#scheduler.releaseAll();
      const unknownEffects = this.#execution.collectUnknownEffects();
      const units = { ...run.units };
      units.notDelivered = Math.max(0, units.submitted - units.ok - units.rejected - units.failed);
      run.units.notDelivered = units.notDelivered;
      if (run.closeReason === undefined) throw new Error('A converging run has no closeReason');

      const base = {
        workflowRunId: run.workflowRunId,
        startedAt: run.startedAt,
        closedAt,
        durationMs: Math.max(0, now.getTime() - new Date(run.startedAt).getTime()),
        agentRuns: [...run.agentRuns.values()].map((agentRun) => ({
          agentRunId: agentRun.agentRunId,
          agentRef: agentRun.agentRef,
          registeredAt: agentRun.registeredAt,
          endedAt: agentRun.endedAt ?? closedAt,
          rounds: agentRun.rounds,
        })),
        units,
        model: {
          requests: this.#execution.modelRequestCount(),
          finalCallUsed: this.#attemptsFor(run).hasFinalCall(),
        },
        tokens: budget,
        unknownEffects,
      };
      const closeReason = run.closeReason;
      let summary: RunSummary;
      if (closeReason === 'COMPLETED') {
        if (run.reportRef === undefined) throw new Error('COMPLETED run has no reportRef');
        summary = { ...base, closeReason, reportRef: run.reportRef };
      } else if (closeReason === 'FAILED' || closeReason === 'VIOLATION') {
        if (run.failure === undefined) throw new Error(`${closeReason} run has no failure`);
        summary = { ...base, closeReason, failure: run.failure };
      } else {
        summary = { ...base, closeReason };
      }
      const final = await finalizeRunEvents(summary, (value) =>
        this.#execution.publishRunSummary(value),
      );
      await this.#tryAudit({
        type: 'RUN_CLOSED',
        workflowRunId: run.workflowRunId,
        ...('runSummaryRef' in final.workflow
          ? { runSummaryRef: final.workflow.runSummaryRef }
          : {}),
      });
      this.#emit(final.workflow);
      this.#emit(final.interaction);
      run.runState = 'CLOSED';
      run.closedAt = closedAt;
      this.#admission?.({
        workflowRunId: run.workflowRunId,
        runState: 'CLOSED',
        closeReason: run.closeReason,
      });
      this.#onRunClosed?.(run);
      this.#convergences.get(run.workflowRunId)?.resolve();
    } finally {
      this.#completing.delete(run.workflowRunId);
    }
  }

  async #lookup(
    run: RunState,
    requestId: string,
    payload: unknown,
  ): Promise<RunResponse | undefined> {
    const lookup = run.requests.lookup<RunResponse>(requestId, payload);
    if (lookup.kind === 'replay') return lookup.response;
    if (lookup.kind === 'conflict') {
      const response = rejected(requestId, 'REQUEST_CONFLICT');
      await this.#audit.append({
        at: this.#now().toISOString(),
        workflowRunId: run.workflowRunId,
        type: 'REQUEST_REJECTED',
        requestId,
        reasonCode: 'REQUEST_CONFLICT',
      });
      return response;
    }
    return undefined;
  }

  #remember<T extends RunResponse>(
    run: RunState,
    requestId: string,
    payload: unknown,
    response: T,
  ): T {
    run.requests.remember(requestId, payload, response);
    return response;
  }

  async #runBlocked(run: RunState, requestId: string, payload: unknown): Promise<RunResponse> {
    if (run.closeReason === undefined) throw new Error('A non-RUNNING run must carry closeReason');
    return this.#reject(run, requestId, payload, 'RUN_BLOCKED', run.closeReason);
  }

  async #reject(
    run: RunState,
    requestId: string,
    payload: unknown,
    reasonCode: CoreRejectedCode | 'RUN_BLOCKED',
    closeReason?: RunState['closeReason'],
  ): Promise<RunResponse> {
    const response = rejected(requestId, reasonCode, closeReason);
    await this.#audit.append({
      at: this.#now().toISOString(),
      workflowRunId: run.workflowRunId,
      type: 'REQUEST_REJECTED',
      requestId,
      reasonCode,
    });
    return this.#remember(run, requestId, payload, response);
  }
}

function ack(requestId: string): SyscallAck {
  return { requestId, outcome: 'ACCEPTED' };
}

function rejected(
  requestId: string,
  reasonCode: CoreRejectedCode | 'RUN_BLOCKED',
  closeReason?: RunState['closeReason'],
): SyscallRejected {
  if (reasonCode === 'RUN_BLOCKED') {
    if (closeReason === undefined) throw new Error('RUN_BLOCKED requires closeReason');
    return { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode, closeReason };
  }
  return { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode };
}
