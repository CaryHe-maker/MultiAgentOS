import { AnalysisReportSchema, newId, validate } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { DEGRADED_REPORT_SUMMARY, createDegradedReport } from './degraded-report.js';
import { failureFromCode } from './failure-policy.js';
import type { DegradedReportInput } from './degraded-report.js';

const metadata = {
  workflowRunId: newId('wfr'),
  goal: '分析缓存问题',
  reason: 'BUDGET_EXHAUSTED',
  createdAt: '2026-10-14T00:00:00.000Z',
  readSources: [
    {
      path: 'src/cache.ts',
      startLine: 10,
      endLine: 40,
      readRequestId: newId('req'),
      readContentSha256: 'a'.repeat(64),
    },
  ],
  agentRounds: [{ agentId: 'code-viewer', agentRunId: newId('agr'), roundsUsed: 5, maxRounds: 20 }],
} satisfies DegradedReportInput;

describe('degraded report from known facts', () => {
  it('describes a failed final-call without inventing conclusions or leaking detail', () => {
    const report = createDegradedReport({
      ...metadata,
      lastIssue: {
        kind: 'FAILURE',
        failure: {
          ...failureFromCode('PROVIDER_AUTH'),
          detail: 'private developer diagnostic',
        },
      },
    });
    expect(validate(AnalysisReportSchema, report).ok).toBe(true);
    // Workflow writes no user-facing text; UserInteraction describes the ending from wrapUp.
    expect(report.summary).toBe(DEGRADED_REPORT_SUMMARY);
    // Only the reason code reaches the report; failure.detail stays inside Workflow.
    expect(report.wrapUp).toEqual({
      reason: 'BUDGET_EXHAUSTED',
      lastIssue: { kind: 'FAILURE', code: 'PROVIDER_AUTH' },
    });
    expect(JSON.stringify(report)).not.toContain('private developer diagnostic');
    expect(report.degraded).toBe(true);
    expect(report.conclusions).toEqual([]);
    expect(report.unconfirmed).toEqual([]);
    expect(report.readSources).toEqual(metadata.readSources);
  });

  it('keeps the triggering wrap-up reason whatever the last issue was', () => {
    const report = createDegradedReport({
      ...metadata,
      reason: 'ROUND_LIMIT',
      lastIssue: { kind: 'INVALID_OUTPUT', reason: 'CONTROL_NOT_ALLOWED' },
    });
    expect(report.wrapUp).toEqual({
      reason: 'ROUND_LIMIT',
      lastIssue: { kind: 'INVALID_OUTPUT', reason: 'CONTROL_NOT_ALLOWED' },
    });
    expect(report.summary).toBe(DEGRADED_REPORT_SUMMARY);
    expect(validate(AnalysisReportSchema, report).ok).toBe(true);
  });

  it('can describe exhaustion before any successful read and copies known facts', () => {
    const report = createDegradedReport({ ...metadata, readSources: [], agentRounds: [] });
    expect(validate(AnalysisReportSchema, report).ok).toBe(true);
    expect(report.readSources).toEqual([]);
    const populated = createDegradedReport(metadata);
    expect(populated.readSources).not.toBe(metadata.readSources);
    expect(populated.readSources[0]).not.toBe(metadata.readSources[0]);
  });

  it('lists empty reads as facts, never as summary text or line sources', () => {
    const report = createDegradedReport({ ...metadata, readSources: [], emptyPaths: ['a', 'b'] });
    expect(report.summary).toBe(DEGRADED_REPORT_SUMMARY);
    expect(report.emptyReads).toEqual(['a', 'b']);
    expect(report.readSources).toEqual([]);
    expect(createDegradedReport({ ...metadata, emptyPaths: [] })).not.toHaveProperty('emptyReads');
    expect(createDegradedReport({ ...metadata, lastIssue: { kind: 'NO_FINISH' } }).wrapUp).toEqual({
      reason: 'BUDGET_EXHAUSTED',
      lastIssue: { kind: 'NO_FINISH' },
    });
    expect(validate(AnalysisReportSchema, report).ok).toBe(true);
  });
});
