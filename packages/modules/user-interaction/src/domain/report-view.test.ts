import type { ReportLastIssue, AnalysisReport, RunSummary } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { REASON_CODES } from '@multiagentos/contracts';
import { describeReason } from './interaction-messages.js';
import { renderQuestion, renderReport, renderSummary } from './report-view.js';

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

function expectNoTerminalControls(text: string): void {
  expect(
    [...text].filter((character) => {
      const code = character.charCodeAt(0);
      return code !== 10 && (code < 32 || (code >= 127 && code <= 159));
    }),
  ).toEqual([]);
}

describe('Chinese report views', () => {
  it('escapes terminal controls while preserving Chinese, Unicode and line breaks', () => {
    const input: AnalysisReport = {
      ...report,
      summary: '中文 English 🙂\n第二行\u001b[2J\r\b\t\u0000\u007f\u009b31m',
      conclusions: [
        {
          statement: '结论\u001b[31m',
          sources: [{ ...report.conclusions[0]!.sources[0]!, path: 'src/\u001b[2J.ts' }],
        },
      ],
      unconfirmed: [{ statement: '待确认\b', reason: 'MODEL_UNCONFIRMED' }],
    };
    const original = structuredClone(input);
    const text = renderReport(input);
    expect(text).toContain('中文 English 🙂\n第二行\\u001b[2J\\u000d\\u0008\\u0009');
    expect(text).toContain('\\u0000\\u007f\\u009b31m');
    expect(text).toContain('结论\\u001b[31m');
    expect(text).toContain('src/\\u001b[2J.ts');
    expect(text).toContain('待确认\\u0008');
    expectNoTerminalControls(text);
    expect(input).toEqual(original);
  });

  it('escapes terminal controls in authorization metadata without changing its values', () => {
    const question = {
      type: 'AuthorizationRequest' as const,
      questionId: 'qst_123456',
      capability: 'repo.read' as const,
      repositoryPath: '/仓库\u001b[2J',
      exclusions: ['目录\r覆盖'],
      provider: '服务商\u009b31m',
      expiresAt: '2026-10-14T00:01:00.000Z',
    };
    const original = structuredClone(question);
    const text = renderQuestion(question);
    expect(text).toContain('/仓库\\u001b[2J');
    expect(text).toContain('目录\\u000d覆盖');
    expect(text).toContain('服务商\\u009b31m');
    expectNoTerminalControls(text);
    expect(question).toEqual(original);
  });

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

  it('describes a degraded report from wrapUp instead of its placeholder summary', () => {
    expect(
      renderReport({
        ...report,
        degraded: true,
        conclusions: [],
        unconfirmed: [],
        wrapUp: { reason: 'BUDGET_EXHAUSTED' },
        summary: 'Degraded report: placeholder that is never shown.',
      }),
    ).toMatchInlineSnapshot(`
        "降级报告
        本次分析的额度已不足以继续调用模型，未形成可发布的分析结论。
        "
      `);
  });

  it('describes the last issue and empty files from the report fields', () => {
    const degraded = (lastIssue: ReportLastIssue): AnalysisReport => ({
      ...report,
      degraded: true,
      conclusions: [],
      unconfirmed: [],
      wrapUp: { reason: 'ROUND_LIMIT', lastIssue },
    });
    const failed = renderReport({
      ...degraded({ kind: 'FAILURE', code: 'UNIT_TIMEOUT' }),
      emptyReads: ['a.txt', 'b.txt'],
    });
    expect(failed).toContain('最后一次操作失败');
    expect(failed).toContain('2 个空文件');
    expect(renderReport(degraded({ kind: 'INVALID_OUTPUT', reason: 'CONTROL_MIXED' }))).toContain(
      '混合返回',
    );
    expect(renderReport(degraded({ kind: 'NO_FINISH' }))).toContain('没有返回合法的结束结果');
    expect(renderReport({ ...report, emptyReads: ['a.txt'] })).toContain('1 个空文件');
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
