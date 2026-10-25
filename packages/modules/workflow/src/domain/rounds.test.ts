import { UnitReportSchema, newId, validate } from '@multiagentos/contracts';
import type { AnalysisReportDraft, UnitReport } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import {
  directiveForBudget,
  directiveForFinalCall,
  nextCallMode,
  roundsAfterReport,
  applyBudgetFacts,
  prepareRound,
} from './rounds.js';
import type { AnalysisAction } from './analysis-action.js';
import type { AgentRunState } from './state.js';
import { definitions } from '../test-support/definitions.js';
import { recordRegeneration, recordRoundProgress } from './progress.js';
import { unitFailureHandling } from './failure-policy.js';

const draft: AnalysisReportDraft = { summary: '分析结果', conclusions: [], unconfirmed: [] };
const finish: AnalysisAction = { kind: 'FINISH', toolCallId: 'finish-1', draft };
const run = (extra: Partial<AgentRunState> = {}): AgentRunState => ({
  agentRunId: newId('agr'),
  definitions: definitions(),
  roundsUsed: 0,
  regenerationCount: 0,
  noProgressCount: 0,
  steps: [],
  pendingRequestIds: new Set(),
  elidedRequestIds: [],
  ...extra,
});

describe('Round and final-call decisions', () => {
  it.each(['OK', 'FAILED', 'REJECTED'] as const)('counts a MODEL %s report correctly', (status) => {
    expect(roundsAfterReport(2, { executionKind: 'MODEL', status })).toBe(
      status === 'REJECTED' ? 2 : 3,
    );
  });

  it.each([
    'REPOSITORY_ORIENT',
    'REPOSITORY_SEARCH',
    'FILE_READ',
    'CONTEXT_ASSEMBLE',
    'REPORT_PUBLISH',
  ] as const)('never counts %s as a model Round', (executionKind) => {
    for (const status of ['OK', 'FAILED', 'REJECTED'] as const)
      expect(roundsAfterReport(2, { executionKind, status })).toBe(2);
  });

  it('reserves the last Round for final-call including a one-Round Agent', () => {
    expect(nextCallMode(0, 3)).toEqual({ final: false });
    expect(nextCallMode(1, 3)).toEqual({ final: false });
    expect(nextCallMode(2, 3)).toEqual({ final: true, wrapUpReason: 'ROUND_LIMIT' });
    expect(nextCallMode(0, 1)).toEqual({ final: true, wrapUpReason: 'ROUND_LIMIT' });
  });

  it('preserves the earlier reason when the last Round is also due', () => {
    expect(nextCallMode(2, 3, 'USER_DECLINED')).toEqual({
      final: true,
      wrapUpReason: 'USER_DECLINED',
    });
  });

  it('keeps already submitted tools running during WRAP_UP', () => {
    expect(
      directiveForBudget({ executionKind: 'FILE_READ', status: 'OK', budgetState: 'WRAP_UP' }),
    ).toBe('WRAP_UP');
    expect(
      directiveForBudget({ executionKind: 'MODEL', status: 'OK', budgetState: 'NORMAL' }),
    ).toBe('CONTINUE');
  });

  it('EXHAUSTED permits publishing a legal FINISH only from a successful model-call', () => {
    const report: Pick<UnitReport, 'executionKind' | 'status' | 'budgetState'> = {
      executionKind: 'MODEL',
      status: 'OK',
      budgetState: 'EXHAUSTED',
    };
    expect(directiveForBudget(report, finish)).toBe('PUBLISH');
    expect(directiveForBudget(report, { kind: 'INVALID', reason: 'NO_ACTION' })).toBe(
      'DEGRADED_REPORT',
    );
    expect(directiveForBudget({ ...report, executionKind: 'FILE_READ' }, finish)).toBe(
      'DEGRADED_REPORT',
    );
    expect(directiveForBudget({ ...report, status: 'FAILED' }, finish)).toBe('DEGRADED_REPORT');
  });

  it('does not regenerate, hand off, or execute tools after a final-call result', () => {
    expect(directiveForFinalCall(finish)).toBe('PUBLISH');
    for (const action of [
      undefined,
      { kind: 'INVALID', reason: 'CONTROL_NOT_ALLOWED' },
      { kind: 'TOOL_CALLS', calls: [] },
      {
        kind: 'HANDOFF',
        toolCallId: 'handoff-1',
        brief: {
          task: '分析仓库',
          focusAreas: [],
          openQuestions: [],
        },
      },
    ] as (AnalysisAction | undefined)[])
      expect(directiveForFinalCall(action)).toBe('DEGRADED_REPORT');
  });

  it('applies WRAP_UP before regeneration, no-progress, and the Round limit', () => {
    const budget = applyBudgetFacts(
      run({ roundsUsed: 2, regenerationCount: 2, noProgressCount: 1 }),
      'WRAP_UP',
    );
    const invalid = recordRegeneration(budget, true, 3);
    const progress = recordRoundProgress(invalid, false, 2);
    expect(progress.regenerationCount).toBe(3);
    expect(progress.noProgressCount).toBe(2);
    expect(progress.wrapUpReason).toBe('BUDGET_WRAP_UP');
    const prepared = prepareRound(progress, 'WRAP_UP', false);
    expect(prepared.kind).toBe('CALL');
    if (prepared.kind !== 'CALL') throw new Error('Expected a final-call');
    expect(prepared.run.wrapUpReason).toBe('BUDGET_WRAP_UP');
  });

  it('preserves an existing reason when new budget facts arrive', () => {
    expect(applyBudgetFacts(run({ wrapUpReason: 'USER_DECLINED' }), 'WRAP_UP').wrapUpReason).toBe(
      'USER_DECLINED',
    );
  });

  it('reserves one final-call without adding a step and cannot reserve a second', () => {
    const prepared = prepareRound(run({ roundsUsed: 2 }), 'NORMAL', false);
    if (prepared.kind !== 'CALL') throw new Error('Expected a final-call');
    expect(prepared.final).toBe(true);
    expect(prepared.finalCallUsed).toBe(true);
    expect(prepared.run.wrapUpReason).toBe('ROUND_LIMIT');
    expect(prepared.run.steps).toEqual([]);
    expect(prepareRound(prepared.run, 'NORMAL', true)).toEqual({
      kind: 'DEGRADED_REPORT',
      reason: 'ROUND_LIMIT',
    });
  });

  it('EXHAUSTED degrades directly without recording a final-call notice', () => {
    const initial = run();
    expect(prepareRound(initial, 'EXHAUSTED', false)).toEqual({
      kind: 'DEGRADED_REPORT',
      reason: 'BUDGET_EXHAUSTED',
    });
    expect(initial.steps).toEqual([]);
  });

  it('the contract permits a fatal normal model failure together with EXHAUSTED', () => {
    const report: UnitReport = {
      type: 'UnitReport',
      requestId: newId('req'),
      agentRunId: newId('agr'),
      unitAttemptId: newId('una'),
      status: 'FAILED',
      reasonCode: 'PROVIDER_AUTH',
      executionKind: 'MODEL',
      budgetState: 'EXHAUSTED',
      unitRef: { kind: 'UNIT', id: 'model-call', version: 'v0.1.0', digest: 'a'.repeat(64) },
    };
    expect(validate(UnitReportSchema, report).ok).toBe(true);
    const unit = definitions().units[0];
    if (unit === undefined) throw new Error('Missing model Unit fixture');
    expect(unitFailureHandling(unit, report.reasonCode, false)).toBe('FATAL');
    expect(directiveForBudget(report)).toBe('DEGRADED_REPORT');
  });
});
