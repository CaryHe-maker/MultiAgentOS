import { PassThrough } from 'node:stream';
import { expect } from 'vitest';
import type { ThinkingView } from '@multiagentos/user-interaction';
import { createInkConsole } from '../presentation/ink-console.js';
import { setAmbiguousWidth } from '../presentation/terminal-width.js';

/**
 * What a terminal draws, in a model of its own that does not borrow from the library under test:
 * combining marks take no column, East Asian wide characters two, everything else one.
 */
export function charWidth(code: number): number {
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  )
    return 0;
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1;
}

/** The control sequence that starts at `at` (ESC [ parameters letter), if there is one. */
function controlSequenceAt(
  data: string,
  at: number,
): { readonly length: number; readonly parameters: string; readonly final: string } | undefined {
  if (data.charCodeAt(at) !== 27 || data[at + 1] !== '[') return undefined;
  let end = at + 2;
  while (end < data.length && '0123456789;?'.includes(data[end] ?? '')) end += 1;
  const final = data[end];
  if (final === undefined || !/[A-Za-z]/u.test(final)) return undefined;
  return { length: end + 1 - at, parameters: data.slice(at + 2, end), final };
}

/**
 * A small terminal that does what a real one does with the output of Ink: it wraps a line that is
 * wider than the screen (by its own idea of how wide a character is), moves the cursor, erases
 * lines, and lets what scrolls off the top stay in the scroll-back, where nothing can erase it.
 * The conversation as it is left in that terminal is what the person sees when scrolling up.
 */
export class Terminal {
  readonly scrollback: string[] = [];
  readonly #screen: string[][];
  #row = 0;
  #column = 0;

  public constructor(
    readonly columns: number,
    readonly rows: number,
    /** A terminal in a CJK locale draws dashes, quotes and symbols two columns wide. */
    readonly wideAmbiguous: boolean,
  ) {
    this.#screen = Array.from({ length: rows }, () => []);
  }

  #width(character: string): number {
    const code = character.codePointAt(0) ?? 0;
    const width = charWidth(code);
    if (width !== 1 || !this.wideAmbiguous) return width;
    return code === 0x00b7 ||
      (code >= 0x2010 && code <= 0x2027) ||
      (code >= 0x2460 && code <= 0x27bf) ||
      (code >= 0x25a0 && code <= 0x25ff)
      ? 2
      : 1;
  }

  #lineFeed(): void {
    this.#row += 1;
    if (this.#row >= this.rows) {
      this.scrollback.push((this.#screen.shift() ?? []).join('').trimEnd());
      this.#screen.push([]);
      this.#row = this.rows - 1;
    }
  }

  public write(data: string): void {
    for (let at = 0; at < data.length;) {
      const escape = controlSequenceAt(data, at);
      if (escape !== undefined) {
        at += escape.length;
        const count = Number(escape.parameters.replace('?', '')) || 1;
        switch (escape.final) {
          case 'A':
            this.#row = Math.max(0, this.#row - count);
            break;
          case 'B':
            this.#row = Math.min(this.rows - 1, this.#row + count);
            break;
          case 'G':
            this.#column = Math.max(0, count - 1);
            break;
          case 'K':
            this.#screen[this.#row] = [];
            break;
          case 'J':
            this.#screen[this.#row] = (this.#screen[this.#row] ?? []).slice(0, this.#column);
            for (let row = this.#row + 1; row < this.rows; row += 1) this.#screen[row] = [];
            break;
          default:
            break;
        }
        continue;
      }
      const character = String.fromCodePoint(data.codePointAt(at) ?? 0);
      at += character.length;
      if (character === '\n') {
        this.#lineFeed();
        this.#column = 0;
      } else if (character === '\r') this.#column = 0;
      else {
        const width = this.#width(character);
        if (width === 0) continue;
        if (this.#column + width > this.columns) {
          this.#lineFeed();
          this.#column = 0;
        }
        const line = this.#screen[this.#row] ?? [];
        while (line.length < this.#column) line.push(' ');
        line[this.#column] = character;
        for (let extra = 1; extra < width; extra += 1) line[this.#column + extra] = '';
        this.#screen[this.#row] = line;
        this.#column += width;
      }
    }
  }

  /** Where the cursor is on the screen, and what is on each row of the screen. */
  public cursor(): { readonly row: number; readonly column: number; readonly rows: string[] } {
    return {
      row: this.#row,
      column: this.#column,
      rows: this.#screen.map((line) => line.join('').trimEnd()),
    };
  }

  /** Everything the person can scroll through: the scroll-back, then the screen. */
  public everything(): string {
    return [...this.scrollback, ...this.#screen.map((line) => line.join('').trimEnd())].join('\n');
  }
}

export function connect(columns: number, rows: number, wideAmbiguous: boolean) {
  // The width the process measured when it started: what the terminal in use draws.
  setAmbiguousWidth(wideAmbiguous ? 'wide' : 'narrow');
  const terminal = new Terminal(columns, rows, wideAmbiguous);
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
  stdout.on('data', (chunk: Buffer) => terminal.write(chunk.toString()));
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  return { terminal, stdin, stdout };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
export const block = (
  number: number,
  text: string,
  state: 'OPEN' | 'DONE' = 'DONE',
): ThinkingView => ({
  id: `exe_${String(number)}`,
  number,
  label: 'main',
  state,
  startedAt: new Date(Date.now() - 3000).toISOString(),
  ...(state === 'OPEN' ? {} : { endedAt: new Date().toISOString() }),
  text,
});

/** A reply of the kind that went wrong: a long list with dashes, quotes and backticks. */
export const reply = (turn: number) =>
  [
    `第${String(turn)}次回答——我当前会话里能调用的工具一共有 13 个，按用途分：`,
    ...Array.from(
      { length: 18 },
      (_, index) =>
        `${String(index + 1)}. \`tool_${String(turn)}_${String(index)}\` — 按目录列出仓库文件树（可限深度、按 “glob” 过滤）`,
    ),
    `以上是第${String(turn)}次的全部。`,
  ].join('\n');

/** What a test has mounted, to let go of in `afterEach`. */
export const mounted: { unmount: (() => void) | undefined } = { unmount: undefined };

export const conversation = async (columns: number, rows: number, wideAmbiguous: boolean) => {
  const { terminal, stdin, stdout } = connect(columns, rows, wideAmbiguous);
  const ink = createInkConsole(
    stdin as unknown as NodeJS.ReadStream,
    stdout as unknown as NodeJS.WriteStream,
  );
  const instance = ink.mount({
    submit: () => Promise.resolve(),
    interrupt: () => Promise.resolve(),
    withdrawLast: () => undefined,
    steer: () => Promise.resolve(),
  });
  mounted.unmount = () => instance.unmount();
  await tick();
  const blocks: ThinkingView[] = [];
  const idle = { status: '等待输入', activity: [], waiting: 0, queued: [] };
  for (let turn = 1; turn <= 5; turn += 1) {
    ink.store.print({ kind: 'USER', text: `问题${String(turn)}：回答我你可以看到自己的哪些工具` });
    blocks.push(block(blocks.length + 1, '先想想要做什么\n再看有哪些工具\n然后整理成清单', 'OPEN'));
    ink.store.update({ ...idle, status: '运行中', thinking: [...blocks] });
    await tick();
    // The answer is being written: one line with the time; the text comes whole when published.
    ink.store.update({
      ...idle,
      status: '运行中',
      thinking: [...blocks],
      activity: [
        {
          agentRunId: `a${String(turn)}`,
          label: 'main',
          phase: '正在输出回答',
          since: new Date().toISOString(),
        },
      ],
    });
    await tick();
    blocks[blocks.length - 1] = block(
      blocks.length,
      '先想想要做什么\n再看有哪些工具\n然后整理成清单',
    );
    ink.store.print({ kind: 'REPLY', agentLabel: 'main', text: reply(turn) });
    ink.store.update({ ...idle, thinking: [...blocks] });
    await tick();
  }
  return terminal.everything();
};

/** The last line and the head of each of the five replies are in the conversation exactly once. */
export function expectEveryReplyOnce(text: string): void {
  for (let turn = 1; turn <= 5; turn += 1) {
    // The last line of each reply is written once: a copy of a frame left behind would repeat it.
    const finished = text.split(`以上是第${String(turn)}次的全部。`).length - 1;
    expect(finished, `reply ${String(turn)}`).toBe(1);
    const first = text.split(`第${String(turn)}次回答——`).length - 1;
    expect(first, `the head of reply ${String(turn)}`).toBe(1);
  }
}
