import type {
  ArtifactRef,
  BudgetView,
  ExecutionKindV1,
  ExecutionOutcome,
  ExecutionScope,
  ReasonCodeV1,
  RequestState,
  TokenUsage,
  UnitDefinitionV1,
  UnitInputV1,
  UnitOutputV1,
  UnitReportV1,
} from '@multiagentos/contracts';
import type { SchedulerDuties, Settlement, SettlementResult } from '../interfaces/index.js';

/** Core starts an attempt through Execution once admission and authorization allowed it. */
export interface AttemptSpec {
  readonly requestId: string;
  readonly agentRunId: string;
  readonly unitRunId: string;
  readonly turnId: string;
  readonly unit: UnitDefinitionV1;
  readonly input: UnitInputV1;
  readonly scope: ExecutionScope;
  readonly runEpoch: number;
}

/** What Execution hands back for one attempt (Kernel/Interaction 4). */
export interface ResultCheck {
  readonly unitAttemptId: string;
  /** Absent when the attempt ended before it was dispatched, or for a built-in Unit. */
  readonly executionId?: string;
  readonly outcome: ExecutionOutcome | 'NOT_DISPATCHED';
  readonly reasonCode?: ReasonCodeV1;
  readonly output?: UnitOutputV1;
  readonly outputRef?: ArtifactRef;
  readonly fullRef?: ArtifactRef;
  readonly reasoningRef?: ArtifactRef;
  readonly usage?: TokenUsage;
  readonly requestState?: RequestState;
}

export interface AttemptLedger {
  reserve(request: {
    readonly estimatedTokens: number;
    readonly final: boolean;
  }):
    | { readonly ok: true; readonly reservationId: string }
    | { readonly ok: false; readonly reasonCode: 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED' };
  settle(reservationId: string, settlement: Settlement): SettlementResult;
  budgetView(): BudgetView;
}

export type ReservationDecision =
  | { readonly granted: true; readonly reservationId: string; readonly grantId: string }
  | {
      readonly granted: false;
      /** For the three budget reasons the UnitReport is already delivered. */
      readonly reason: 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED' | 'FINAL_CALL_USED' | 'RUN_CONVERGING';
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
  | { readonly kind: 'VIOLATION'; readonly reasonCode: ReasonCodeV1; readonly requestId: string }
  | { readonly kind: 'STOP_UNCONFIRMED'; readonly requestId: string }
  | { readonly kind: 'KERNEL_INTERNAL' };

export type AttemptAudit =
  | {
      readonly type: 'UNIT_REPORTED';
      readonly requestId: string;
      readonly reasonCode?: ReasonCodeV1;
    }
  | {
      readonly type: 'UNIT_NOT_DELIVERED';
      readonly requestId: string;
      readonly reasonCode?: ReasonCodeV1;
    }
  | { readonly type: 'STALE_FACT'; readonly unitAttemptId: string }
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
  readonly deliver: (report: UnitReportV1) => void;
  /** The attempt is settled, delivered or not: the run may now finish converging. */
  readonly attemptEnded: (unitAttemptId: string) => void;
  readonly onFault: (fault: AttemptFault) => void;
  readonly audit: (entry: AttemptAudit) => void;
}

interface Reservation {
  readonly reservationId: string;
  readonly grantId: string;
  readonly estimatedTokens: number;
  readonly final: boolean;
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
const BUILT_IN: ReadonlySet<ExecutionKindV1> = new Set(['REPORT_PUBLISH', 'MESSAGE_PUBLISH']);
const VIOLATIONS: ReadonlySet<ReasonCodeV1> = new Set([
  'SCOPE_MISSING',
  'PATH_ESCAPE',
  'GUARD_FAILURE',
]);

const unitRefOf = (unit: UnitDefinitionV1) =>
  ({ kind: 'UNIT', id: unit.id, version: unit.version, digest: unit.digest }) as const;

/**
 * Core's attempt identity, reservations, result checks and retries for one run, migrated from M1
 * Core onto major 1: UnitReport carries `unitRunId` and `BudgetView`, the final call is per
 * AgentRun (M2Design 7.3), and budget never converges the run.
 */
export class RunAttempts {
  readonly #deps: RunAttemptsDeps;
  readonly #attempts = new Map<string, Attempt>();
  readonly #executions = new Set<string>();
  readonly #finalCalls = new Map<string, string>();

  public constructor(deps: RunAttemptsDeps) {
    this.#deps = deps;
  }

  /** Returns the unitAttemptId; Execution queues the attempt and starts it when idle. */
  async start(spec: AttemptSpec): Promise<string> {
    const unitAttemptId = await this.#deps.createAttempt(spec);
    if (this.#attempts.has(unitAttemptId)) throw new Error('Duplicate unitAttemptId');
    this.#attempts.set(unitAttemptId, { spec, unitAttemptId, retries: 0, checked: false });
    return unitAttemptId;
  }

  /** Must precede the Supervisor.execute of this executionId. */
  registerExecution(unitAttemptId: string, executionId: string): void {
    const attempt = this.#open(unitAttemptId);
    if (this.#executions.has(executionId)) throw new Error('Duplicate executionId');
    if (attempt.executionId !== undefined && attempt.retryFrom !== attempt.executionId)
      throw new Error('Retry was not authorized');
    this.#executions.add(executionId);
    attempt.executionId = executionId;
    delete attempt.retryFrom;
  }

  /** A delivered final call for this AgentRun, so the RunSummary can say so. */
  usedFinalCall(agentRunId: string): boolean {
    return this.#finalCalls.has(agentRunId);
  }

  requestReservation(request: {
    readonly unitAttemptId: string;
    readonly estimatedTokens: number;
    readonly final: boolean;
  }): ReservationDecision {
    if (this.#deps.isConverging()) return { granted: false, reason: 'RUN_CONVERGING' };
    const attempt = this.#open(request.unitAttemptId);
    const { agentRunId } = attempt.spec;
    const usedBy = this.#finalCalls.get(agentRunId);
    if (request.final && usedBy !== undefined && usedBy !== request.unitAttemptId) {
      this.#reject(attempt, 'FINAL_CALL_USED');
      return { granted: false, reason: 'FINAL_CALL_USED' };
    }
    const reserved = this.#reserve(attempt, request.estimatedTokens, request.final);
    if (!reserved.granted) return reserved;
    if (request.final) this.#finalCalls.set(agentRunId, request.unitAttemptId);
    return reserved;
  }

  #reserve(attempt: Attempt, estimatedTokens: number, final: boolean): ReservationDecision {
    const grant = this.#deps.scheduler.acquire(this.#deps.provider);
    if (!grant.ok) {
      this.#deps.onFault({ kind: 'KERNEL_INTERNAL' });
      return { granted: false, reason: 'RUN_CONVERGING' };
    }
    const reserved = this.#deps.ledger.reserve({ estimatedTokens, final });
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
      if (reasonCode === undefined || !VIOLATIONS.has(reasonCode))
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
    this.#deliver(this.#reportOf(attempt, check));
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
    this.#deps.scheduler.release(previous.grantId);
    delete attempt.reservation;
    const reserved = this.#reserve(attempt, previous.estimatedTokens, previous.final);
    if (!reserved.granted) {
      if (reserved.reason === 'RUN_CONVERGING') return { allowed: false, reason: 'RUN_CONVERGING' };
      if (reserved.reason === 'FINAL_CALL_USED') throw new Error('A retry cannot use a final call');
      return { allowed: false, reason: reserved.reason };
    }
    attempt.retries += 1;
    return { allowed: true, reservationId: reserved.reservationId, grantId: reserved.grantId };
  }

  /** Delivers a refusal of a Unit that never got an attempt (authorization, quota). */
  rejectWithoutAttempt(
    spec: Pick<AttemptSpec, 'requestId' | 'agentRunId' | 'unitRunId' | 'unit'>,
    refusal:
      | { readonly reasonCode: 'USER_DECLINED' }
      | { readonly reasonCode: 'QUOTA_EXHAUSTED'; readonly quota: 'TOOL_UNITS' | 'WALL_CLOCK' },
  ): void {
    this.#deliver({
      type: 'UnitReport',
      requestId: spec.requestId,
      agentRunId: spec.agentRunId,
      unitRunId: spec.unitRunId,
      unitRef: unitRefOf(spec.unit),
      executionKind: spec.unit.executionKind,
      budget: this.#deps.ledger.budgetView(),
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
    this.#deliver({
      ...this.#base(attempt),
      unitAttemptId: attempt.unitAttemptId,
      status: 'REJECTED',
      reasonCode,
    });
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
      budget: this.#deps.ledger.budgetView(),
    } as const;
  }

  #reportOf(attempt: Attempt, check: ResultCheck): UnitReportV1 {
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
      };
    }
    const reasonCode = check.reasonCode;
    if (reasonCode === undefined) throw new Error('Result check requires a reasonCode');
    const status =
      check.outcome === 'REJECTED' || check.outcome === 'NOT_DISPATCHED' ? 'REJECTED' : 'FAILED';
    return { ...base, status, reasonCode } as UnitReportV1;
  }

  #deliver(report: UnitReportV1): void {
    this.#deps.deliver(report);
    this.#deps.audit({
      type: 'UNIT_REPORTED',
      requestId: report.requestId,
      ...('reasonCode' in report ? { reasonCode: report.reasonCode } : {}),
    });
  }

  #ended(attempt: Attempt): void {
    this.#deps.attemptEnded(attempt.unitAttemptId);
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
