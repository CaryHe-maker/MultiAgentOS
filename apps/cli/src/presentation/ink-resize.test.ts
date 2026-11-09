import { afterEach, describe, expect, it } from 'vitest';
import { createInkConsole } from './ink-console.js';
import { CLEAR_SCREEN, RESIZE_SETTLE_MS } from './resize.js';
import { connect, mounted, tick } from '../test-support/terminal-emulator.js';
import { setAmbiguousWidth } from './terminal-width.js';

afterEach(() => {
  mounted.unmount?.();
  setAmbiguousWidth('narrow');
});

const settle = () => new Promise((resolve) => setTimeout(resolve, RESIZE_SETTLE_MS + 120));

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
  it('draws nothing while the size is changing, and the screen is cleared once when it is over', async () => {
    const t = mount();
    await tick();
    t.ink.store.print({ kind: 'USER', text: '问题' });
    t.ink.store.update({ status: '等待输入', activity: [], waiting: 0, queued: [] });
    await tick();
    const before = t.written.length;
    // A drag: many sizes, each a little narrower than the one before.
    for (let columns = 58; columns >= 40; columns -= 2) {
      t.resize(columns);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(t.written.length).toBe(before);
    expect(t.clears()).toBe(0);
    await settle();
    expect(t.clears()).toBe(1);
  });

  it('draws the part in place again after the clear, with what was typed', async () => {
    const t = mount();
    await tick();
    t.stdin.write('abc');
    await tick();
    t.resize(40);
    await settle();
    await tick();
    const { row, rows } = t.terminal.cursor();
    expect(rows[row]).toBe('› abc');
    // At the top of the screen: it was erased and drawn from there, not left where it was.
    expect(row).toBeLessThanOrEqual(2);
  });

  it('answers a second drag the same way', async () => {
    const t = mount();
    await tick();
    t.resize(50);
    await settle();
    t.resize(44);
    t.resize(38);
    await settle();
    expect(t.clears()).toBe(2);
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
