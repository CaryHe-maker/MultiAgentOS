import type {
  ArtifactRef,
  BudgetView,
  ExecutionKind,
  ExecutionOutcome,
  ExecutionScope,
  ModelToolSpec,
  ReasonCode,
  RequestState,
  SubmitUnitRequest,
  TokenCalibration,
  TokenUsage,
  UnitDefinition,
  UnitInput,
  UnitOutput,
  UnitReport,
  ViolationCode,
} from '@multiagentos/contracts';
import type { ProtectedCapability } from '@multiagentos/contracts';
import type { SchedulerDuties, Settlement, SettlementResult } from '../interfaces/index.js';
import type { AgentBudget } from '../monitor/index.js';

/** What the catalog gives Core and Execution for one registered AgentRun. */
export interface PinnedAgent {
  /** The Agent definition's whitelist, the source of the ceiling (Kernel/Core 5a.1). */
  readonly capabilities: readonly ProtectedCapability[];
  readonly units: readonly UnitDefinition[];
  readonly maxToolUnits: number;
  readonly maxWallClockMs?: number;
  /** The model scope for the effort this AgentRun registered with. */
  readonly modelScope: ExecutionScope;
  readonly budget: AgentBudget;
  readonly id: string;
  readonly contextWindowTokens: number;
  readonly cacheHitWeight: number;
  /** The rendered Prompt of the Agent. */
  readonly instructions: string;
  /** The tools of a call: the Units' and the end tools, or only those allowed in a final call. */
  readonly toolSpecs: (final: boolean) => ModelToolSpec[];
}

/** Core starts an attempt through Execution once admission and authorization allowed it. */
export interface AttemptSpec {
  readonly requestId: string;
  readonly agentRunId: string;
  readonly unitRunId: string;
  readonly unit: UnitDefinition;
  readonly input: UnitInput;
  readonly scope: ExecutionScope;
  readonly runEpoch: number;
  readonly agent: PinnedAgent;
  /** What the activity area shows for a tool Unit; nothing decides on it. */
  readonly display: SubmitUnitRequest['display'];
}

/** What Execution hands back for one attempt (Kernel/Interaction 4). */
export interface ResultCheck {
  readonly unitAttemptId: string;
  /** Absent when the attempt ended before it was dispatched, or for a built-in Unit. */
  readonly executionId?: string;
  readonly outcome: ExecutionOutcome | 'NOT_DISPATCHED' | 'INTERRUPTED';
  readonly reasonCode?: ReasonCode;
  /** Only for INTERRUPTED: the pause or the abort that cancelled the execution (M2Design 4.4). */
  readonly interruptedBy?: 'PAUSED' | 'ABORTED';
  readonly output?: UnitOutput;
  readonly outputRef?: ArtifactRef;
  readonly fullRef?: ArtifactRef;
  readonly reasoningRef?: ArtifactRef;
  readonly changedFiles?: readonly string[];
  readonly usage?: TokenUsage;
  readonly requestState?: RequestState;
}

export interface AttemptLedger {
  reserve(
    request: {
      readonly estimatedTokens: number;
      readonly final: boolean;
      readonly cacheHitWeight: number;
    },
    agentRunId: string,
  ):
    | { readonly ok: true; readonly reservationId: string }
    | { readonly ok: false; readonly reasonCode: 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED' };
  settle(reservationId: string, settlement: Settlement): SettlementResult;
  budgetView(agentRunId: string): BudgetView;
}

export type ReservationDecision =
  | { readonly granted: true; readonly reservationId: string; readonly grantId: string }
  | {
      readonly granted: false;
      /** For the three budget reasons the UnitReport is already delivered. */
      readonly reason:
        | 'BUDGET_WRAP_UP'
        | 'BUDGET_EXHAUSTED'
        | 'FINAL_CALL_USED'
        | 'RUN_CONVERGING'
        /** Not a failure: every call slot is in use. The attempt stays open and asks again. */
        | 'WAIT_CAPACITY';
    };

export type RetryDecision =
  | { readonly allowed: true; readonly reservationId?: string; readonly grantId?: string }
  | {
      readonly allowed: false;
      readonly reason:
        | 'RUN_CONVERGING'
        | 'RETRY_LIMIT'
        | 'REQUEST_MAY_BE_SENT'
        | 'BUDGET_WRAP_UP'
        | 'BUDGET_EXHAUSTED';
    };

/** Why the run must converge; the actor decides how (Kernel/Interaction 6.3). */
export type AttemptFault =
  | { readonly kind: 'VIOLATION'; readonly reasonCode: ViolationCode; readonly requestId: string }
  | { readonly kind: 'STOP_UNCONFIRMED'; readonly requestId: string }
  | { readonly kind: 'KERNEL_INTERNAL' };

export type AttemptAudit =
  | {
      readonly type: 'UNIT_REPORTED';
      readonly requestId: string;
      readonly reasonCode?: ReasonCode;
    }
  | {
      readonly type: 'UNIT_NOT_DELIVERED';
      readonly requestId: string;
      readonly reasonCode?: ReasonCode;
    }
  | { readonly type: 'STALE_FACT'; readonly unitAttemptId: string }
  /** A command of the read-only list ran without a question of its own (Core 5b). */
  | {
      readonly type: 'COMMAND_READ_ONLY';
      readonly requestId: string;
      readonly agentRunId: string;
      readonly command: string;
      readonly workdir: string;
    }
  /** A read outside the workspace was let through: what was asked, and the folder that allowed it. */
  | {
      readonly type: 'EXTERNAL_READ';
      readonly requestId: string;
      readonly agentRunId: string;
      readonly executionKind: string;
      readonly path: string;
      readonly root: string;
    }
  | {
      readonly type: 'SETTLEMENT_ANOMALY';
      readonly unitAttemptId: string;
      readonly anomaly: 'ACTUAL_EXCEEDED_ESTIMATE' | 'CONFLICTING_SETTLEMENT';
    };

export interface RunAttemptsDeps {
  readonly provider: string;
  readonly technicalRetryLimit: number;
  readonly ledger: AttemptLedger;
  readonly scheduler: SchedulerDuties;
  readonly createAttempt: (spec: AttemptSpec) => Promise<string>;
  /** The run accepts work and its epoch is still `runEpoch`. */
  readonly isDeliverable: (runEpoch: number) => boolean;
  readonly isConverging: () => boolean;
  readonly leaseIsValid: () => boolean;
  /** `spec` is absent for a Unit refused before it had an attempt. */
  readonly deliver: (report: UnitReport, spec?: AttemptSpec) => void;
  readonly attemptStarted: (spec: AttemptSpec, unitAttemptId: string) => void;
  /** The attempt was dispatched for the first time; a retry does not count. */
  readonly attemptRunning: (spec: AttemptSpec, unitAttemptId: string, final: boolean) => void;
  /** The attempt is settled, delivered or not: the run may now finish converging. */
  readonly attemptEnded: (spec: AttemptSpec, unitAttemptId: string) => void;
  readonly onFault: (fault: AttemptFault) => void;
  readonly audit: (entry: AttemptAudit) => void;
}

interface ReservationRequest {
  readonly estimatedTokens: number;
  readonly final: boolean;
  readonly cacheHitWeight: number;
  readonly inputEstimate: number;
}

interface Reservation extends ReservationRequest {
  readonly reservationId: string;
  readonly grantId: string;
}

interface Attempt {
  readonly spec: AttemptSpec;
  readonly unitAttemptId: string;
  executionId?: string;
  retryFrom?: string;
  reservation?: Reservation;
  retries: number;
  checked: boolean;
}

/** Built-in Units finish in Execution without an execution instance. */
const BUILT_IN: ReadonlySet<ExecutionKind> = new Set(['REPORT_PUBLISH', 'MESSAGE_PUBLISH']);
const isViolation = (code: ReasonCode | undefined): code is ViolationCode =>
  code === 'SCOPE_MISSING' || code === 'PATH_ESCAPE' || code === 'GUARD_FAILURE';

const unitRefOf = (unit: UnitDefinition) =>
  ({ kind: 'UNIT', id: unit.id, version: unit.version, digest: unit.digest }) as const;

/**
 * Core's attempt identity, reservations, result checks and retries for one run: UnitReport
 * carries `unitRunId` and `BudgetView`, the final call is per AgentRun (M2Design 7.3), and budget
 * never converges the run.
 */
export class RunAttempts {
  readonly #calibrations = new Map<string, TokenCalibration>();
  readonly #deps: RunAttemptsDeps;
  readonly #byRequest = new Map<string, AttemptSpec>();
  readonly #attempts = new Map<string, Attempt>();
  readonly #executions = new Set<string>();
  readonly #finalCalls = new Map<string, string>();

  public constructor(deps: RunAttemptsDeps) {
    this.#deps = deps;
  }

  /** Execution queues the attempt, calls `registerAttempt` first and starts it when idle. */
  async start(spec: AttemptSpec): Promise<string> {
    this.#byRequest.set(spec.requestId, spec);
    return this.#deps.createAttempt(spec);
  }

  /** Must precede any reservation or result check, including for a built-in Unit. */
  registerAttempt(unitAttemptId: string, requestId: string): void {
    const spec = this.#byRequest.get(requestId);
    if (spec === undefined) throw new Error('No attempt was started for this request');
    if (this.#attempts.has(unitAttemptId)) throw new Error('Duplicate unitAttemptId');
    this.#attempts.set(unitAttemptId, { spec, unitAttemptId, retries: 0, checked: false });
    this.#deps.attemptStarted(spec, unitAttemptId);
  }

  /** An attempt that ends without a result, such as one still queued when the run converges. */
  abandon(unitAttemptId: string): void {
    const attempt = this.#attempts.get(unitAttemptId);
    if (attempt === undefined || attempt.checked) return;
    if (attempt.reservation !== undefined)
      this.#deps.scheduler.release(attempt.reservation.grantId);
    attempt.checked = true;
    this.#ended(attempt);
  }

  /**
   * An attempt that never reached the Supervisor ends because the run is paused or aborted: it
   * answers INTERRUPTED like a cancelled execution does, so Workflow sees every Unit it submitted
   * come back (M2Design 4.4). A reservation it holds goes back unused.
   */
  interruptUnsent(unitAttemptId: string, interruptedBy: 'PAUSED' | 'ABORTED'): void {
    const attempt = this.#attempts.get(unitAttemptId);
    if (attempt === undefined || attempt.checked || attempt.executionId !== undefined) return;
    if (attempt.reservation !== undefined) {
      this.#settleReservation(attempt, { type: 'NOT_SENT' });
      this.#deps.scheduler.release(attempt.reservation.grantId);
    }
    attempt.checked = true;
    this.#deliverInterrupted(attempt, interruptedBy);
    this.#ended(attempt);
  }

  /** Must precede the Supervisor.execute of this executionId. */
  registerExecution(unitAttemptId: string, executionId: string): void {
    const attempt = this.#open(unitAttemptId);
    if (this.#executions.has(executionId)) throw new Error('Duplicate executionId');
    if (attempt.executionId !== undefined && attempt.retryFrom !== attempt.executionId)
      throw new Error('Retry was not authorized');
    this.#executions.add(executionId);
    const first = attempt.executionId === undefined;
    attempt.executionId = executionId;
    delete attempt.retryFrom;
    if (first)
      this.#deps.attemptRunning(attempt.spec, unitAttemptId, attempt.reservation?.final ?? false);
  }

  /** A delivered final call for this AgentRun, so the RunSummary can say so. */
  usedFinalCall(agentRunId: string): boolean {
    return this.#finalCalls.has(agentRunId);
  }

  /**
   * What the provider counted for this Agent's last request, next to the estimate of it. By Agent:
   * main is a new AgentRun for each input, with the same history. A SubAgent has a history of its own.
   */
  calibrationOf(agentId: string): TokenCalibration | undefined {
    return this.#calibrations.get(agentId);
  }

  requestReservation(
    request: ReservationRequest & { readonly unitAttemptId: string },
  ): ReservationDecision {
    const attempt = this.#open(request.unitAttemptId);
    if (this.#deps.isConverging()) {
      this.abandon(request.unitAttemptId);
      return { granted: false, reason: 'RUN_CONVERGING' };
    }
    const { agentRunId } = attempt.spec;
    const usedBy = this.#finalCalls.get(agentRunId);
    if (request.final && usedBy !== undefined && usedBy !== request.unitAttemptId) {
      this.#reject(attempt, 'FINAL_CALL_USED');
      return { granted: false, reason: 'FINAL_CALL_USED' };
    }
    const reserved = this.#reserve(attempt, request);
    if (!reserved.granted) return reserved;
    if (request.final) this.#finalCalls.set(agentRunId, request.unitAttemptId);
    return reserved;
  }

  /** `keptGrant`: a retry holds on to its call slot, so it cannot lose it to another AgentRun. */
  #reserve(attempt: Attempt, request: ReservationRequest, keptGrant?: string): ReservationDecision {
    const { estimatedTokens, final, cacheHitWeight, inputEstimate } = request;
    const grant =
      keptGrant === undefined
        ? this.#deps.scheduler.acquire(this.#deps.provider)
        : ({ ok: true, grantId: keptGrant } as const);
    if (!grant.ok) {
      // The slots are full: wait, and ask again when one is given back (M2Design 7.2).
      if (grant.reason === 'CAPACITY') return { granted: false, reason: 'WAIT_CAPACITY' };
      this.abandon(attempt.unitAttemptId);
      this.#deps.onFault({ kind: 'KERNEL_INTERNAL' });
      return { granted: false, reason: 'RUN_CONVERGING' };
    }
    const reserved = this.#deps.ledger.reserve(
      { estimatedTokens, final, cacheHitWeight },
      attempt.spec.agentRunId,
    );
    if (!reserved.ok) {
      this.#deps.scheduler.release(grant.grantId);
      this.#reject(attempt, reserved.reasonCode);
      return { granted: false, reason: reserved.reasonCode };
    }
    attempt.reservation = {
      reservationId: reserved.reservationId,
      grantId: grant.grantId,
      estimatedTokens,
      final,
      cacheHitWeight,
      inputEstimate,
    };
    return { granted: true, reservationId: reserved.reservationId, grantId: grant.grantId };
  }

  /** Synchronous on purpose: nothing runs between the epoch check and the Outbox. */
  submitResultCheck(check: ResultCheck): void {
    const attempt = this.#attempts.get(check.unitAttemptId);
    if (attempt === undefined || !this.#identityHolds(attempt, check)) {
      this.#deps.audit({ type: 'STALE_FACT', unitAttemptId: check.unitAttemptId });
      return;
    }
    this.#settleReservation(attempt, settlementOf(check));
    if (check.outcome !== 'STOP_UNCONFIRMED' && attempt.reservation !== undefined)
      this.#deps.scheduler.release(attempt.reservation.grantId);
    attempt.checked = true;
    const { requestId } = attempt.spec;

    if (check.outcome === 'VIOLATION') {
      const reasonCode = check.reasonCode;
      if (!isViolation(reasonCode))
        throw new Error('Violation result has a non-violation reasonCode');
      this.#ended(attempt);
      this.#deps.onFault({ kind: 'VIOLATION', reasonCode, requestId });
      return;
    }
    if (check.outcome === 'STOP_UNCONFIRMED') {
      this.#ended(attempt);
      this.#deps.onFault({ kind: 'STOP_UNCONFIRMED', requestId });
      return;
    }
    if (check.outcome === 'INTERRUPTED') {
      if (check.interruptedBy === undefined) throw new Error('An interrupted result names why');
      if (this.#deps.isDeliverable(attempt.spec.runEpoch))
        this.#deliverInterrupted(attempt, check.interruptedBy);
      this.#ended(attempt);
      return;
    }
    if (
      (check.outcome === 'TERMINATED' && check.reasonCode === 'EXECUTION_CANCELLED') ||
      !this.#deps.isDeliverable(attempt.spec.runEpoch)
    ) {
      this.#deps.audit({
        type: 'UNIT_NOT_DELIVERED',
        requestId,
        ...(check.reasonCode === undefined ? {} : { reasonCode: check.reasonCode }),
      });
      this.#ended(attempt);
      return;
    }
    this.#deliver(this.#reportOf(attempt, check), attempt.spec);
    this.#ended(attempt);
  }

  retryExecution(request: {
    readonly unitAttemptId: string;
    readonly previousExecutionId: string;
    readonly requestState?: RequestState;
    readonly usage?: TokenUsage;
  }): RetryDecision {
    if (this.#deps.isConverging()) return { allowed: false, reason: 'RUN_CONVERGING' };
    const attempt = this.#open(request.unitAttemptId);
    if (attempt.retries >= this.#deps.technicalRetryLimit)
      return { allowed: false, reason: 'RETRY_LIMIT' };
    if (attempt.executionId !== request.previousExecutionId || attempt.retryFrom !== undefined)
      throw new Error('Retry does not match the current execution');

    const previous = attempt.reservation;
    if (attempt.spec.unit.executionKind !== 'MODEL' || previous === undefined) {
      attempt.retryFrom = request.previousExecutionId;
      attempt.retries += 1;
      return { allowed: true };
    }
    // A sent request may be retried only when its consumption is known, so it is charged once.
    const settlement: Settlement | undefined =
      request.requestState === 'NOT_SENT'
        ? { type: 'NOT_SENT' }
        : request.requestState === 'SENT' && request.usage !== undefined
          ? { type: 'ACTUAL', usage: request.usage }
          : undefined;
    if (settlement === undefined) return { allowed: false, reason: 'REQUEST_MAY_BE_SENT' };
    attempt.retryFrom = request.previousExecutionId;
    this.#settleReservation(attempt, settlement);
    delete attempt.reservation;
    const reserved = this.#reserve(attempt, previous, previous.grantId);
    if (!reserved.granted) {
      if (reserved.reason === 'RUN_CONVERGING') return { allowed: false, reason: 'RUN_CONVERGING' };
      if (reserved.reason === 'FINAL_CALL_USED') throw new Error('A retry cannot use a final call');
      if (reserved.reason === 'WAIT_CAPACITY') throw new Error('A retry keeps its call slot');
      return { allowed: false, reason: reserved.reason };
    }
    attempt.retries += 1;
    return { allowed: true, reservationId: reserved.reservationId, grantId: reserved.grantId };
  }

  /** Delivers a refusal of a Unit that never got an attempt (authorization, quota). */
  rejectWithoutAttempt(
    spec: Pick<AttemptSpec, 'requestId' | 'agentRunId' | 'unitRunId' | 'unit'>,
    refusal:
      | {
          readonly reasonCode:
            | 'USER_DECLINED'
            | 'CAPABILITY_NOT_GRANTED'
            | 'WRITE_OUT_OF_SCOPE'
            | 'PROTECTED_PATH'
            | 'COMMAND_DENIED'
            | 'ADDRESS_FORBIDDEN'
            | 'DOMAIN_DENIED'
            | 'EXTERNAL_PATH_UNAVAILABLE'
            | 'SANDBOX_UNAVAILABLE'
            | 'WRITE_SCOPE_DELEGATED'
            | 'ADMISSION_CHECK_FAILED';
        }
      | {
          readonly reasonCode: 'QUOTA_EXHAUSTED';
          readonly quota: 'TOOL_UNITS' | 'WALL_CLOCK' | 'MEMORY';
        },
  ): void {
    this.#deliver({
      type: 'UnitReport',
      requestId: spec.requestId,
      agentRunId: spec.agentRunId,
      unitRunId: spec.unitRunId,
      unitRef: unitRefOf(spec.unit),
      executionKind: spec.unit.executionKind,
      budget: this.#deps.ledger.budgetView(spec.agentRunId),
      status: 'REJECTED',
      ...refusal,
    });
  }

  #open(unitAttemptId: string): Attempt {
    const attempt = this.#attempts.get(unitAttemptId);
    if (attempt === undefined || attempt.checked) throw new Error('Attempt is not open');
    return attempt;
  }

  #identityHolds(attempt: Attempt, check: ResultCheck): boolean {
    if (attempt.checked) return false;
    if (attempt.spec.unit.protectedCapabilities.includes('repo.read') && !this.#deps.leaseIsValid())
      return false;
    if (attempt.executionId !== check.executionId) return false;
    if (check.executionId === undefined)
      return check.outcome === 'NOT_DISPATCHED' || BUILT_IN.has(attempt.spec.unit.executionKind);
    return check.outcome !== 'NOT_DISPATCHED';
  }

  #settleReservation(attempt: Attempt, settlement: Settlement | undefined): void {
    if (attempt.reservation === undefined || settlement === undefined) return;
    if (settlement.type === 'ACTUAL' && settlement.usage.inputTokens > 0)
      this.#calibrations.set(attempt.spec.agent.id, {
        measuredInputTokens: settlement.usage.inputTokens,
        estimatedInputTokens: attempt.reservation.inputEstimate,
      });
    const result = this.#deps.ledger.settle(attempt.reservation.reservationId, settlement);
    for (const anomaly of result.anomalies)
      this.#deps.audit({
        type: 'SETTLEMENT_ANOMALY',
        unitAttemptId: attempt.unitAttemptId,
        anomaly: anomaly.type,
      });
  }

  #reject(attempt: Attempt, reasonCode: 'FINAL_CALL_USED' | 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED') {
    attempt.checked = true;
    this.#deliver(
      {
        ...this.#base(attempt),
        unitAttemptId: attempt.unitAttemptId,
        status: 'REJECTED',
        reasonCode,
      },
      attempt.spec,
    );
    this.#ended(attempt);
  }

  #base(attempt: Attempt) {
    const { spec } = attempt;
    return {
      type: 'UnitReport',
      requestId: spec.requestId,
      agentRunId: spec.agentRunId,
      unitRunId: spec.unitRunId,
      unitRef: unitRefOf(spec.unit),
      executionKind: spec.unit.executionKind,
      budget: this.#deps.ledger.budgetView(spec.agentRunId),
    } as const;
  }

  #reportOf(attempt: Attempt, check: ResultCheck): UnitReport {
    const base = { ...this.#base(attempt), unitAttemptId: attempt.unitAttemptId };
    if (check.outcome === 'COMPLETED') {
      if (check.output === undefined) throw new Error('COMPLETED result requires output');
      return {
        ...base,
        status: 'OK',
        output: check.output,
        ...(check.outputRef === undefined ? {} : { outputRef: check.outputRef }),
        ...(check.fullRef === undefined ? {} : { fullRef: check.fullRef }),
        ...(check.reasoningRef === undefined ? {} : { reasoningRef: check.reasoningRef }),
        ...(check.usage === undefined ? {} : { usage: check.usage }),
        ...(check.changedFiles === undefined ? {} : { changedFiles: [...check.changedFiles] }),
      };
    }
    const reasonCode = check.reasonCode;
    if (reasonCode === undefined) throw new Error('Result check requires a reasonCode');
    const status =
      check.outcome === 'REJECTED' || check.outcome === 'NOT_DISPATCHED' ? 'REJECTED' : 'FAILED';
    return { ...base, status, reasonCode } as UnitReport;
  }

  #deliverInterrupted(attempt: Attempt, interruptedBy: 'PAUSED' | 'ABORTED'): void {
    this.#deliver(
      {
        ...this.#base(attempt),
        unitAttemptId: attempt.unitAttemptId,
        status: 'INTERRUPTED',
        interruptedBy,
      },
      attempt.spec,
    );
  }

  #deliver(report: UnitReport, spec?: AttemptSpec): void {
    this.#deps.deliver(report, spec);
    this.#deps.audit({
      type: 'UNIT_REPORTED',
      requestId: report.requestId,
      ...('reasonCode' in report ? { reasonCode: report.reasonCode } : {}),
    });
  }

  #ended(attempt: Attempt): void {
    this.#deps.attemptEnded(attempt.spec, attempt.unitAttemptId);
  }
}

function settlementOf(check: ResultCheck): Settlement | undefined {
  switch (check.outcome) {
    case 'COMPLETED':
      return check.usage === undefined
        ? { type: 'UNKNOWN' }
        : { type: 'ACTUAL', usage: check.usage };
    case 'REJECTED':
      return { type: 'NOT_SENT' };
    case 'FAILED':
    case 'TERMINATED':
    case 'INTERRUPTED':
      if (check.requestState === 'NOT_SENT') return { type: 'NOT_SENT' };
      if (check.requestState === 'SENT' && check.usage !== undefined)
        return { type: 'ACTUAL', usage: check.usage };
      return { type: 'UNKNOWN' };
    case 'VIOLATION':
    case 'STOP_UNCONFIRMED':
      return { type: 'UNKNOWN' };
    case 'NOT_DISPATCHED':
      return undefined;
  }
}
