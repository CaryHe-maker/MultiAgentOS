import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInkConsole } from './ink-console.js';
import { connect, mounted, tick } from '../test-support/terminal-emulator.js';
import { setAmbiguousWidth } from './terminal-width.js';
import { createTracer } from './ui-trace.js';

afterEach(() => {
  mounted.unmount?.();
  setAmbiguousWidth('narrow');
});

describe('the trace of the screen', () => {
  it('counts what is erased and written, and the widest row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const file = join(dir, 'ui.jsonl');
    const tracer = createTracer(file, { columns: 40, rows: 10 });
    const ESC = String.fromCharCode(27);
    tracer.write(`${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[Gone\n两个字\nlast`);
    tracer.resize();
    const [first, second]: Record<string, unknown>[] = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(first).toMatchObject({
      kind: 'WRITE',
      columns: 40,
      rows: 10,
      erased: 2,
      written: 3,
      widest: 6,
      clears: false,
    });
    expect(second).toMatchObject({ kind: 'RESIZE', columns: 40 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('is written by the console only when asked for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const file = join(dir, 'ui.jsonl');
    process.env['MAS_UI_TRACE'] = file;
    try {
      const { stdin, stdout } = connect(50, 20, false);
      const ink = createInkConsole(stdin as never, stdout as never);
      const instance = ink.mount({
        submit: () => Promise.resolve(),
        interrupt: () => Promise.resolve(),
        withdrawLast: () => undefined,
        steer: () => Promise.resolve(),
      });
      mounted.unmount = () => instance.unmount();
      await tick();
      ink.store.print({ kind: 'USER', text: '问题' });
      await tick();
      const lines = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((entry) => entry['kind'] === 'WRITE' || entry['kind'] === 'RESIZE')).toBe(
        true,
      );
    } finally {
      delete process.env['MAS_UI_TRACE'];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
