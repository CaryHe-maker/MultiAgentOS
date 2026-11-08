import { PassThrough } from 'node:stream';
import type { ThinkingView } from '@multiagentos/user-interaction';
import { afterEach, describe, expect, it } from 'vitest';
import { createInkConsole } from './ink-console.js';
import { charWidth } from './text-input.js';

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
class Terminal {
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
    return (code >= 0x2010 && code <= 0x2027) ||
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

function connect(columns: number, rows: number, wideAmbiguous: boolean) {
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
const block = (number: number, text: string, state: 'OPEN' | 'DONE' = 'DONE'): ThinkingView => ({
  id: `exe_${String(number)}`,
  number,
  label: 'main',
  state,
  startedAt: new Date(Date.now() - 3000).toISOString(),
  ...(state === 'OPEN' ? {} : { endedAt: new Date().toISOString() }),
  text,
});

/** A reply of the kind that went wrong: a long list with dashes, quotes and backticks. */
const reply = (turn: number) =>
  [
    `第${String(turn)}次回答——我当前会话里能调用的工具一共有 13 个，按用途分：`,
    ...Array.from(
      { length: 18 },
      (_, index) =>
        `${String(index + 1)}. \`tool_${String(turn)}_${String(index)}\` — 按目录列出仓库文件树（可限深度、按 “glob” 过滤）`,
    ),
    `以上是第${String(turn)}次的全部。`,
  ].join('\n');

let unmount: (() => void) | undefined;
afterEach(() => unmount?.());

const conversation = async (columns: number, rows: number, wideAmbiguous: boolean) => {
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
  unmount = () => instance.unmount();
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
      answering: [{ id: `w${String(turn)}`, label: 'main', startedAt: new Date().toISOString() }],
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

describe('the conversation a terminal is left with', () => {
  for (const [name, wide] of [
    ['a terminal that counts dashes and symbols as one column', false],
    ['a terminal that draws dashes and symbols two columns wide', true],
  ] as const)
    it(`has every reply once, however long, on ${name}`, async () => {
      const text = await conversation(76, 30, wide);
      for (let turn = 1; turn <= 5; turn += 1) {
        // The last line of each reply is written once: a copy of a frame left behind would repeat it.
        const finished = text.split(`以上是第${String(turn)}次的全部。`).length - 1;
        expect(finished, `reply ${String(turn)}`).toBe(1);
        const first = text.split(`第${String(turn)}次回答——`).length - 1;
        expect(first, `the head of reply ${String(turn)}`).toBe(1);
      }
    });
});

describe('long thinkings that grow while they run', () => {
  it('leave no copy of a frame behind, and every line of thinking is there at most once', async () => {
    const { terminal, stdin, stdout } = connect(76, 30, true);
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
    unmount = () => instance.unmount();
    await tick();
    const idle = { status: '等待输入', activity: [], waiting: 0, queued: [] };
    const blocks: ThinkingView[] = [];
    const thought = (number: number, count: number) =>
      Array.from(
        { length: count },
        (_, index) => `思考${String(number)}_${String(index + 1)} — 一行比较长的推理内容`,
      ).join('\n');
    let number = 0;
    for (let turn = 1; turn <= 4; turn += 1) {
      ink.store.print({ kind: 'USER', text: `问题${String(turn)}` });
      for (let call = 0; call < 2; call += 1) {
        number += 1;
        blocks.push(block(number, thought(number, 3), 'OPEN'));
        // The thinking grows by ten lines at a time, up to far more than the terminal holds.
        for (let count = 10; count <= 60; count += 10) {
          blocks[blocks.length - 1] = block(number, thought(number, count), 'OPEN');
          ink.store.update({ ...idle, status: '运行中', thinking: [...blocks] });
          await tick();
        }
        blocks[blocks.length - 1] = block(number, thought(number, 60));
        ink.store.update({ ...idle, status: '运行中', thinking: [...blocks] });
        ink.store.print({ kind: 'STEP', text: `✓ list_files ${String(number)}` });
        await tick();
      }
      ink.store.print({ kind: 'REPLY', agentLabel: 'main', text: `回答${String(turn)}\n第二行` });
      ink.store.update({ ...idle, thinking: [...blocks] });
      await tick();
    }
    const text = terminal.everything();
    for (let at = 1; at <= number; at += 1)
      for (let line = 1; line <= 60; line += 1) {
        const seen = text.split(`思考${String(at)}_${String(line)} —`).length - 1;
        expect(seen, `line ${String(line)} of thinking ${String(at)}`).toBeLessThanOrEqual(1);
      }
    for (let turn = 1; turn <= 4; turn += 1) {
      expect(text.split(`回答${String(turn)}`).length - 1, `reply ${String(turn)}`).toBe(1);
      expect(text.split(`问题${String(turn)}`).length - 1, `question ${String(turn)}`).toBe(1);
    }
  });
});

describe('where the cursor is left', () => {
  it('stands in the input box, at the text, whatever is drawn above it', async () => {
    const { terminal, stdin, stdout } = connect(60, 30, false);
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
    unmount = () => instance.unmount();
    await tick();
    const idle = { status: '运行中', activity: [], waiting: 0, queued: [] };
    ink.store.print({ kind: 'USER', text: '问题' });
    ink.store.update({
      ...idle,
      activity: [
        {
          agentRunId: 'a1',
          label: 'main',
          phase: '思考中',
          since: new Date().toISOString(),
        },
      ],
      thinking: [block(1, '想一\n想二\n想三', 'OPEN')],
      answering: [{ id: 'w1', label: 'main', startedAt: new Date().toISOString() }],
      pending: { kind: 'CONTINUE', text: '本次运行的额度已用完。要继续吗？[y/n]' },
      queued: ['下一条'],
    });
    for (const key of ['你', '好', '[D']) {
      stdin.write(key);
      await tick();
    }
    const { row, column, rows } = terminal.cursor();
    // The input box is the last row of the picture, and the cursor is on it: after the prompt
    // and the first character, between the two.
    expect(rows[row]).toContain('› 你好');
    expect(column).toBe(2 + 2);
  });

  it('stays on the input row when a reply in the drawn part has blank lines', async () => {
    const { terminal, stdin, stdout } = connect(60, 30, false);
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
    unmount = () => instance.unmount();
    await tick();
    ink.store.print({ kind: 'USER', text: '问题' });
    // An open thinking keeps what comes after it in the drawn part, blank lines included.
    ink.store.update({
      status: '运行中',
      activity: [],
      waiting: 0,
      queued: [],
      thinking: [block(1, '想一\n想二', 'OPEN')],
    });
    ink.store.print({
      kind: 'REPLY',
      agentLabel: 'main',
      text: '第一段\n\n第二段\n\n\n第三段',
    });
    await tick();
    stdin.write('你');
    await tick();
    const { row, column, rows } = terminal.cursor();
    expect(rows[row]).toContain('› 你');
    expect(column).toBe(2 + 2);
    // The blank lines are there too.
    const text = rows.join('\n');
    expect(text).toMatch(/第一段\s*\n\s*\n\s*第二段/u);
  });
});
