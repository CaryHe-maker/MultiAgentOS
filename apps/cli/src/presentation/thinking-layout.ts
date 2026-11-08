/**
 * How the thinking of the Turns in view is laid out in the lines the terminal has to give it
 * (docs/M2/Phase1Console.md 4.3). Newest first: every block gets its header, and what is left of
 * the budget goes to the tail of the newest blocks, so what the model is thinking now is always on
 * screen. A folded block (Ctrl+O) is its header only. Pure: the Ink component draws the lines.
 */
import { ConsoleText, type ThinkingView, type WritingView } from '@multiagentos/user-interaction';
import { charWidth } from './text-input.js';

export interface ThinkingLine {
  readonly text: string;
  readonly kind: 'HEADER' | 'BODY' | 'NOTE';
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

export function layoutThinking(
  blocks: readonly ThinkingView[],
  options: {
    readonly now: number;
    readonly columns: number;
    /** The most lines these blocks may take together. */
    readonly budget: number;
    readonly folded: boolean;
  },
): ThinkingLine[] {
  const shown: ThinkingLine[][] = [];
  // Headers first: every block that fits at all gets its header before any block gets a body.
  const headers = Math.min(blocks.length, Math.max(0, options.budget));
  let room = Math.max(0, options.budget) - headers;
  const skipped = blocks.length - headers;
  for (let index = blocks.length - 1; index >= blocks.length - headers; index -= 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    const header: ThinkingLine = {
      text: `${options.folded ? '▸' : '▾'} ${ConsoleText.thinkingHeader(block.label, seconds(block, options.now), block.state)}`,
      kind: 'HEADER',
      live: block.state === 'OPEN',
    };
    let body: ThinkingLine[] = [];
    if (!options.folded && block.text.length > 0 && room > 0) {
      const wrapped = wrapLines(block.text.trimEnd(), Math.max(10, options.columns - 2));
      body = wrapped
        .slice(-room)
        .map((text) => ({ text: `  ${text}`, kind: 'BODY' as const, live: false }));
      room -= body.length;
    }
    shown.unshift([header, ...body]);
  }
  const note: ThinkingLine[] =
    skipped === 0
      ? []
      : [{ text: ConsoleText.thinkingEarlier(skipped), kind: 'NOTE', live: false }];
  return [...note, ...shown.flat()];
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
