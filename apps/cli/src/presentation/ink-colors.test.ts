import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Colour is decided when the colour library loads, so it is switched on before anything is imported.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

import { ConsoleStore } from './console-store.js';
import { REPLY_COLOR, SYSTEM_COLOR, USER_COLOR, consoleApp } from './ink-console.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => cleanup());

function setup() {
  const store = new ConsoleStore();
  const ui = render(
    consoleApp(store, {
      submit: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      withdrawLast: () => undefined,
      steer: () => Promise.resolve(),
    }),
  );
  return { store, ui };
}

describe('Ink console colours', () => {
  it('writes what the user typed in bright green, the system in light blue and the agent in deep blue', async () => {
    const { store, ui } = setup();
    store.print({ kind: 'USER', text: '问题' });
    store.print({ kind: 'NOTICE', text: '已允许。' });
    store.print({ kind: 'REPLY', agentLabel: 'main', text: '回答' });
    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(USER_COLOR).toBe('#39ff14');
    expect(SYSTEM_COLOR).toBe('#8fd3ff');
    expect(REPLY_COLOR).toBe('#2f6df6');
    // 24-bit colours: green for the user, light blue for the system, deep blue for the agent.
    expect(frame).toContain('\u001b[38;2;57;255;20m> 问题');
    expect(frame).toContain('\u001b[38;2;143;211;255m已允许。');
    expect(frame).toContain('\u001b[38;2;47;109;246mmain: 回答');
  });

  it('writes the thinking in grey, while it streams and after', async () => {
    const { store, ui } = setup();
    const block = (state: 'OPEN' | 'DONE') => ({
      id: 'exe_1',
      number: 1,
      label: 'main',
      state,
      startedAt: new Date(Date.now() - 2000).toISOString(),
      ...(state === 'OPEN' ? {} : { endedAt: new Date().toISOString() }),
      text: '想一想',
    });
    for (const state of ['OPEN', 'DONE'] as const) {
      store.update({
        status: '',
        activity: [],
        waiting: 0,
        queued: [],
        thinking: [block(state)],
      });
      await tick();
      expect(ui.lastFrame()).toContain('[90m▾ ✻ main 思考');
    }
  });

  it('draws the cursor on the character it stands on, and the typed text in green', async () => {
    const { ui } = setup();
    await tick();
    for (const key of ['a', 'b', '\u001b[D']) {
      ui.stdin.write(key);
      await tick();
    }
    const frame = ui.lastFrame() ?? '';
    // The character under the cursor is in reverse video; the rest of the box is green.
    expect(frame).toContain('\u001b[7mb\u001b[27m');
    expect(frame).toContain('\u001b[38;2;57;255;20m');
  });
});
