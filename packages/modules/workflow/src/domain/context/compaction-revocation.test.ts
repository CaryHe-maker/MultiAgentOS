import type { SessionLogRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { revokedCompactions } from './compaction-revocation.js';

const workflowRunId = 'wfr_01ABCDEFGHJKMNPQRSTVWXYZ00';
const compacted = (compactionId: string, fromSeq: number, toSeq: number) =>
  ({
    seq: toSeq + 1,
    type: 'CONTEXT_COMPACTED',
    compactionId,
    fromSeq,
    toSeq,
  }) as unknown as SessionLogRecord;

describe('the summaries a rollback takes back (Module/Workflow 8.4, Orchestration 7.5)', () => {
  it('revokes a summary whose range overlaps what was taken back, once', () => {
    const records = [compacted('cmp_early', 1, 9), compacted('cmp_late', 20, 29)];
    expect(
      revokedCompactions(records, workflowRunId, { from: 25, to: 40 }).map((record) =>
        'compactionId' in record ? record.compactionId : '',
      ),
    ).toEqual(['cmp_late']);
    const revoked = [
      ...records,
      {
        seq: 41,
        type: 'CONTEXT_COMPACTION_REVOKED',
        compactionId: 'cmp_late',
      } as unknown as SessionLogRecord,
    ];
    expect(revokedCompactions(revoked, workflowRunId, { from: 25, to: 40 })).toEqual([]);
    expect(revokedCompactions(records, workflowRunId, { from: 10, to: 20 })).toEqual([]);
  });
});
