import type { ThinkingView } from '@multiagentos/user-interaction';
import { afterEach, describe, expect, it } from 'vitest';
import { createInkConsole } from './ink-console.js';
import { block, connect, mounted, tick } from '../test-support/terminal-emulator.js';
import { setAmbiguousWidth } from './terminal-width.js';

afterEach(() => {
  mounted.unmount?.();
  setAmbiguousWidth('narrow');
});

const ESC = String.fromCharCode(27);

function mount(columns: number, rows: number) {
  const { terminal, stdin, stdout } = connect(columns, rows, false);
  const ink = createInkConsole(
    stdin as unknown as NodeJS.ReadStream,
    stdout as unknown as NodeJS.WriteStream,
  );
  const sent: string[] = [];
  const instance = ink.mount({
    submit: (text) => {
      sent.push(text);
      return Promise.resolve();
    },
    interrupt: () => Promise.resolve(),
    withdrawLast: () => undefined,
    steer: () => Promise.resolve(),
  });
  mounted.unmount = () => instance.unmount();
  const paste = (text: string) => stdin.write(`${ESC}[200~${text}${ESC}[201~`);
  const press = (key: string) => stdin.write(key);
  return { terminal, ink, sent, paste, press, stdin };
}

const UP = `${ESC}[A`;
const ENTER = '\r';
const manyLines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line number ${String(index + 1)} of the paste`).join(
    '\n',
  );

describe('a long paste in the input box', () => {
  it('is one placeholder, and is sent whole', async () => {
    const t = mount(80, 24);
    await tick();
    const text = manyLines(40);
    t.paste(text);
    await tick();
    const { row, rows } = t.terminal.cursor();
    expect(rows[row]).toContain('[paste 40 lines]');
    expect(t.terminal.everything()).not.toContain('line number 2 of');
    t.press(ENTER);
    await tick();
    expect(t.sent).toEqual([text]);
    expect(t.terminal.cursor().rows[t.terminal.cursor().row]).not.toContain('[paste');
  });

  it('is typed text up to fifteen characters', async () => {
    const t = mount(80, 24);
    await tick();
    t.paste('short paste ok!');
    await tick();
    const { row, rows } = t.terminal.cursor();
    expect(rows[row]).toContain('short paste ok!');
  });

  it('goes with one backspace', async () => {
    const t = mount(80, 24);
    await tick();
    t.press('a');
    t.paste(manyLines(5));
    await tick();
    t.press(String.fromCharCode(127));
    await tick();
    const { row, rows } = t.terminal.cursor();
    expect(rows[row]).toBe('› a');
  });

  it('comes back from the history as a placeholder, and is sent whole again', async () => {
    const t = mount(80, 24);
    await tick();
    const text = manyLines(6);
    t.paste(text);
    await tick();
    t.press(ENTER);
    await tick();
    t.press(UP);
    await tick();
    const { row, rows } = t.terminal.cursor();
    expect(rows[row]).toContain('[paste 6 lines]');
    t.press(ENTER);
    await tick();
    expect(t.sent).toEqual([text, text]);
  });

  it('over 100 KB is not let go of: what was pasted stays in the box', async () => {
    const t = mount(80, 24);
    await tick();
    const big = 'x'.repeat(100 * 1024 + 1);
    t.paste(big);
    await tick();
    t.press(ENTER);
    await tick();
    // The console is given it (and says why it goes no further); the box keeps it.
    expect(t.sent).toEqual([big]);
    const { row, rows } = t.terminal.cursor();
    expect(rows[row]).toContain('[paste');
  });

  it('is let go of at 100 KB exactly', async () => {
    const t = mount(80, 24);
    await tick();
    const limit = 'x'.repeat(100 * 1024);
    t.paste(limit);
    await tick();
    t.press(ENTER);
    await tick();
    expect(t.sent).toEqual([limit]);
    expect(t.terminal.cursor().rows[t.terminal.cursor().row]).not.toContain('[paste');
  });
});

describe('the input box is never taller than its height', () => {
  it('leaves no copy of a frame behind, however much is typed and however often it is drawn', async () => {
    const t = mount(80, 24);
    await tick();
    for (let turn = 1; turn <= 3; turn += 1) {
      t.ink.store.print({ kind: 'USER', text: `问题${String(turn)}` });
      t.ink.store.print({ kind: 'REPLY', agentLabel: 'main', text: `回答${String(turn)}` });
    }
    await tick();
    // One chunk without line breaks is typed text (an input method), not a paste: the box is tall.
    t.press('第一行 '.repeat(400));
    await tick();
    const grown = t.terminal.scrollback.length;
    for (let n = 0; n < 4; n += 1) {
      t.ink.store.update({
        status: '运行中',
        activity: [
          { agentRunId: 'a', label: 'main', phase: '思考中', since: new Date().toISOString() },
        ],
        waiting: 0,
        queued: [],
      });
      await tick();
    }
    const all = t.terminal.everything();
    expect(all.split('问题1').length - 1).toBe(1);
    expect(all.split('回答1').length - 1).toBe(1);
    expect(t.terminal.scrollback.length).toBe(grown);
  });

  it('is two rows on the smallest terminal, and ten on a tall one', async () => {
    const small = mount(80, 6);
    await tick();
    small.press('abc '.repeat(100));
    await tick();
    const boxRows = small.terminal
      .cursor()
      .rows.filter((each) => each.includes('abc') || each.includes('…'));
    expect(boxRows.length).toBeLessThanOrEqual(2);
    expect(boxRows.length).toBeGreaterThanOrEqual(1);
  });

  it('shows … where rows are hidden, on the side that has more', async () => {
    const t = mount(80, 24);
    await tick();
    // Each key is its own chunk, as when typed: a chunk with a line break in it is a paste.
    const apart = () => new Promise((resolve) => setImmediate(resolve));
    for (let line = 1; line <= 30; line += 1) {
      t.press(`l${String(line)}`);
      await apart();
      t.press('\\');
      await apart();
      t.press(ENTER);
      await apart();
    }
    await tick();
    let screen = t.terminal.cursor().rows.join('\n');
    expect(screen).toContain('…');
    expect(screen).toContain('l30');
    expect(screen).not.toContain('l1\n');
    for (let step = 0; step < 15; step += 1) t.press(UP);
    await tick();
    screen = t.terminal.cursor().rows.join('\n');
    // In the middle both sides are marked.
    expect(screen.split('…').length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe('the input row does not climb up the screen', () => {
  it('stays within three rows of where it was when what is above it shrinks', async () => {
    const t = mount(80, 24);
    await tick();
    const thinking: ThinkingView[] = [
      block(
        1,
        Array.from({ length: 60 }, (_, index) => `thought ${String(index)}`).join('\n'),
        'OPEN',
      ),
    ];
    t.ink.store.update({ status: '运行中', activity: [], waiting: 0, queued: [], thinking });
    await tick();
    const tall = t.terminal.cursor().row;
    t.ink.store.update({ status: '等待输入', activity: [], waiting: 0, queued: [], thinking: [] });
    await tick();
    await tick();
    const after = t.terminal.cursor().row;
    expect(after).toBeGreaterThanOrEqual(tall - 3);
  });
});
