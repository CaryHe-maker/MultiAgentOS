/**
 * How the part of the conversation that is still drawn in place is laid out in the lines the
 * terminal has to give it (docs/M2/Phase1Console.md 4.3). That part is the tail: the thinking
 * blocks that are still open and what happened from the oldest of them on, in the order it
 * happened. The tail may take 90% of the rows there are; when it would take more, the oldest open
 * block is folded (for good), and when the newest alone is still too tall its beginning is left out
 * and `…` stands for it. Pure: the Ink component draws the lines and tells the store what was folded.
 */
import {
  ConsoleText,
  type ThinkingView,
  type TranscriptRecord,
  type WritingView,
} from '@multiagentos/user-interaction';
import type { TailItem } from './console-store.js';
import { safeCharWidth } from './text-input.js';

export interface ThinkingLine {
  readonly text: string;
  readonly kind: 'HEADER' | 'BODY';
}

/**
 * Text cut into pieces that fit `width` columns by the generous measure (`safeCharWidth`), line
 * breaks kept. A line that has to be cut inside a word of letters is cut before the word when the
 * word fits on a line of its own.
 */
export function wrapLines(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    let current = '';
    let used = 0;
    // Where the last space of `current` is, and how many columns lie before it.
    let space = -1;
    let usedBeforeSpace = 0;
    for (const character of line) {
      const columns = safeCharWidth(character.codePointAt(0) ?? 0);
      if (used + columns > width && current.length > 0) {
        if (space > 0 && character !== ' ') {
          lines.push(current.slice(0, space).trimEnd());
          current = current.slice(space + 1);
          used -= usedBeforeSpace + 1;
        } else {
          lines.push(current);
          current = '';
          used = 0;
          // The space where the line broke is not the first character of the next one.
          if (character === ' ') {
            space = -1;
            continue;
          }
        }
        space = -1;
      }
      if (character === ' ') {
        space = current.length;
        usedBeforeSpace = used;
      }
      current += character;
      used += columns;
    }
    lines.push(current);
  }
  return lines;
}

const seconds = (view: ThinkingView, now: number): string => {
  const end = view.endedAt === undefined ? now : Date.parse(view.endedAt);
  return `${(Math.max(0, end - Date.parse(view.startedAt)) / 1000).toFixed(1)}s`;
};

/** The prefix a record is written with. */
export function prefixOf(record: TranscriptRecord): string {
  return record.kind === 'USER' ? '> ' : record.kind === 'REPLY' ? `${record.agentLabel}: ` : '';
}

/** Columns left unused at the right edge of everything drawn in place. */
export const MARGIN = 2;

/** The share of the rows the tail may take: the rest is slack against a miscount. */
export const TAIL_SHARE = 0.9;

/** The lines a record is drawn as: its prefix and text, cut to fit the screen. */
export function recordLines(record: TranscriptRecord, columns: number): string[] {
  return wrapLines(`${prefixOf(record)}${record.text}`, Math.max(10, columns - MARGIN));
}

/** Screen rows a record takes. */
export function recordRows(record: TranscriptRecord, columns: number): number {
  return recordLines(record, columns).length;
}

/** The lines of the text of a block, as they stand under its header. */
function bodyOf(block: ThinkingView, columns: number): string[] {
  if (block.text.length === 0) return [];
  return wrapLines(block.text.trimEnd(), Math.max(10, columns - MARGIN - 2));
}

/**
 * The header of a block and, under it, the last `bodyLines` lines of its text. When `elided`, the
 * beginning is left out and a line with `…` stands for it.
 */
export function blockLines(
  block: ThinkingView,
  options: {
    readonly now: number;
    readonly columns: number;
    readonly folded: boolean;
    readonly bodyLines: number;
    readonly elided?: boolean;
  },
): ThinkingLine[] {
  const header: ThinkingLine = {
    text: `${options.folded ? '▸' : '▾'} ${ConsoleText.thinkingHeader(block.label, seconds(block, options.now), block.state)}`,
    kind: 'HEADER',
  };
  if (options.folded) return [header];
  const wrapped = bodyOf(block, options.columns);
  const shown = options.bodyLines <= 0 ? [] : wrapped.slice(-options.bodyLines);
  const body = shown.map((text) => ({ text: `  ${text}`, kind: 'BODY' as const }));
  return options.elided === true
    ? [header, { text: '  …', kind: 'BODY' as const }, ...body]
    : [header, ...body];
}

export type PlannedItem =
  | {
      readonly kind: 'RECORD';
      readonly seq: number;
      readonly record: TranscriptRecord;
      readonly lines: readonly string[];
    }
  | {
      readonly kind: 'BLOCK';
      readonly seq: number;
      readonly lines: readonly ThinkingLine[];
    };

export interface TailPlan {
  /** What is drawn: the items of the tail that fit, oldest first. */
  readonly items: readonly PlannedItem[];
  readonly rows: number;
  /**
   * What is older than the first drawn item goes into the scroll-back at once: everything before
   * this sequence number. Undefined when nothing has to go. A frame as tall as the terminal makes
   * the terminal library clear the screen and write everything again, which is not wanted.
   */
  readonly commitBefore: number | undefined;
  /** Blocks to fold for good: the tail was too tall, and these are the oldest that were open. */
  readonly fold: readonly string[];
  /** Blocks drawn with their beginning left out; they are folded when the next block begins. */
  readonly elided: readonly string[];
}

/**
 * The tail in `limit` rows. The records have the rows they need and each open block its header.
 * When the blocks in full would not fit, the oldest open block is folded, then the next, until the
 * rest fits; the newest open block is never folded for size, but is cut to its last lines with `…`
 * for the beginning. A tail whose records alone do not fit keeps the newest items that do and
 * sends the older ones to the scroll-back (`commitBefore`).
 */
export function planTail(
  tail: readonly TailItem[],
  options: {
    readonly now: number;
    readonly columns: number;
    readonly limit: number;
    /** Ctrl+O: every open block shows its header only. */
    readonly folded: boolean;
  },
): TailPlan {
  const least = (item: TailItem): number =>
    item.kind === 'RECORD' ? recordRows(item.record, options.columns) : 1;
  const bodies = new Map<number, string[]>();
  const bodyRows = (item: TailItem): number => {
    if (item.kind !== 'BLOCK' || options.folded) return 0;
    let lines = bodies.get(item.seq);
    if (lines === undefined) {
      lines = bodyOf(item.block, options.columns);
      bodies.set(item.seq, lines);
    }
    return lines.length;
  };
  const fullRows = (items: readonly TailItem[]): number =>
    items.reduce((sum, item) => sum + least(item) + bodyRows(item), 0);

  // The newest items whose least rows fit; what is older is for the scroll-back.
  let fixed = 0;
  let first = tail.length;
  while (first > 0) {
    const item = tail[first - 1];
    if (item === undefined || fixed + least(item) > options.limit) break;
    fixed += least(item);
    first -= 1;
  }
  let kept = tail.slice(first);
  let commitBefore: number | undefined =
    first === 0 ? undefined : (kept[0]?.seq ?? (tail[tail.length - 1]?.seq ?? 0) + 1);

  // Too tall in full: the oldest open block is folded, with what came before the next one.
  const fold: string[] = [];
  const blocksOf = (items: readonly TailItem[]): number[] =>
    items.flatMap((item, index) => (item.kind === 'BLOCK' ? [index] : []));
  while (!options.folded && fullRows(kept) > options.limit) {
    const [oldest, next] = blocksOf(kept);
    const block = oldest === undefined ? undefined : kept[oldest];
    if (next === undefined || block === undefined || block.kind !== 'BLOCK') break;
    fold.push(block.block.id);
    kept = kept.slice(next);
    commitBefore = kept[0]?.seq ?? commitBefore;
  }

  // Still too tall: the newest open block is cut to its last lines.
  const elided: string[] = [];
  const shown = new Map<number, number>();
  const newestIndex = blocksOf(kept).at(-1);
  const newest = newestIndex === undefined ? undefined : kept[newestIndex];
  if (!options.folded && newest?.kind === 'BLOCK' && fullRows(kept) > options.limit) {
    const room = options.limit - (fullRows(kept) - least(newest) - bodyRows(newest));
    // Its header and the `…` line come first; the rest is for its text. With room for the header
    // alone there is no `…` either.
    shown.set(newest.seq, Math.max(0, room - 2));
    if (room >= 2) elided.push(newest.block.id);
  }

  const items: PlannedItem[] = kept.map((item) =>
    item.kind === 'RECORD'
      ? { ...item, lines: recordLines(item.record, options.columns) }
      : {
          kind: 'BLOCK',
          seq: item.seq,
          lines: blockLines(item.block, {
            now: options.now,
            columns: options.columns,
            folded: options.folded,
            bodyLines: shown.get(item.seq) ?? bodyRows(item),
            elided: elided.includes(item.block.id),
          }),
        },
  );
  const rows = items.reduce((sum, item) => sum + item.lines.length, 0);
  return { items, rows, commitBefore, fold, elided };
}

/**
 * The lines of what agents are writing for the user: each block as the message will read
 * (`main: text`), the newest at the bottom, cut to the last `budget` lines so what is being
 * written now is always on screen.
 */
export function layoutWriting(
  blocks: readonly WritingView[],
  options: { readonly columns: number; readonly budget: number },
): string[] {
  const lines = blocks.flatMap((block) =>
    wrapLines(`${block.label}: ${block.text}`.trimEnd(), Math.max(10, options.columns - MARGIN)),
  );
  return options.budget <= 0 ? [] : lines.slice(-options.budget);
}
