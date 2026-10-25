import type {
  ExecutionScope,
  PinnedDefinitionSet,
  ReasonCode,
  TokenUsage,
  UnitDefinition,
  UnitInput,
  UnitReport,
  ViolationCode,
} from '@multiagentos/contracts';
import type {
  AttemptRegistration,
  AttemptSpec,
  CoreSyscalls,
  ExecutionRegistration,
  MonitorDuties,
  ReservationDecision,
  ResultCheck,
  RetryDecision,
  SchedulerDuties,
  Settlement,
} from '../interfaces/index.js';
import { AttemptIdentityRegistry } from './attempt-identity.js';
import type { AuditSink, CoreAuditEntry } from './audit.js';
import type { CoreEventSink } from './events.js';
import type { RunState } from './run-state.js';

export interface AttemptStarter {
  createAttempt(spec: AttemptSpec): Promise<string>;
}

interface ReservationRecord {
  readonly reservationId: string;
  readonly grantId: string;
  readonly estimatedTokens: number;
  readonly final: boolean;
}

interface AttemptMeta {
  readonly requestId: string;
  readonly agentRunId: string;
  readonly unit: UnitDefinition;
  readonly input: UnitInput;
  readonly scope: ExecutionScope;
  readonly pinned: PinnedDefinitionSet;
  readonly runEpoch: number;
  readonly requiresLease: boolean;
  reservation: ReservationRecord | undefined;
  retries: number;
}

type UnitReportBase = {
  readonly type: 'UnitReport';
  readonly requestId: string;
  readonly agentRunId: string;
  readonly unitRef: UnitReport['unitRef'];
  readonly executionKind: UnitReport['executionKind'];
  readonly unitAttemptId: string;
  readonly budgetState: UnitReport['budgetState'];
};

export interface CoreAttemptsDeps {
  readonly run: RunState;
  readonly execution: AttemptStarter;
  readonly monitor: MonitorDuties;
  readonly scheduler: SchedulerDuties;
  readonly audit: AuditSink;
  readonly events?: CoreEventSink;
  readonly provider: string;
  readonly technicalRetryLimit: number;
  readonly now: () => Date;
  readonly leaseIsValid: () => boolean;
  readonly onViolation: (reasonCode: ViolationCode, unitRequestId: string | undefined) => void;
  readonly onStopUnconfirmed: (unitRequestId: string | undefined) => void;
  readonly onKernelInternal: () => void;
  readonly onResultSettled?: (executionId: string) => void;
}

/**
 * Core's internal syscall implementation for one run. Execution calls it for attempt identity,
 * reservations, result checks and retries; the run actor only wires it in stage 4.
 */
export class CoreAttempts implements CoreSyscalls {
  readonly #run: RunState;
  readonly #execution: AttemptStarter;
  readonly #monitor: MonitorDuties;
  readonly #scheduler: SchedulerDuties;
  readonly #audit: AuditSink;
  readonly #events: CoreEventSink | undefined;
  readonly #provider: string;
  readonly #technicalRetryLimit: number;
  readonly #now: () => Date;
  readonly #leaseIsValid: () => boolean;
  readonly #onViolation: CoreAttemptsDeps['onViolation'];
  readonly #onStopUnconfirmed: CoreAttemptsDeps['onStopUnconfirmed'];
  readonly #onKernelInternal: CoreAttemptsDeps['onKernelInternal'];
  readonly #onResultSettled: CoreAttemptsDeps['onResultSettled'];
  readonly #identity: AttemptIdentityRegistry;
  readonly #byRequest = new Map<string, AttemptMeta>();
  readonly #byAttempt = new Map<string, AttemptMeta>();
  #finalCallAttemptId: string | undefined;

  public constructor(deps: CoreAttemptsDeps) {
    this.#run = deps.run;
    this.#execution = deps.execution;
    this.#monitor = deps.monitor;
    this.#scheduler = deps.scheduler;
    this.#audit = deps.audit;
    this.#events = deps.events;
    this.#provider = deps.provider;
    this.#technicalRetryLimit = deps.technicalRetryLimit;
    this.#now = deps.now;
    this.#leaseIsValid = deps.leaseIsValid;
    this.#onViolation = deps.onViolation;
    this.#onStopUnconfirmed = deps.onStopUnconfirmed;
    this.#onKernelInternal = deps.onKernelInternal;
    this.#onResultSettled = deps.onResultSettled;
    this.#identity = new AttemptIdentityRegistry(deps.run.workflowRunId, () => deps.run.runEpoch);
  }

  /** Core starts the attempt through Execution after the permission decision allowed it. */
  public async startAttempt(spec: AttemptSpec): Promise<string> {
    const meta: AttemptMeta = {
      requestId: spec.requestId,
      agentRunId: spec.agentRunId,
      unit: spec.unit,
      input: spec.input,
      scope: spec.scope,
      pinned: spec.pinned,
      runEpoch: spec.runEpoch,
      requiresLease: spec.unit.protectedCapabilities.includes('repo.read'),
      reservation: undefined,
      retries: 0,
    };
    this.#byRequest.set(spec.requestId, meta);
    const unitAttemptId = await this.#execution.createAttempt(spec);
    this.#byAttempt.set(unitAttemptId, meta);
    return unitAttemptId;
  }

  public registerAttempt(attempt: AttemptRegistration): void {
    this.#identity.registerAttempt(attempt);
    const meta = this.#byRequest.get(attempt.requestId);
    if (meta !== undefined) this.#byAttempt.set(attempt.unitAttemptId, meta);
  }

  public registerExecution(execution: ExecutionRegistration): void {
    this.#identity.registerExecution(execution);
  }

  public requestReservation(request: {
    readonly unitAttemptId: string;
    readonly estimatedTokens: number;
    readonly final: boolean;
  }): ReservationDecision {
    if (this.#run.runState !== 'RUNNING') return { granted: false, reason: 'RUN_CONVERGING' };
    const meta = this.#requireMeta(request.unitAttemptId);
    if (
      request.final &&
      this.#finalCallAttemptId !== undefined &&
      this.#finalCallAttemptId !== request.unitAttemptId
    ) {
      this.#deliverRejected(meta, request.unitAttemptId, 'FINAL_CALL_USED');
      return { granted: false, reason: 'FINAL_CALL_USED' };
    }

    const grant = this.#scheduler.acquire(this.#provider);
    if (!grant.ok) {
      this.#onKernelInternal();
      return { granted: false, reason: 'RUN_CONVERGING' };
    }
    const reserved = this.#monitor.reserve({
      estimatedTokens: request.estimatedTokens,
      final: request.final,
    });
    if (!reserved.ok) {
      this.#scheduler.release(grant.grantId);
      this.#deliverRejected(meta, request.unitAttemptId, reserved.reasonCode);
      return { granted: false, reason: reserved.reasonCode };
    }

    if (request.final) this.#finalCallAttemptId = request.unitAttemptId;
    meta.reservation = {
      reservationId: reserved.reservationId,
      grantId: grant.grantId,
      estimatedTokens: request.estimatedTokens,
      final: request.final,
    };
    return {
      granted: true,
      reservationId: reserved.reservationId,
      grantId: grant.grantId,
    };
  }

  public submitResultCheck(check: ResultCheck): void {
    if (this.#run.runState === 'CLOSED') {
      this.#auditStale(check.unitAttemptId, check.reasonCode);
      return;
    }
    if (!this.#identity.check(this.#run.workflowRunId, check, this.#leaseIsValid)) {
      this.#auditStale(check.unitAttemptId, check.reasonCode);
      return;
    }

    const meta = this.#byAttempt.get(check.unitAttemptId);
    if (meta === undefined) throw new Error('Attempt metadata is missing');
    const settlement = settlementOf(check, meta);
    if (meta.reservation !== undefined && settlement !== undefined) {
      const result = this.#monitor.settle(meta.reservation.reservationId, settlement);
      for (const anomaly of result.anomalies)
        this.#recordAudit({
          type: 'SETTLEMENT_ANOMALY',
          unitAttemptId: check.unitAttemptId,
          anomaly: anomaly.type,
        });
    }
    if (check.outcome !== 'STOP_UNCONFIRMED' && meta.reservation !== undefined)
      this.#scheduler.release(meta.reservation.grantId);

    if (check.outcome === 'VIOLATION') {
      this.#identity.markChecked(check.unitAttemptId);
      this.#settled(check.executionId);
      this.#onViolation(violationOf(check), meta.requestId);
      return;
    }
    if (check.outcome === 'STOP_UNCONFIRMED') {
      this.#identity.markChecked(check.unitAttemptId);
      this.#settled(check.executionId);
      if (this.#run.runState === 'RUNNING') this.#onStopUnconfirmed(meta.requestId);
      return;
    }
    if (check.outcome === 'TERMINATED' && check.reasonCode === 'EXECUTION_CANCELLED') {
      this.#identity.markChecked(check.unitAttemptId);
      this.#settled(check.executionId);
      this.#run.units.notDelivered += 1;
      this.#recordAudit({
        type: 'UNIT_NOT_DELIVERED',
        requestId: meta.requestId,
        unitAttemptId: check.unitAttemptId,
        reasonCode: check.reasonCode,
      });
      return;
    }

    // A result from an older runEpoch or a run that already started converging is settled as
    // evidence, but it cannot be delivered. Check this before building a UnitReport: a
    // COMPLETED result then needs no outputRef and Execution writes no new artifact.
    if (this.#run.runState !== 'RUNNING' || meta.runEpoch !== this.#run.runEpoch) {
      this.#identity.markChecked(check.unitAttemptId);
      this.#settled(check.executionId);
      this.#run.units.notDelivered += 1;
      this.#recordAudit({
        type: 'UNIT_NOT_DELIVERED',
        requestId: meta.requestId,
        unitAttemptId: check.unitAttemptId,
        ...(check.reasonCode === undefined ? {} : { reasonCode: check.reasonCode }),
      });
      return;
    }

    const report = this.#reportOf(meta, check);
    if (report === undefined) throw new Error('Result has no UnitReport shape');
    this.#identity.markChecked(check.unitAttemptId);
    this.#settled(check.executionId);
    this.#deliver(meta, report);
  }

  public retryExecution(request: {
    readonly unitAttemptId: string;
    readonly previousExecutionId: string;
    readonly requestState?: 'NOT_SENT' | 'SENT' | 'UNKNOWN';
    readonly usage?: TokenUsage;
  }): RetryDecision {
    if (this.#run.runState !== 'RUNNING') return { allowed: false, reason: 'RUN_CONVERGING' };
    const meta = this.#requireMeta(request.unitAttemptId);
    if (meta.retries >= this.#technicalRetryLimit) return { allowed: false, reason: 'RETRY_LIMIT' };

    if (meta.unit.executionKind === 'MODEL') {
      // A sent request may be retried only when its consumption is known, so it is charged once.
      const settlement: Settlement | undefined =
        request.requestState === 'NOT_SENT'
          ? { type: 'NOT_SENT' }
          : request.requestState === 'SENT' && request.usage !== undefined
            ? { type: 'ACTUAL', usage: request.usage }
            : undefined;
      if (settlement === undefined) return { allowed: false, reason: 'REQUEST_MAY_BE_SENT' };
      this.#identity.authorizeRetry(request.unitAttemptId, request.previousExecutionId);
      const previous = meta.reservation;
      if (previous === undefined) throw new Error('A MODEL attempt has no reservation to retry');
      const settled = this.#monitor.settle(previous.reservationId, settlement);
      for (const anomaly of settled.anomalies)
        this.#recordAudit({
          type: 'SETTLEMENT_ANOMALY',
          unitAttemptId: request.unitAttemptId,
          anomaly: anomaly.type,
        });
      this.#scheduler.release(previous.grantId);
      meta.reservation = undefined;

      const grant = this.#scheduler.acquire(this.#provider);
      if (!grant.ok) {
        this.#onKernelInternal();
        return { allowed: false, reason: 'RUN_CONVERGING' };
      }
      const reserved = this.#monitor.reserve({
        estimatedTokens: previous.estimatedTokens,
        final: previous.final,
      });
      if (!reserved.ok) {
        this.#scheduler.release(grant.grantId);
        this.#deliverRejected(meta, request.unitAttemptId, reserved.reasonCode);
        return { allowed: false, reason: reserved.reasonCode };
      }
      meta.reservation = {
        reservationId: reserved.reservationId,
        grantId: grant.grantId,
        estimatedTokens: previous.estimatedTokens,
        final: previous.final,
      };
      meta.retries += 1;
      return {
        allowed: true,
        reservationId: reserved.reservationId,
        grantId: grant.grantId,
      };
    }

    this.#identity.authorizeRetry(request.unitAttemptId, request.previousExecutionId);
    meta.retries += 1;
    return { allowed: true };
  }

  public currentRunEpoch(): number {
    return this.#run.runEpoch;
  }

  /** RunSummary.model.finalCallUsed. */
  public hasFinalCall(): boolean {
    return this.#finalCallAttemptId !== undefined;
  }

  #settled(executionId: string | undefined): void {
    if (executionId !== undefined) this.#onResultSettled?.(executionId);
  }

  #requireMeta(unitAttemptId: string): AttemptMeta {
    const meta = this.#byAttempt.get(unitAttemptId);
    if (meta === undefined) throw new Error('Attempt metadata is missing');
    return meta;
  }

  #reportOf(meta: AttemptMeta, check: ResultCheck): UnitReport | undefined {
    const base = this.#baseReport(meta, check);
    if (check.outcome === 'COMPLETED') {
      if (check.output === undefined || check.outputRef === undefined)
        throw new Error('COMPLETED result requires output and outputRef');
      return {
        ...base,
        status: 'OK',
        output: check.output,
        outputRef: check.outputRef,
      } as UnitReport;
    }
    if (check.outcome === 'REJECTED')
      return { ...base, status: 'REJECTED', reasonCode: requiredReason(check) } as UnitReport;
    if (check.outcome === 'FAILED')
      return { ...base, status: 'FAILED', reasonCode: requiredReason(check) } as UnitReport;
    if (check.outcome === 'NOT_DISPATCHED')
      return { ...base, status: 'REJECTED', reasonCode: requiredReason(check) } as UnitReport;
    if (check.outcome === 'TERMINATED')
      return { ...base, status: 'FAILED', reasonCode: requiredReason(check) } as UnitReport;
    return undefined;
  }

  #baseReport(meta: AttemptMeta, check: ResultCheck): UnitReportBase {
    return {
      type: 'UnitReport',
      requestId: meta.requestId,
      agentRunId: meta.agentRunId,
      unitRef: {
        kind: 'UNIT',
        id: meta.unit.id,
        version: meta.unit.version,
        digest: meta.unit.digest,
      },
      executionKind: meta.unit.executionKind as UnitReport['executionKind'],
      unitAttemptId: check.unitAttemptId,
      budgetState: this.#monitor.budgetState(),
    };
  }

  #deliverRejected(
    meta: AttemptMeta,
    unitAttemptId: string,
    reasonCode: 'FINAL_CALL_USED' | 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED',
  ): void {
    const base = this.#baseReport(meta, { unitAttemptId, outcome: 'NOT_DISPATCHED' });
    this.#deliver(meta, { ...base, status: 'REJECTED', reasonCode });
    this.#identity.abandon(unitAttemptId);
  }

  #deliver(meta: AttemptMeta, report: UnitReport): void {
    const deliverable = this.#run.runState === 'RUNNING' && meta.runEpoch === this.#run.runEpoch;
    const unitAttemptId = 'unitAttemptId' in report ? report.unitAttemptId : undefined;
    const reasonCode = 'reasonCode' in report ? report.reasonCode : undefined;
    if (!deliverable) {
      this.#run.units.notDelivered += 1;
      this.#recordAudit({
        type: 'UNIT_NOT_DELIVERED',
        requestId: meta.requestId,
        ...(unitAttemptId === undefined ? {} : { unitAttemptId }),
        ...(reasonCode === undefined ? {} : { reasonCode }),
      });
      return;
    }
    if (report.status === 'OK') this.#run.units.ok += 1;
    else if (report.status === 'REJECTED') this.#run.units.rejected += 1;
    else this.#run.units.failed += 1;
    this.#events?.emit(report);
    this.#recordAudit({
      type: 'UNIT_REPORTED',
      requestId: meta.requestId,
      ...(unitAttemptId === undefined ? {} : { unitAttemptId }),
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
  }

  #auditStale(unitAttemptId: string, reasonCode: ReasonCode | undefined): void {
    this.#recordAudit({
      type: 'STALE_FACT',
      unitAttemptId,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
  }

  #recordAudit(entry: {
    readonly type: 'SETTLEMENT_ANOMALY' | 'UNIT_NOT_DELIVERED' | 'UNIT_REPORTED' | 'STALE_FACT';
    readonly requestId?: string;
    readonly unitAttemptId?: string;
    readonly reasonCode?: ReasonCode;
    readonly anomaly?: 'ACTUAL_EXCEEDED_ESTIMATE' | 'CONFLICTING_SETTLEMENT';
  }): void {
    const record: CoreAuditEntry = {
      at: this.#now().toISOString(),
      workflowRunId: this.#run.workflowRunId,
      type: entry.type,
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      ...(entry.unitAttemptId === undefined ? {} : { unitAttemptId: entry.unitAttemptId }),
      ...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }),
      ...(entry.anomaly === undefined ? {} : { anomaly: entry.anomaly }),
    };
    this.#audit.append(record).catch(() => undefined);
  }
}

function settlementOf(check: ResultCheck, meta: AttemptMeta): Settlement | undefined {
  if (meta.reservation === undefined) return undefined;
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

function requiredReason(check: ResultCheck): ReasonCode {
  if (check.reasonCode === undefined) throw new Error('Result check requires a reasonCode');
  return check.reasonCode;
}

function violationOf(check: ResultCheck): ViolationCode {
  const reason = requiredReason(check);
  if (reason !== 'SCOPE_MISSING' && reason !== 'PATH_ESCAPE' && reason !== 'GUARD_FAILURE')
    throw new Error('Violation result has a non-violation reasonCode');
  return reason;
}
