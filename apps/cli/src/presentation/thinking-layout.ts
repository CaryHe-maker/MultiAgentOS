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
import { charWidth, displayWidth, rowsOf } from './text-input.js';

export interface ThinkingLine {
  readonly text: string;
  readonly kind: 'HEADER' | 'BODY';
  /** Streaming right now, for the header's colour. */
  readonly live: boolean;
}

/** Text cut into pieces that fit `width` columns, line breaks kept. */
export function wrapLines(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    let current = '';
    let used = 0;
    for (const character of line) {
      const columns = charWidth(character.codePointAt(0) ?? 0);
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

/** Screen rows a record takes. */
export function recordRows(record: TranscriptRecord, columns: number): number {
  const prefix = prefixOf(record);
  return `${prefix}${record.text}`
    .split('\n')
    .reduce((sum, line) => sum + rowsOf(displayWidth(line), columns), 0);
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
  const wrapped = wrapLines(block.text.trimEnd(), Math.max(10, options.columns - 2));
  return [
    header,
    ...wrapped
      .slice(-options.bodyLines)
      .map((text) => ({ text: `  ${text}`, kind: 'BODY' as const, live: false })),
  ];
}

export type PlannedItem =
  | { readonly kind: 'RECORD'; readonly seq: number; readonly record: TranscriptRecord }
  | {
      readonly kind: 'BLOCK';
      readonly seq: number;
      readonly lines: readonly ThinkingLine[];
    };

export interface TailPlan {
  readonly items: readonly PlannedItem[];
  readonly rows: number;
  /** Even without any text of the blocks the tail does not fit: the oldest has to go. */
  readonly overflow: boolean;
}

/**
 * The tail in `room` rows. The records and the headers of the blocks come first; the rows that
 * remain are given to the text of the blocks, the newest first.
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
  const fixed = tail.reduce(
    (sum, item) => sum + (item.kind === 'RECORD' ? recordRows(item.record, options.columns) : 1),
    0,
  );
  let left = Math.max(0, options.room - fixed);
  const bodies = new Map<number, number>();
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const item = tail[index];
    if (item === undefined || item.kind !== 'BLOCK' || options.folded) continue;
    const wanted = wrapLines(item.block.text.trimEnd(), Math.max(10, options.columns - 2)).length;
    const given = Math.min(wanted, left);
    bodies.set(item.seq, given);
    left -= given;
  }
  const items: PlannedItem[] = tail.map((item) =>
    item.kind === 'RECORD'
      ? item
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
  const rows = items.reduce(
    (sum, item) =>
      sum + (item.kind === 'RECORD' ? recordRows(item.record, options.columns) : item.lines.length),
    0,
  );
  return { items, rows, overflow: fixed > options.room };
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
    wrapLines(`${block.label}: ${block.text}`.trimEnd(), Math.max(10, options.columns - 1)),
  );
  return options.budget <= 0 ? [] : lines.slice(-options.budget);
}
