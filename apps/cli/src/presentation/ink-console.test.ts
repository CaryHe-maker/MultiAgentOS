import { PassThrough } from 'node:stream';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleStore } from './console-store.js';
import { consoleApp } from './ink-console.js';
import { createLineConsoleView } from './line-console.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup() {
  const store = new ConsoleStore();
  const input = {
    submit: vi.fn<(line: string) => Promise<void>>(() => Promise.resolve()),
    interrupt: vi.fn(() => Promise.resolve()),
    withdrawLast: vi.fn((): string | undefined => '排队的'),
  };
  const ui = render(consoleApp(store, input));
  return { store, input, ui };
}

afterEach(() => cleanup());

describe('Ink console', () => {
  it('writes the transcript once and redraws only the live area', async () => {
    const { store, ui } = setup();
    store.print({ kind: 'USER', text: '你好' });
    store.update({
      status: '运行中',
      activity: [
        {
          agentRunId: 'arn_1',
          label: 'main',
          phase: '调用',
          since: new Date().toISOString(),
          tool: 'read-file a.ts',
        },
      ],
      waiting: 0,
      queued: ['下一条'],
    });
    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('> 你好');
    expect(frame).toContain('· main 调用 read-file a.ts 0s');
    expect(frame).toContain('已排队 1 条');

    store.update({ status: '等待输入', activity: [], waiting: 0, queued: [] });
    await tick();
    expect(ui.lastFrame()).not.toContain('read-file');
    expect(ui.lastFrame()).toContain('> 你好');
  });

  it('counts down a retry', async () => {
    const { store, ui } = setup();
    store.update({
      status: '运行中',
      activity: [
        {
          agentRunId: 'arn_1',
          label: 'main',
          phase: '重试中',
          since: new Date().toISOString(),
          retry: { attempt: 2, retryAt: new Date(Date.now() + 5000).toISOString() },
        },
      ],
      waiting: 0,
      queued: [],
    });
    await tick();
    expect(ui.lastFrame()).toContain('重试中（第 2 次，5 秒后）');
  });

  it('sends a line on Enter, keeps a line break after a backslash and hands Ctrl+C to the console', async () => {
    const { input, ui } = setup();
    await tick();
    ui.stdin.write('a\\');
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('b');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(input.submit).toHaveBeenCalledWith('a\nb');

    ui.stdin.write('\u0003');
    await tick();
    expect(input.interrupt).toHaveBeenCalledTimes(1);
  });

  it('takes the last queued message back with ↑ and drops it with Esc', async () => {
    const { store, input, ui } = setup();
    store.update({ status: '', activity: [], waiting: 0, queued: ['排队的'] });
    await tick();
    ui.stdin.write('\u001b[A');
    await tick();
    expect(ui.lastFrame()).toContain('› 排队的');

    ui.stdin.write('\u001b');
    await tick();
    expect(ui.lastFrame()).toMatch(/^›$/mu);
    ui.stdin.write('\u001b');
    await tick();
    expect(input.withdrawLast).toHaveBeenCalledTimes(2);
  });
});

describe('Line console', () => {
  it('prints records and each new question once', () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const view = createLineConsoleView(output);
    const pending = { kind: 'CONTINUE', text: '继续吗？[y/n]' } as const;
    view.print({ kind: 'REPLY', agentLabel: 'main', text: '答案' });
    view.update({ status: '', activity: [], waiting: 0, queued: [], pending });
    view.update({ status: 'x', activity: [], waiting: 0, queued: [], pending });
    expect(chunks.join('')).toBe('main: 答案\n继续吗？[y/n]\n');
  });
});
