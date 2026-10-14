import { AnalysisReportSchema, newId, validate } from '@multiagentos/contracts';
import type { AnalysisReportDraft } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { createNormalReport } from './normal-report.js';
import type { NormalReportInput } from './normal-report.js';
import { reportSources, withEmptyFileNotice } from './report-sources.js';

const read = {
  requestId: newId('req'),
  output: {
    path: 'src/cache.ts',
    startLine: 10,
    endLine: 30,
    totalLines: 40,
    contentSha256: 'a'.repeat(64),
    fileSha256: 'b'.repeat(64),
  },
};
const empty = {
  requestId: newId('req'),
  output: { ...read.output, path: 'empty.ts', startLine: 1, endLine: 0, totalLines: 0 },
};
const draft: AnalysisReportDraft = {
  summary: '缓存分析',
  conclusions: [
    {
      statement: '缓存缺少失效处理',
      sources: [{ path: read.output.path, startLine: 15, endLine: 20 }],
    },
  ],
  unconfirmed: [],
};
const facts: NormalReportInput = {
  workflowRunId: newId('wfr'),
  goal: '分析缓存',
  draft,
  reads: [read],
  agentRounds: [],
  createdAt: '2026-10-14T00:00:00.000Z',
};

describe('normal report and source verification', () => {
  it('uses the first received covering read for each verified source', () => {
    const later = {
      ...read,
      requestId: newId('req'),
      output: { ...read.output, contentSha256: 'c'.repeat(64) },
    };
    const report = createNormalReport({ ...facts, reads: [read, later] });
    expect(validate(AnalysisReportSchema, report).ok).toBe(true);
    expect(report.conclusions[0]?.sources[0]).toMatchObject({
      readRequestId: read.requestId,
      readContentSha256: read.output.contentSha256,
    });
    expect(report.readSources).toHaveLength(2);
  });

  it('downgrades a whole conclusion when even one source was not covered', () => {
    const conclusion = draft.conclusions[0];
    if (conclusion === undefined) throw new Error('Missing conclusion fixture');
    const report = createNormalReport({
      ...facts,
      draft: {
        ...draft,
        conclusions: [
          {
            ...conclusion,
            sources: [...conclusion.sources, { path: 'other.ts', startLine: 1, endLine: 1 }],
          },
        ],
      },
    });
    expect(report.conclusions).toEqual([]);
    expect(report.unconfirmed).toEqual([
      { statement: conclusion.statement, reason: 'SOURCE_NOT_READ' },
    ]);
  });

  it('does not combine adjacent reads to claim coverage', () => {
    const report = createNormalReport({
      ...facts,
      reads: [
        { ...read, output: { ...read.output, endLine: 17 } },
        { ...read, requestId: newId('req'), output: { ...read.output, startLine: 18 } },
      ],
    });
    expect(report.conclusions).toEqual([]);
    expect(report.unconfirmed[0]?.reason).toBe('SOURCE_NOT_READ');
  });

  it('preserves all three reasons for unconfirmed statements without any reads', () => {
    const report = createNormalReport({
      ...facts,
      reads: [],
      draft: {
        summary: '初步分析',
        conclusions: [{ statement: '没有来源', sources: [] }, ...draft.conclusions],
        unconfirmed: ['仍需确认'],
      },
    });
    expect(report.unconfirmed.map((item) => item.reason)).toEqual([
      'NO_SOURCE',
      'SOURCE_NOT_READ',
      'MODEL_UNCONFIRMED',
    ]);
    expect(validate(AnalysisReportSchema, report).ok).toBe(true);
  });

  it('keeps empty reads private and cannot use a nonexistent first line as evidence', () => {
    const report = createNormalReport({
      ...facts,
      reads: [read, empty, { ...empty, requestId: newId('req') }],
      draft: {
        ...draft,
        conclusions: [
          ...draft.conclusions,
          {
            statement: '空文件第一行的结论',
            sources: [{ path: 'empty.ts', startLine: 1, endLine: 1 }],
          },
        ],
      },
    });
    expect(report.summary).toContain('1 个空文件');
    expect(report.readSources).toHaveLength(1);
    expect(report.conclusions).toHaveLength(1);
    expect(report.unconfirmed[0]?.reason).toBe('SOURCE_NOT_READ');
    expect(validate(AnalysisReportSchema, report).ok).toBe(true);
    expect(empty.output.endLine).toBe(0);
    expect(reportSources([empty]).readSources).toEqual([]);
  });

  it('keeps wrap-up and snapshot metadata without changing report shape', () => {
    const report = createNormalReport({
      ...facts,
      wrapUpReason: 'ROUND_LIMIT',
      snapshotId: `snp_${'a'.repeat(64)}`,
    });
    expect(report.degraded).toBe(false);
    expect(report.wrapUp?.reason).toBe('ROUND_LIMIT');
    expect(report.snapshotId).toBe(`snp_${'a'.repeat(64)}`);
    expect(validate(AnalysisReportSchema, report).ok).toBe(true);
  });

  it('reserves space for the notice when the model already filled the summary limit', () => {
    const report = createNormalReport({
      ...facts,
      reads: [empty],
      draft: { summary: '文'.repeat(4000), conclusions: [], unconfirmed: [] },
    });
    expect(report.summary.length).toBeLessThanOrEqual(4000);
    expect(report.summary).toContain('… 本次另成功读取了 1 个空文件');
    expect(validate(AnalysisReportSchema, report).ok).toBe(true);
    expect(withEmptyFileNotice('内容', 0)).toBe('内容');
  });
});
