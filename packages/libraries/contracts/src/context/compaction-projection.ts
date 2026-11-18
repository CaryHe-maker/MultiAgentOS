import type { SessionLogRecord } from '../platform-persistence/session-log.js';
import { spanOf } from './compaction-plan.js';
import type { PrunedItem } from './compaction.js';
import type { ContextHistoryEntry } from './history-entry.js';

/**
 * What a compaction does to a projection (M2Design 9.6, Module/Workflow 8.4): a pure function of
 * the records, so a replayed log gives the same context and the projection stays a function of
 * the log alone (invariant 7). Kernel decided what goes where; nothing here decides again, and
 * nothing depends on the configuration that was in force.
 *
 * - A pruned result shows the cut text from the record on, in the same place.
 * - A summary takes the place of everything in `[fromSeq, toSeq]` that is not in `keptSeqs`, at
 *   the place of the first entry it replaces. The entries that are kept follow it, in their own
 *   order. `keptSeqs` holds the PINNED entries of the range as they were when it was written, so
 *   the work of an input that is no longer the latest cannot lose its prompt afterwards.
 * - A summary that was revoked (what it covered was taken back) replaces nothing; a prune stays.
 * - A later compaction may take an earlier summary into its range.
 */
export interface CompactionRecords {
  readonly pruned: Extract<SessionLogRecord, { type: 'TOOL_RESULTS_PRUNED' }>[];
  readonly compacted: Extract<SessionLogRecord, { type: 'CONTEXT_COMPACTED' }>[];
  readonly revoked: Set<string>;
}

type Compacted = CompactionRecords['compacted'][number];

/** What a cut needs of its record: where it stands in the log, and what it cut. */
export interface PruneRecord {
  readonly seq: number;
  readonly items: readonly PrunedItem[];
}

/** What a prune record does to a list of entries; the plan of a compaction reads it too. */
export function prune(
  entries: readonly ContextHistoryEntry[],
  records: readonly PruneRecord[],
): ContextHistoryEntry[] {
  if (records.length === 0) return [...entries];
  const cut = new Map<string, { item: PrunedItem; at: number }>();
  for (const record of records)
    for (const item of record.items) cut.set(item.toolCallId, { item, at: record.seq });
  return entries.map((entry) => {
    if (entry.kind !== 'TOOL_RESULT') return entry;
    const found = cut.get(entry.toolCallId);
    return found === undefined
      ? entry
      : { ...entry, outputRef: found.item.prunedRef, prunedAt: found.at };
  });
}

function replace(
  entries: readonly ContextHistoryEntry[],
  compacted: Compacted,
): ContextHistoryEntry[] {
  const kept = new Set(compacted.keptSeqs);
  const inRange = (entry: ContextHistoryEntry) => {
    const { from, to } = spanOf(entry);
    return from >= compacted.fromSeq && to <= compacted.toSeq;
  };
  const stays = (entry: ContextHistoryEntry) => entry.kind !== 'SUMMARY' && kept.has(entry.seq);
  const out: ContextHistoryEntry[] = [];
  const staying: ContextHistoryEntry[] = [];
  let at: number | undefined;
  for (const entry of entries) {
    if (!inRange(entry)) out.push(entry);
    else if (stays(entry)) staying.push(entry);
    else at ??= out.length;
  }
  // Nothing in the range was replaced: the record changes nothing.
  if (at === undefined) return [...entries];
  const summary: ContextHistoryEntry = {
    seq: compacted.seq,
    category: 'NORMAL',
    kind: 'SUMMARY',
    compactionId: compacted.compactionId,
    fromSeq: compacted.fromSeq,
    toSeq: compacted.toSeq,
    contentRef: compacted.summaryRef,
  };
  out.splice(at, 0, summary, ...staying);
  return out;
}

export function applyCompactions(
  entries: readonly ContextHistoryEntry[],
  records: CompactionRecords,
): readonly ContextHistoryEntry[] {
  let shown = prune(entries, records.pruned);
  for (const compacted of records.compacted)
    if (!records.revoked.has(compacted.compactionId)) shown = replace(shown, compacted);
  return shown;
}
