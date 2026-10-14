import type { AnalysisReport, RunSummary } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { REASON_CODES } from '@multiagentos/contracts';
import { describeReason } from './interaction-messages.js';
import { renderReport, renderSummary } from './report-view.js';

const report: AnalysisReport = {
  workflowRunId: 'wfr_123456',
  goal: '分析仓库',
  summary: '已读取文件。',
  degraded: false,
  conclusions: [
    {
      statement: '入口定义明确。',
      sources: [
        {
          path: 'src/index.ts',
          startLine: 1,
          endLine: 3,
          readRequestId: 'req_123456',
          readContentSha256: 'a'.repeat(64),
        },
      ],
    },
  ],
  unconfirmed: [{ statement: '尚未确认启动行为。', reason: 'SOURCE_NOT_READ' }],
  readSources: [],
  agentRounds: [],
  createdAt: '2026-10-14T00:00:00.000Z',
  wrapUp: { reason: 'ROUND_LIMIT' },
};

describe('Chinese report views', () => {
  it('fixes conclusion, source, unconfirmed and wrap-up formatting', () => {
    expect(renderReport(report)).toMatchInlineSnapshot(`
      "分析报告
      已读取文件。
      结论：入口定义明确。
      来源：src/index.ts:1-3
      未确认项：尚未确认启动行为。（来源未被有效读取）
      收尾原因：已达到轮次上限。
      "
    `);
  });

  it('labels a degraded report and keeps the factual summary', () => {
    expect(
      renderReport({
        ...report,
        degraded: true,
        conclusions: [],
        unconfirmed: [],
        wrapUp: { reason: 'BUDGET_EXHAUSTED' },
        summary: '已停止分析；读取了 1 个空文件。',
      }),
    ).toMatchInlineSnapshot(`
        "降级报告
        已停止分析；读取了 1 个空文件。
        收尾原因：模型调用额度已不足。
        "
      `);
  });

  it('renders counts and failure category without internal detail', () => {
    const summary: RunSummary = {
      workflowRunId: report.workflowRunId,
      startedAt: report.createdAt,
      closedAt: report.createdAt,
      durationMs: 120,
      agentRuns: [
        {
          agentRunId: 'agr_123456',
          agentRef: { kind: 'AGENT', id: 'planner', version: 'v0.1.0', digest: 'a'.repeat(64) },
          registeredAt: report.createdAt,
          endedAt: report.createdAt,
          rounds: 2,
        },
      ],
      units: { submitted: 3, ok: 2, rejected: 0, failed: 1, notDelivered: 0 },
      model: { requests: 2, finalCallUsed: false },
      tokens: {
        limit: 100,
        used: 10,
        unknown: 5,
        inputTokens: 7,
        outputTokens: 3,
        finalBudgetState: 'NORMAL',
      },
      closeReason: 'FAILED',
      unknownEffects: [],
      failure: {
        code: 'WORKFLOW_INTERNAL',
        category: 'INTERNAL',
        source: 'WORKFLOW',
        detail: 'secret',
      },
    };
    expect(renderSummary(summary)).toMatchInlineSnapshot(`
      "运行摘要
      代理 planner：2 轮
      操作：提交 3，成功 2，拒绝 0，失败 1，未交付 0
      模型调用：2
      令牌：已使用 10，未知 5，上限 100
      耗时：120 毫秒
      失败分类：内部故障
      分析流程发生内部错误。
      "
    `);
  });

  it('provides Chinese descriptions for every reason and a safe fallback', () => {
    for (const code of REASON_CODES) expect(describeReason(code)).toMatch(/[\u4e00-\u9fff]/u);
    expect(describeReason('unrecognized-secret')).toBe('请求未能完成，请检查运行配置。');
    expect(describeReason('toString')).toBe('请求未能完成，请检查运行配置。');
  });
});
