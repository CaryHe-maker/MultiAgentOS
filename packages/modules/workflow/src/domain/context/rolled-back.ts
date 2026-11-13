import type { SessionLogRecord } from '@multiagentos/contracts';

/** A stretch of the log that a rollback took back: from `from` up to the rollback (`to`). */
export interface RolledBackRange {
  readonly from: number;
  readonly to: number;
}

/**
 * What every way back took back (Orchestration 7.5, D8): an undo and a rewind alike leave a
 * `ROLLED_BACK` record, and what lies in its range stands for nothing any more. The log keeps it.
 */
export function rolledBackRanges(records: readonly SessionLogRecord[]): readonly RolledBackRange[] {
  return records.flatMap((record) =>
    record.type === 'ROLLED_BACK' ? [{ from: record.fromSeq, to: record.seq }] : [],
  );
}

export const isRolledBack = (seq: number, ranges: readonly RolledBackRange[]): boolean =>
  ranges.some((range) => seq >= range.from && seq < range.to);
