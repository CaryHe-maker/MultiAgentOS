import type { AnalysisReportDraft, SessionLogRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { analysisFacts, degradedReportBody, normalReportBody } from './analysis-report.js';

const run = 'wfr_01ABCDEFGH';
const digest = 'a'.repeat(64);
const output = (path: string, totalLines: number) => ({
  path,
  startLine: 1,
  endLine: totalLines,
  totalLines,
  contentSha256: 'b'.repeat(64),
  fileSha256: 'c'.repeat(64),
});
const budget = { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' };
const pair = (requestId: string, unit: string, result: object): object[] => [
  { type: 'UNIT_SUBMITTED', workflowRunId: run, requestId, unitRef: { id: unit, digest } },
  { type: 'UNIT_COMPLETED', workflowRunId: run, requestId, status: 'OK', budget, output: result },
];
const records = [
  ...pair('req_read', 'file-read', output('a.ts', 10)),
  ...pair('req_empty', 'file-read', { ...output('e.ts', 0), startLine: 1, endLine: 0 }),
  ...pair('req_orient', 'repository-orient', { snapshotId: 'snp_1' }),
  ...pair('req_search', 'repository-search', {}),
] as unknown as SessionLogRecord[];
const facts = analysisFacts(records, run);
const base = { workflowRunId: run, facts, agentRounds: [], createdAt: '2026-10-31T00:00:00.000Z' };
const draft = (conclusions: AnalysisReportDraft['conclusions']): AnalysisReportDraft => ({
  summary: 'summary',
  conclusions,
  unconfirmed: ['maybe'],
});

describe('analysisFacts', () => {
  it('reads the file reads and the snapshot of this run from the log', () => {
    expect(facts.reads.map((read) => read.requestId)).toEqual(['req_read', 'req_empty']);
    expect(facts.snapshotId).toBe('snp_1');
    expect(analysisFacts(records, 'wfr_01OTHERRUN').reads).toEqual([]);
  });
});

describe('normalReportBody', () => {
  it('keeps verified conclusions and sorts out the rest', () => {
    const body = normalReportBody({
      ...base,
      draft: draft([
        { statement: 'read', sources: [{ path: 'a.ts', startLine: 2, endLine: 3 }] },
        { statement: 'beyond', sources: [{ path: 'a.ts', startLine: 2, endLine: 30 }] },
        { statement: 'none', sources: [] },
      ]),
    });
    expect(body['conclusions']).toMatchObject([
      { statement: 'read', sources: [{ readRequestId: 'req_read' }] },
    ]);
    expect(body['unconfirmed']).toEqual([
      { statement: 'beyond', reason: 'SOURCE_NOT_READ' },
      { statement: 'none', reason: 'NO_SOURCE' },
      { statement: 'maybe', reason: 'MODEL_UNCONFIRMED' },
    ]);
  });

  it('lists sources and empty reads, and never the goal', () => {
    const body = normalReportBody({ ...base, draft: draft([]) });
    expect(body).toMatchObject({ emptyReads: ['e.ts'], snapshotId: 'snp_1', degraded: false });
    expect(body['readSources']).toHaveLength(1);
    expect(body).not.toHaveProperty('goal');
  });

  it('notes an early wrap-up', () => {
    const body = normalReportBody({ ...base, draft: draft([]), wrapUpReason: 'ROUND_LIMIT' });
    expect(body['wrapUp']).toEqual({ reason: 'ROUND_LIMIT' });
  });
});

describe('degradedReportBody', () => {
  it('states the reason and no conclusions', () => {
    expect(degradedReportBody({ ...base, reason: 'BUDGET_EXHAUSTED' })).toMatchObject({
      degraded: true,
      wrapUp: { reason: 'BUDGET_EXHAUSTED' },
      conclusions: [],
      unconfirmed: [],
    });
  });
});
