/**
 * How the part of the conversation that is still drawn in place is laid out in the lines the
 * terminal has to give it (docs/M2/Phase1Console.md 4.3). The tail holds the latest two blocks of
 * thinking and what happened between and after them, in the order it happened; the records have
 * the room they need, every block its header, and what is left goes to the tail of the newest
 * blocks first, so what the model is thinking now is always on screen. A folded block (Ctrl+O) is
 * its header only. Pure: the Ink component draws the lines.
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
  /** Streaming right now, for the header's colour. */
  readonly live: boolean;
}

/**
 * Text cut into pieces that fit `width` columns by the generous measure (`safeCharWidth`), line
 * breaks kept.
 */
export function wrapLines(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    let current = '';
    let used = 0;
    for (const character of line) {
      const columns = safeCharWidth(character.codePointAt(0) ?? 0);
      if (used + columns > width && current.length > 0) {
        lines.push(current);
        current = '';
        used = 0;
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

/** The lines a record is drawn as: its prefix and text, cut to fit the screen. */
export function recordLines(record: TranscriptRecord, columns: number): string[] {
  return wrapLines(`${prefixOf(record)}${record.text}`, Math.max(10, columns - MARGIN));
}

/** Screen rows a record takes. */
export function recordRows(record: TranscriptRecord, columns: number): number {
  return recordLines(record, columns).length;
}

/** The header of a block, and the last `bodyLines` lines of its text under it. */
export function blockLines(
  block: ThinkingView,
  options: {
    readonly now: number;
    readonly columns: number;
    readonly folded: boolean;
    readonly bodyLines: number;
  },
): ThinkingLine[] {
  const header: ThinkingLine = {
    text: `${options.folded ? '▸' : '▾'} ${ConsoleText.thinkingHeader(block.label, seconds(block, options.now), block.state)}`,
    kind: 'HEADER',
    live: block.state === 'OPEN',
  };
  if (options.folded || block.text.length === 0 || options.bodyLines <= 0) return [header];
  const wrapped = wrapLines(block.text.trimEnd(), Math.max(10, options.columns - MARGIN - 2));
  return [
    header,
    ...wrapped
      .slice(-options.bodyLines)
      .map((text) => ({ text: `  ${text}`, kind: 'BODY' as const, live: false })),
  ];
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
  /** What is drawn: the newest items of the tail that fit, oldest first. */
  readonly items: readonly PlannedItem[];
  readonly rows: number;
  /**
   * What does not fit goes into the scroll-back at once: everything before this sequence number.
   * Undefined when the whole tail fits. A frame as tall as the terminal makes the terminal library
   * clear the screen and write everything again, which is not wanted.
   */
  readonly commitBefore: number | undefined;
}

/**
 * The tail in `room` rows. The newest items that fit are kept; each record takes what it needs
 * and each block its header, and the rows that remain go to the text of the blocks, the newest
 * first. What is older than that is for the scroll-back (`commitBefore`) and is not drawn.
 */
export function planTail(
  tail: readonly TailItem[],
  options: {
    readonly now: number;
    readonly columns: number;
    readonly room: number;
    readonly folded: boolean;
  },
): TailPlan {
  const least = (item: TailItem): number =>
    item.kind === 'RECORD' ? recordRows(item.record, options.columns) : 1;
  let fixed = 0;
  let first = tail.length;
  while (first > 0) {
    const item = tail[first - 1];
    if (item === undefined || fixed + least(item) > options.room) break;
    fixed += least(item);
    first -= 1;
  }
  const kept = tail.slice(first);
  let left = Math.max(0, options.room - fixed);
  const bodies = new Map<number, number>();
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const item = kept[index];
    if (item === undefined || item.kind !== 'BLOCK' || options.folded) continue;
    const wanted = wrapLines(
      item.block.text.trimEnd(),
      Math.max(10, options.columns - MARGIN - 2),
    ).length;
    const given = Math.min(wanted, left);
    bodies.set(item.seq, given);
    left -= given;
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
            bodyLines: bodies.get(item.seq) ?? 0,
          }),
        },
  );
  const rows = items.reduce((sum, item) => sum + item.lines.length, 0);
  const next = kept[0];
  const last = tail[tail.length - 1];
  const commitBefore =
    first === 0 || last === undefined
      ? undefined
      : next === undefined
        ? // Not even the newest fits: all of it goes, and what comes after is new.
          last.seq + 1
        : next.seq;
  return { items, rows, commitBefore };
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
