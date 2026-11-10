import { afterEach, describe, expect, it } from 'vitest';
import { createInkConsole } from './ink-console.js';
import { connect, mounted, tick } from '../test-support/terminal-emulator.js';
import { setAmbiguousWidth } from './terminal-width.js';

afterEach(() => {
  mounted.unmount?.();
  setAmbiguousWidth('narrow');
});

/** Erasing the whole screen, which a resize no longer does. */
const CLEAR_SCREEN = `${String.fromCharCode(27)}[2J${String.fromCharCode(27)}[H`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

function mount() {
  const { terminal, stdin, stdout } = connect(60, 20, false);
  const written: string[] = [];
  stdout.on('data', (chunk: Buffer) => written.push(chunk.toString()));
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
  const resize = (columns: number) => {
    (stdout as unknown as { columns: number }).columns = columns;
    stdout.emit('resize');
  };
  const clears = () => written.join('').split(CLEAR_SCREEN).length - 1;
  return { terminal, stdin, stdout, ink, written, resize, clears };
}

describe('resizing the window', () => {
  it('erases only the part drawn in place, at every size, and never the whole screen', async () => {
    const t = mount();
    await tick();
    t.ink.store.print({ kind: 'USER', text: '问题' });
    t.ink.store.update({ status: '等待输入', activity: [], waiting: 0, queued: [] });
    await tick();
    for (let columns = 58; columns >= 40; columns -= 2) {
      t.resize(columns);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await tick();
    expect(t.clears()).toBe(0);
    const text = t.terminal.everything();
    // The conversation is where it was, once; the status line and the box are there once.
    expect(text.split('问题').length - 1).toBe(1);
    expect(text.split('------ 等待输入 ------').length - 1).toBe(1);
    expect(text.split(String.fromCharCode(10)).filter((line) => line.startsWith('›'))).toHaveLength(
      1,
    );
  });

  it('draws the part in place again with what was typed, below the conversation', async () => {
    const t = mount();
    await tick();
    t.ink.store.print({ kind: 'USER', text: '问题' });
    await tick();
    t.stdin.write('abc');
    await tick();
    t.resize(40);
    await tick();
    const { row, rows } = t.terminal.cursor();
    expect(rows[row]).toBe('› abc');
    expect(rows.some((each) => each.includes('问题'))).toBe(true);
    // The box is below the conversation, not above it: nothing was erased on the way up.
    expect(rows.findIndex((each) => each.includes('问题'))).toBeLessThan(row);
  });

  it('answers every size the same way, however fast they come', async () => {
    const t = mount();
    await tick();
    t.ink.store.print({ kind: 'USER', text: '问题' });
    await tick();
    for (const columns of [50, 44, 38, 60, 60, 30, 59]) t.resize(columns);
    await tick();
    expect(t.clears()).toBe(0);
    expect(t.terminal.everything().split('问题').length - 1).toBe(1);
  });

  it('has only its own handler on the stream, and none after the console is gone', async () => {
    const t = mount();
    await tick();
    expect(t.stdout.listenerCount('resize')).toBe(1);
    mounted.unmount?.();
    await tick();
    expect(t.stdout.listenerCount('resize')).toBe(0);
    const before = t.written.length;
    t.resize(30);
    await settle();
    expect(t.written.length).toBe(before);
  });
});
