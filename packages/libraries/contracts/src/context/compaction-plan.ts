import type { ArtifactRef } from '../platform-common/common-schemas.js';
import type { ContextHistoryEntry } from './history-entry.js';

/**
 * Which part of a projection a compaction touches (M2Design 9.6, Kernel/Core 6a): a pure function
 * of the entries Workflow handed over and of the configuration, so Core, its tests and a replay
 * agree. Kernel has no bodies, only the sizes of the artifacts the entries point to, so tokens are
 * counted from bytes here; what decides whether to compact at all is the measured figure.
 *
 * What is kept as it is: the newest part of the history, from the start of a whole model turn
 * (`keepTokens`, which the caller takes as `keepRatio` of the limit); the PINNED entries; and the newest user messages up to `keepHumanBytes`
 * together, none of them longer than half of that. Everything else NORMAL before the newest part
 * is what the summary takes the place of; the big tool results among them are cut first.
 */
export interface CompactionPlanConfig {
  readonly keepTokens: number;
  readonly keepHumanBytes: number;
  readonly pruneMinBytes: number;
  /**
   * A summary that takes the place of less than this is not worth its own cost (it is about
   * `summaryMaxTokens` long): a range that replaces less is not made.
   */
  readonly minReplacedTokens: number;
}

/** What a character of this kind of text costs: measured at 0.34 token per byte, with room. */
const TOKENS_PER_BYTE = 0.4;
/** What an entry costs apart from its text: role marks, the id line, separators. */
const ENTRY_OVERHEAD_BYTES = 24;

const sizeOf = (ref: ArtifactRef | undefined): number => ref?.size ?? 0;
const textSize = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The bytes an entry adds to a request, as far as the entry tells. */
export function entryBytes(entry: ContextHistoryEntry): number {
  switch (entry.kind) {
    case 'HUMAN':
    case 'HUMAN_ANSWER':
    case 'SUMMARY':
      return sizeOf(entry.contentRef) + ENTRY_OVERHEAD_BYTES;
    case 'MODEL_TURN':
      return (
        sizeOf(entry.outputRef) +
        (entry.replayable ? sizeOf(entry.reasoningRef) : 0) +
        ENTRY_OVERHEAD_BYTES
      );
    case 'TOOL_RESULT':
      return sizeOf(entry.outputRef) + ENTRY_OVERHEAD_BYTES;
    case 'MESSAGE':
    case 'PLAN':
      return sizeOf(entry.outputRef) + ENTRY_OVERHEAD_BYTES;
    case 'PROJECT_INSTRUCTIONS':
      return sizeOf(entry.ref) + ENTRY_OVERHEAD_BYTES;
    case 'FEEDBACK':
    case 'NOTE':
      return textSize(entry.text) + ENTRY_OVERHEAD_BYTES;
    case 'TASK':
      return (
        textSize(entry.goal) +
        entry.acceptance.reduce((total, line) => total + textSize(line), 0) +
        ENTRY_OVERHEAD_BYTES
      );
    case 'SUBAGENT_RESULT':
      return (
        sizeOf(entry.outputRef) +
        entry.notes.reduce((total, line) => total + textSize(line), 0) +
        (entry.references ?? []).reduce(
          (total, each) => total + textSize(each.toolCallId) + textSize(each.tool),
          0,
        ) +
        ENTRY_OVERHEAD_BYTES
      );
  }
}

export const entryTokens = (entry: ContextHistoryEntry): number =>
  Math.ceil(entryBytes(entry) * TOKENS_PER_BYTE);

/** The span of log records an entry stands for: a summary stands for all it replaced. */
export const spanOf = (entry: ContextHistoryEntry): { from: number; to: number } =>
  entry.kind === 'SUMMARY'
    ? { from: entry.fromSeq, to: entry.toSeq }
    : { from: entry.seq, to: entry.seq };

/** One tool result that may be cut. */
export interface PruneCandidate {
  readonly requestId: string;
  readonly toolCallId: string;
  /** The preview the model sees now. */
  readonly previewRef: ArtifactRef;
  /** Set when the output was cut before: `read_output` then reads the full output. */
  readonly fullRef?: ArtifactRef;
}

export interface CompactionRange {
  readonly fromSeq: number;
  readonly toSeq: number;
  /** The entries of the range that stay: PINNED ones, and the user messages chosen to stay. */
  readonly keptSeqs: readonly number[];
  /** How many entries the summary takes the place of, and the work of how many inputs. */
  readonly replacedEntries: number;
  readonly replacedInputs: number;
}

export interface CompactionPlan {
  /** Index of the first entry of the newest part, which nothing touches. */
  readonly keepFrom: number;
  readonly prunable: readonly PruneCandidate[];
  /** Absent when there is nothing a summary could take the place of. */
  readonly range?: CompactionRange;
}

const NOTHING: CompactionPlan = { keepFrom: 0, prunable: [] };

export function planCompaction(
  entries: readonly ContextHistoryEntry[],
  config: CompactionPlanConfig,
): CompactionPlan {
  // The newest part starts at the start of a whole model turn, so that no call is parted from its
  // result; when the whole history is smaller than it, there is nothing old enough to compact.
  let keepFrom: number | undefined;
  let sum = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    sum += entryTokens(entry);
    if (entry.kind === 'MODEL_TURN' && sum >= config.keepTokens) {
      keepFrom = index;
      break;
    }
  }
  if (keepFrom === undefined || keepFrom === 0) return NOTHING;

  const older = entries.slice(0, keepFrom);
  const newest = entries.slice(keepFrom);

  const prunable = older.flatMap((entry): PruneCandidate[] =>
    entry.kind === 'TOOL_RESULT' &&
    entry.category === 'NORMAL' &&
    entry.prunedAt === undefined &&
    entry.outputRef !== undefined &&
    entry.outputRef.size > config.pruneMinBytes &&
    entry.requestId !== undefined
      ? [
          {
            requestId: entry.requestId,
            toolCallId: entry.toolCallId,
            previewRef: entry.outputRef,
            ...(entry.fullRef === undefined ? {} : { fullRef: entry.fullRef }),
          },
        ]
      : [],
  );

  const replaceable = older.filter((entry) => entry.category === 'NORMAL');
  if (replaceable.length === 0) return { keepFrom, prunable };

  // The range is an interval of the log. The newest part has to lie outside it: a note that was
  // added late carries an early `seq`, so the interval stops before the lowest `seq` of the part.
  const fromSeq = replaceable.reduce((low, entry) => Math.min(low, spanOf(entry).from), Infinity);
  const newestFrom = newest.reduce((low, entry) => Math.min(low, spanOf(entry).from), Infinity);
  const toSeq = Math.min(
    older.reduce((high, entry) => Math.max(high, spanOf(entry).to), 0),
    newestFrom - 1,
  );
  const inRange = (entry: ContextHistoryEntry) =>
    spanOf(entry).from >= fromSeq && spanOf(entry).to <= toSeq;

  const kept = new Set<number>();
  for (const entry of older) if (inRange(entry) && entry.category === 'PINNED') kept.add(entry.seq);
  // The newest user messages stay, within the budget, and none that is too long to be worth it.
  let humanBytes = 0;
  for (const entry of [...older].reverse()) {
    if (entry.kind !== 'HUMAN' || entry.category !== 'NORMAL' || !inRange(entry)) continue;
    const size = sizeOf(entry.contentRef);
    if (size > config.keepHumanBytes / 2 || humanBytes + size > config.keepHumanBytes) continue;
    humanBytes += size;
    kept.add(entry.seq);
  }

  const replaced = older.filter(
    (entry) => inRange(entry) && (entry.kind === 'SUMMARY' || !kept.has(entry.seq)),
  );
  const replacedTokens = replaced.reduce((total, entry) => total + entryTokens(entry), 0);
  // An earlier summary alone is not a range: a summary of a summary says nothing that is new.
  if (
    replaced.every((entry) => entry.kind === 'SUMMARY') ||
    replacedTokens < config.minReplacedTokens
  )
    return { keepFrom, prunable };
  // The inputs of the user whose work it replaces, in part or whole: each input's own entry counts.
  const inputs = replaced.filter((entry) => entry.kind === 'HUMAN').length;
  return {
    keepFrom,
    prunable,
    range: {
      fromSeq,
      toSeq,
      keptSeqs: [...kept].sort((a, b) => a - b),
      replacedEntries: replaced.length,
      replacedInputs: inputs,
    },
  };
}
