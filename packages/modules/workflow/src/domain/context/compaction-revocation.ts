import type { SessionLogRecord } from '@multiagentos/contracts';
import type { NewLogRecord } from '../../session/session-log-store.js';

/**
 * The summaries that stand for work of Turns that were undone (Module/Workflow 8.4): a summary is
 * revoked when any record of its range belongs to a reverted Turn, so the entries it replaced
 * come back (the reverted ones are removed by the revert itself), and a later compaction can
 * summarise again. A cut result is not given back: it was only made shorter.
 */
export function revokedCompactions(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
  revertedTurnIds: readonly string[],
): NewLogRecord[] {
  const reverted = new Set(revertedTurnIds);
  const revoked = new Set<string>();
  for (const record of records)
    if (record.type === 'CONTEXT_COMPACTION_REVOKED') revoked.add(record.compactionId);
  return records.flatMap((record): NewLogRecord[] => {
    if (record.type !== 'CONTEXT_COMPACTED' || revoked.has(record.compactionId)) return [];
    const touched = records.some(
      (other) =>
        other.seq >= record.fromSeq &&
        other.seq <= record.toSeq &&
        'turnId' in other &&
        other.turnId !== undefined &&
        reverted.has(other.turnId),
    );
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
