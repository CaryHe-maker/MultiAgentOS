import type { BudgetState, FeedbackStep, UnitReport, WrapUpReason } from '@multiagentos/contracts';
import type { AnalysisAction } from './analysis-action.js';
import type { AgentRunState } from './state.js';

/** Rejected model calls never reached the provider; other Unit kinds do not consume rounds. */
export function roundsAfterReport(
  roundsUsed: number,
  report: Pick<UnitReport, 'executionKind' | 'status'>,
): number {
  return roundsUsed + (report.executionKind === 'MODEL' && report.status !== 'REJECTED' ? 1 : 0);
}

/** Called after budget and action facts have been applied; preserves a prior wrap-up reason. */
export function nextCallMode(
  roundsUsed: number,
  maxRounds: number,
  wrapUpReason?: WrapUpReason,
): { readonly final: boolean; readonly wrapUpReason?: WrapUpReason } {
  if (wrapUpReason !== undefined) return { final: true, wrapUpReason };
  return maxRounds - roundsUsed <= 1
    ? { final: true, wrapUpReason: 'ROUND_LIMIT' }
    : { final: false };
}

export type BudgetDirective = 'CONTINUE' | 'WRAP_UP' | 'PUBLISH' | 'DEGRADED_REPORT';

/** EXHAUSTED allows only an already returned legal FINISH, never a new model or tool call. */
export function directiveForBudget(
  report: Pick<UnitReport, 'executionKind' | 'status' | 'budgetState'>,
  action?: AnalysisAction,
): BudgetDirective {
  if (report.budgetState === 'EXHAUSTED')
    return report.executionKind === 'MODEL' && report.status === 'OK' && action?.kind === 'FINISH'
      ? 'PUBLISH'
      : 'DEGRADED_REPORT';
  return report.budgetState === 'WRAP_UP' ? 'WRAP_UP' : 'CONTINUE';
}

/** After a final-call, every result other than legal FINISH degrades without regeneration. */
export function directiveForFinalCall(action?: AnalysisAction): 'PUBLISH' | 'DEGRADED_REPORT' {
  return action?.kind === 'FINISH' ? 'PUBLISH' : 'DEGRADED_REPORT';
}

/** Apply budget facts before failures, action counters, or the Round limit. */
export function applyBudgetFacts<T extends { readonly wrapUpReason?: WrapUpReason }>(
  run: T,
  budgetState: BudgetState,
): T {
  return budgetState === 'WRAP_UP' && run.wrapUpReason === undefined
    ? { ...run, wrapUpReason: 'BUDGET_WRAP_UP' as const }
    : run;
}

export type RoundPreparation =
  | {
      readonly kind: 'CALL';
      readonly run: AgentRunState;
      readonly final: boolean;
      readonly finalCallUsed: boolean;
    }
  | { readonly kind: 'DEGRADED_REPORT'; readonly reason: WrapUpReason };

/** Reserves final-call once, before assembling its context, and appends exactly one notice. */
export function prepareRound(
  run: AgentRunState,
  budgetState: BudgetState,
  finalCallUsed: boolean,
): RoundPreparation {
  if (budgetState === 'EXHAUSTED') return { kind: 'DEGRADED_REPORT', reason: 'BUDGET_EXHAUSTED' };
  if (finalCallUsed) {
    if (run.wrapUpReason === undefined)
      throw new Error('A used final-call must have a wrap-up reason');
    return { kind: 'DEGRADED_REPORT', reason: run.wrapUpReason };
  }
  if (run.roundsUsed >= run.definitions.agent.limits.maxRounds)
    throw new Error('Cannot start a model round beyond the pinned maxRounds');
  const mode = nextCallMode(
    run.roundsUsed,
    run.definitions.agent.limits.maxRounds,
    applyBudgetFacts(run, budgetState).wrapUpReason,
  );
  if (!mode.final) return { kind: 'CALL', run, final: false, finalCallUsed: false };
  if (mode.wrapUpReason === undefined) throw new Error('A final-call must have a wrap-up reason');
  const notice: FeedbackStep = {
    kind: 'FEEDBACK',
    round: run.roundsUsed + 1,
    code: 'WRAP_UP_NOTICE',
    message: `Finish the analysis in this final-call. Reason: ${mode.wrapUpReason}.`,
  };
  return {
    kind: 'CALL',
    final: true,
    finalCallUsed: true,
    run: { ...run, wrapUpReason: mode.wrapUpReason, steps: [...run.steps, notice] },
  };
}
