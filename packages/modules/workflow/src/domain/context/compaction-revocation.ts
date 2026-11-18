import type { SessionLogRecord } from '@multiagentos/contracts';
import type { NewLogRecord } from '../../session/session-log-store.js';

/**
 * The summaries that stand for work that was taken back (Module/Workflow 8.4, Orchestration 7.5):
 * a summary is revoked when its range overlaps what a rollback took back, so the entries it
 * replaced come back (the taken-back ones stay hidden), and a later compaction can summarise
 * again. A cut result is not given back: it was only made shorter.
 */
export function revokedCompactions(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
  taken: { readonly from: number; readonly to: number },
): NewLogRecord[] {
  const revoked = new Set<string>();
  for (const record of records)
    if (record.type === 'CONTEXT_COMPACTION_REVOKED') revoked.add(record.compactionId);
  return records.flatMap((record): NewLogRecord[] => {
    if (record.type !== 'CONTEXT_COMPACTED' || revoked.has(record.compactionId)) return [];
    // Its range overlaps what was taken back.
    const touched = record.fromSeq < taken.to && record.toSeq >= taken.from;
    return touched
      ? [
          {
            type: 'CONTEXT_COMPACTION_REVOKED',
            workflowRunId,
            compactionId: record.compactionId,
            reason: 'TURN_REVERTED',
          },
        ]
      : [];
  });
}
