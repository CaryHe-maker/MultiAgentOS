import type { SessionLogRecord } from '../platform-persistence/session-log.js';
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
 *   a Turn that is no longer the current one cannot lose its prompt afterwards.
 * - A summary that was revoked (its Turns were undone) replaces nothing; a prune stays.
 * - A later compaction may take an earlier summary into its range.
 */
export interface CompactionRecords {
  readonly pruned: Extract<SessionLogRecord, { type: 'TOOL_RESULTS_PRUNED' }>[];
  readonly compacted: Extract<SessionLogRecord, { type: 'CONTEXT_COMPACTED' }>[];
  readonly revoked: Set<string>;
}

type Compacted = CompactionRecords['compacted'][number];

/** Where an entry stands in the log; a summary stands where the entries it replaced stood. */
const spanOf = (entry: ContextHistoryEntry): { from: number; to: number } =>
  entry.kind === 'SUMMARY'
    ? { from: entry.fromSeq, to: entry.toSeq }
    : { from: entry.seq, to: entry.seq };

/** What a prune record does to a list of entries; the plan of a compaction reads it too. */
export function prune(
  entries: readonly ContextHistoryEntry[],
  records: CompactionRecords['pruned'],
): ContextHistoryEntry[] {
  if (records.length === 0) return [...entries];
  const cut = new Map<string, (typeof records)[number]['items'][number]>();
  for (const record of records) for (const item of record.items) cut.set(item.toolCallId, item);
  return entries.map((entry) => {
    if (entry.kind !== 'TOOL_RESULT') return entry;
    const item = cut.get(entry.toolCallId);
    return item === undefined ? entry : { ...entry, outputRef: item.prunedRef, pruned: true };
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
