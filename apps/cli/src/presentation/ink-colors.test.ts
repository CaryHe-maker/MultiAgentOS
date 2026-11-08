import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Colour is decided when the colour library loads, so it is switched on before anything is imported.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

import { ConsoleStore } from './console-store.js';
import { USER_COLOR, consoleApp } from './ink-console.js';

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
  it('writes what the user typed in bright green and what the agent said in blue', async () => {
    const { store, ui } = setup();
    store.print({ kind: 'USER', text: '问题' });
    store.print({ kind: 'REPLY', agentLabel: 'main', text: '回答' });
    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(USER_COLOR).toBe('#39ff14');
    // 24-bit green for the user, bright blue for the agent.
    expect(frame).toContain('\u001b[38;2;57;255;20m> 问题');
    expect(frame).toContain('\u001b[94mmain: 回答');
  });

  it('writes the text an agent is writing in the colour of its replies', async () => {
    const { store, ui } = setup();
    store.update({
      status: '',
      activity: [],
      waiting: 0,
      queued: [],
      writing: [{ id: 'exe_1', label: 'main', state: 'OPEN', text: '正在写' }],
    });
    await tick();
    expect(ui.lastFrame()).toContain('[94mmain: 正在写');
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
