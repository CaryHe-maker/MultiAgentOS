import type { ReportLastIssue, AnalysisReport } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { REASON_CODES } from '@multiagentos/contracts';
import { describeReason } from './interaction-messages.js';
import { renderReport } from './report-view.js';

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
    expect(text).toContain('中文 English 🙂\n  第二行\\u001b[2J\\u000d\\u0008\\u0009');
    expect(text).toContain('\\u0000\\u007f\\u009b31m');
    expect(text).toContain('结论\\u001b[31m');
    expect(text).toContain('src/\\u001b[2J.ts');
    expect(text).toContain('待确认\\u0008');
    expectNoTerminalControls(text);
    expect(input).toEqual(original);
  });

  it('fixes the answer, conclusion, source, unconfirmed and wrap-up layout', () => {
    expect(renderReport(report)).toMatchInlineSnapshot(`
      "分析报告

      回答
        已读取文件。

      结论
        1. 入口定义明确。
           来源：src/index.ts 第 1–3 行

      未查证的问题
        1. 尚未确认启动行为。
           （引用的代码没有被实际读取，系统未采纳为结论）

      收尾原因：已达到轮次上限。
      "
    `);
  });

  it('numbers entries and aligns multi-line text and further sources under them', () => {
    const source = report.conclusions[0]!.sources[0]!;
    const withoutWrapUp = structuredClone(report);
    Reflect.deleteProperty(withoutWrapUp, 'wrapUp');
    const text = renderReport({
      ...withoutWrapUp,
      summary: '第一行\n第二行',
      conclusions: [
        {
          statement: '甲',
          sources: [source, { ...source, path: 'b.ts', startLine: 7, endLine: 7 }],
        },
        { statement: '乙\n续行', sources: [source] },
      ],
      unconfirmed: [
        { statement: '丙', reason: 'MODEL_UNCONFIRMED' },
        { statement: '丁', reason: 'NO_SOURCE' },
      ],
    });
    expect(text).toMatchInlineSnapshot(`
      "分析报告

      回答
        第一行
        第二行

      结论
        1. 甲
           来源：src/index.ts 第 1–3 行
                 b.ts 第 7 行
        2. 乙
           续行
           来源：src/index.ts 第 1–3 行

      未查证的问题
        1. 丙
           （模型提出、但没有查证）
        2. 丁
           （模型没有给出来源，系统未采纳为结论）

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

  it('provides Chinese descriptions for every reason and a safe fallback', () => {
    for (const code of REASON_CODES) expect(describeReason(code)).toMatch(/[\u4e00-\u9fff]/u);
    expect(describeReason('unrecognized-secret')).toBe('请求未能完成，请检查运行配置。');
    expect(describeReason('toString')).toBe('请求未能完成，请检查运行配置。');
  });
});
