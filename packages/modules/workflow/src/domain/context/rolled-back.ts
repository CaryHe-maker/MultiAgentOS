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

/**
 * What the rewinds took back (Orchestration 7.5): the state of the work, its graph and its tasks, is
 * the one at the cut, as if what came after had not happened. An undo is not among them: it takes
 * back what the user said in a chat, and the chat goes on from the request it waits on.
 */
export function rewoundRanges(records: readonly SessionLogRecord[]): readonly RolledBackRange[] {
  return records.flatMap((record) =>
    record.type === 'ROLLED_BACK' && record.undo !== true
      ? [{ from: record.fromSeq, to: record.seq }]
      : [],
  );
}

export const isRolledBack = (seq: number, ranges: readonly RolledBackRange[]): boolean =>
  ranges.some((range) => seq >= range.from && seq < range.to);
