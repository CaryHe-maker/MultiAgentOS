import type { RunFailure, UnitDefinition, UnitReport, WrapUpReason } from '@multiagentos/contracts';
import { failureFromCode, finalCallReason, unitFailureHandling } from './failure-policy.js';

export type FailedUnitReport = Exclude<UnitReport, { readonly status: 'OK' }>;

export type FailureDecision =
  | { readonly kind: 'FAILED'; readonly failure: RunFailure }
  | {
      readonly kind: 'DEGRADED_REPORT';
      readonly reason: WrapUpReason;
      readonly lastFailure: RunFailure;
    }
  | { readonly kind: 'FINAL_CALL'; readonly reason: WrapUpReason }
  | { readonly kind: 'RETURN_TO_MODEL' };

/** Fatal normal calls close with failure only, even when the budget is exhausted. */
export function decideUnitFailure(
  unit: UnitDefinition,
  report: FailedUnitReport,
  isFinal: boolean,
  wrapUpReason?: WrapUpReason,
): FailureDecision {
  const handling = unitFailureHandling(unit, report.reasonCode, isFinal);
  const failure = failureFromCode(report.reasonCode, report.requestId);
  if (handling === 'FATAL') return { kind: 'FAILED', failure };
  if (report.budgetState === 'EXHAUSTED' || report.reasonCode === 'BUDGET_EXHAUSTED')
    return { kind: 'DEGRADED_REPORT', reason: 'BUDGET_EXHAUSTED', lastFailure: failure };
  if (handling === 'DEGRADED_REPORT') {
    if (wrapUpReason === undefined)
      throw new Error('A degraded final-call must have a wrap-up reason');
    return { kind: 'DEGRADED_REPORT', reason: wrapUpReason, lastFailure: failure };
  }
  return handling === 'FINAL_CALL'
    ? { kind: 'FINAL_CALL', reason: finalCallReason(report.reasonCode) }
    : { kind: 'RETURN_TO_MODEL' };
}
