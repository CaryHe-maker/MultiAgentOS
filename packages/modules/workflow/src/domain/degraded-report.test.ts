import { AnalysisReportSchema, newId, validate } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { createDegradedReport } from './degraded-report.js';
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
    expect(report.summary).not.toContain('本次运行以失败结束');
    expect(report.summary).toContain('最后一次操作失败');
    expect(report.summary).toContain('认证或访问权限校验失败');
    expect(report.summary).not.toContain('private developer diagnostic');
    expect(report.degraded).toBe(true);
    expect(report.conclusions).toEqual([]);
    expect(report.unconfirmed).toEqual([]);
    expect(report.readSources).toEqual(metadata.readSources);
  });

  it('explains a final-call failure even when the trigger was a Round limit', () => {
    const report = createDegradedReport({
      ...metadata,
      reason: 'ROUND_LIMIT',
      lastIssue: { kind: 'FAILURE', failure: failureFromCode('UNIT_TIMEOUT') },
    });
    expect(report.summary).toContain('轮次上限');
    expect(report.summary).toContain('操作执行超时');
    expect(report.summary).not.toContain('本次运行以失败结束');
  });

  it('explains illegal output without publishing raw model content', () => {
    const report = createDegradedReport({
      ...metadata,
      lastIssue: { kind: 'INVALID_OUTPUT', reason: 'CONTROL_NOT_ALLOWED' },
    });
    expect(report.summary).toContain('最后一次模型输出不合格');
    expect(report.summary).toContain('不允许的控制动作');
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

  it('includes the empty-file notice in the existing summary field', () => {
    const report = createDegradedReport({ ...metadata, readSources: [], emptyFileCount: 2 });
    expect(report.summary).toContain('2 个空文件');
    expect(report.readSources).toEqual([]);
    expect(validate(AnalysisReportSchema, report).ok).toBe(true);
  });
});
