import { UnitReportSchema, newId, validate } from '@multiagentos/contracts';
import type { UnitFailedCode } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { definitions } from '../test-support/definitions.js';
import { decideUnitFailure } from './failure-decision.js';
import type { FailedUnitReport } from './failure-decision.js';

const model = definitions().units[0];
if (model === undefined) throw new Error('Missing model Unit fixture');
const withPolicy = { ...model, failurePolicy: { PROVIDER_ERROR: 'RETURN_TO_MODEL' as const } };
const failed = (reasonCode: UnitFailedCode = 'PROVIDER_AUTH'): FailedUnitReport => ({
  type: 'UnitReport',
  requestId: newId('req'),
  agentRunId: newId('agr'),
  unitAttemptId: newId('una'),
  unitRef: { kind: 'UNIT', id: model.id, version: model.version, digest: model.digest },
  executionKind: 'MODEL',
  status: 'FAILED',
  reasonCode,
  budgetState: 'EXHAUSTED',
});

describe('failure and budget terminal decision', () => {
  it('retains FAILED for fatal exhausted calls without requesting any report', () => {
    const report = failed();
    expect(validate(UnitReportSchema, report).ok).toBe(true);
    expect(decideUnitFailure(model, report, false)).toEqual({
      kind: 'FAILED',
      failure: {
        code: 'PROVIDER_AUTH',
        category: 'DEPENDENCY',
        source: 'WORKFLOW',
        unitRequestId: report.requestId,
      },
    });
  });

  it('keeps an ordinary fatal failure without EXHAUSTED as a failure without a new report', () => {
    const decision = decideUnitFailure(model, { ...failed(), budgetState: 'NORMAL' }, false);
    expect(decision.kind).toBe('FAILED');
    expect(decision).not.toHaveProperty('reportReason');
  });

  it('nonfatal EXHAUSTED degrades and retains the last failure for the report', () => {
    const report = failed('PROVIDER_ERROR');
    expect(decideUnitFailure(withPolicy, report, false)).toMatchObject({
      kind: 'DEGRADED_REPORT',
      reason: 'BUDGET_EXHAUSTED',
      lastFailure: { code: 'PROVIDER_ERROR', unitRequestId: report.requestId },
    });
  });

  it('preserves the final-call failure exception and its original trigger', () => {
    const decision = decideUnitFailure(
      model,
      { ...failed(), budgetState: 'NORMAL' },
      true,
      'ROUND_LIMIT',
    );
    expect(decision).toMatchObject({
      kind: 'DEGRADED_REPORT',
      reason: 'ROUND_LIMIT',
      lastFailure: { code: 'PROVIDER_AUTH' },
    });
  });
});
