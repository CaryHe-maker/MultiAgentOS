import { PassThrough } from 'node:stream';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleStore } from './console-store.js';
import type { ThinkingView } from '@multiagentos/user-interaction';
import { consoleApp } from './ink-console.js';
import { layoutWriting } from './thinking-layout.js';
import { createLineConsoleView } from './line-console.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup() {
  const store = new ConsoleStore();
  const input = {
    submit: vi.fn<(line: string) => Promise<void>>(() => Promise.resolve()),
    interrupt: vi.fn(() => Promise.resolve()),
    withdrawLast: vi.fn((): string | undefined => '排队的'),
    steer: vi.fn<(line: string) => Promise<void>>(() => Promise.resolve()),
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

describe('Ink console: the input box', () => {
  const type = async (ui: ReturnType<typeof setup>['ui'], ...keys: string[]) => {
    for (const key of keys) {
      ui.stdin.write(key);
      await tick();
    }
  };
  const LEFT = '\u001b[D';
  const RIGHT = '\u001b[C';
  const HOME = '\u001b[H';
  const END = '\u001b[F';
  const DELETE = '\u001b[3~';
  const BACKSPACE = '\u007f';

  it('edits where the cursor is, not only at the end', async () => {
    const { input, ui } = setup();
    await tick();
    await type(ui, 'a', 'b', 'c', LEFT, LEFT, 'X', '\r');
    expect(input.submit).toHaveBeenLastCalledWith('aXbc');

    await type(ui, 'h', 'e', 'l', 'l', 'o', HOME, DELETE, END, BACKSPACE, '\r');
    expect(input.submit).toHaveBeenLastCalledWith('ell');

    await type(ui, 'x', 'y', LEFT, RIGHT, RIGHT, 'z', '\r');
    expect(input.submit).toHaveBeenLastCalledWith('xyz');
  });

  it('types and moves over Chinese text one character at a time', async () => {
    const { input, ui } = setup();
    await tick();
    await type(ui, '你', '好', LEFT, '们', '\r');
    expect(input.submit).toHaveBeenLastCalledWith('你们好');
  });

  it('shows where the cursor is, with the status above the box and not under it', async () => {
    const { store, ui } = setup();
    store.update({ status: '未开始', activity: [], waiting: 0, queued: [] });
    await tick();
    await type(ui, 'a', 'b', LEFT);
    const lines = (ui.lastFrame() ?? '').split('\n');
    const status = lines.findIndex((line) => line.includes('未开始'));
    const box = lines.findIndex((line) => line.includes('› ab'));
    expect(status).toBeGreaterThanOrEqual(0);
    expect(box).toBeGreaterThan(status);
    // The box is the last thing drawn, so the input method opens at the text.
    expect(box).toBe(lines.length - 1);
  });
});

describe('Ink console: waiting, colours and thinking', () => {
  const line = (phase: string, waitsForUser: boolean) => ({
    agentRunId: 'arn_1',
    label: 'main',
    phase,
    ...(waitsForUser ? { waitsForUser: true } : {}),
    since: new Date(Date.now() - 12_000).toISOString(),
  });

  it('counts no seconds while the run waits for the user, and does while the system works', async () => {
    const { store, ui } = setup();
    store.update({
      status: '',
      activity: [line('等待授权', true)],
      waiting: 0,
      queued: [],
    });
    await tick();
    expect(ui.lastFrame()).toContain('· main 等待授权');
    expect(ui.lastFrame()).not.toMatch(/等待授权.*\ds/u);

    store.update({ status: '', activity: [line('思考中', false)], waiting: 0, queued: [] });
    await tick();
    expect(ui.lastFrame()).toMatch(/思考中 1\ds/u);
  });

  const thinking = (text: string, state: 'OPEN' | 'DONE' = 'DONE') => ({
    id: 'exe_1',
    number: 1,
    label: 'main',
    state,
    startedAt: new Date(Date.now() - 3000).toISOString(),
    ...(state === 'OPEN' ? {} : { endedAt: new Date().toISOString() }),
    text,
  });

  it('shows the thinking under its header, and Ctrl+O folds it to the header and back', async () => {
    const { store, ui } = setup();
    store.update({
      status: '运行中',
      activity: [],
      waiting: 0,
      queued: [],
      thinking: [thinking('先看看 a.ts\n再决定改哪里', 'OPEN')],
    });
    await tick();
    expect(ui.lastFrame()).toContain('▾ ✻ main 思考');
    expect(ui.lastFrame()).toContain('先看看 a.ts');
    expect(ui.lastFrame()).toContain('再决定改哪里');

    ui.stdin.write('\u000f');
    await tick();
    expect(ui.lastFrame()).toContain('▸ ✻ main 思考');
    expect(ui.lastFrame()).not.toContain('先看看 a.ts');

    ui.stdin.write('\u000f');
    await tick();
    expect(ui.lastFrame()).toContain('先看看 a.ts');
  });

  it('prints a folded block and what /think asks for as plain lines in the line console', () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const view = createLineConsoleView(output);
    view.print({ kind: 'THINKING', text: '✻ main 思考 3.0s（/think 1 展开）' });
    view.update({ status: '', activity: [], waiting: 0, queued: [], thinking: [thinking('x')] });
    expect(chunks.join('')).toBe('✻ main 思考 3.0s（/think 1 展开）\n');
  });
});

describe('Ink console: the text being written', () => {
  it('draws what an agent is writing, the newest lines at the bottom, above the status', async () => {
    const { store, ui } = setup();
    store.update({
      status: '运行中',
      activity: [],
      waiting: 0,
      queued: [],
      writing: [{ id: 'exe_1', label: 'main', state: 'OPEN', text: '你好，\n这是正在写的回答' }],
    });
    await tick();
    const lines = (ui.lastFrame() ?? '').split('\n');
    const written = lines.findIndex((line) => line.includes('main: 你好，'));
    expect(written).toBeGreaterThanOrEqual(0);
    expect(lines[written + 1]).toContain('这是正在写的回答');
    expect(lines.findIndex((line) => line.includes('运行中'))).toBeGreaterThan(written);
  });

  it('gives the writing the lines first and the thinking what is left', () => {
    const lines = layoutWriting(
      [{ id: 'a', label: 'main', state: 'OPEN', text: 'one\ntwo\nthree\nfour' }],
      { columns: 40, budget: 3 },
    );
    expect(lines).toEqual(['two', 'three', 'four']);
    expect(layoutWriting([], { columns: 40, budget: 3 })).toEqual([]);
    expect(
      layoutWriting([{ id: 'a', label: 'main', state: 'OPEN', text: 'x' }], {
        columns: 40,
        budget: 0,
      }),
    ).toEqual([]);
  });
});

describe('Ink console: thinking among what happened', () => {
  const block = (number: number, text: string, state: 'OPEN' | 'DONE' = 'DONE'): ThinkingView => ({
    id: `exe_${String(number)}`,
    number,
    label: 'main',
    state,
    startedAt: new Date(Date.now() - 3000).toISOString(),
    ...(state === 'OPEN' ? {} : { endedAt: new Date().toISOString() }),
    text,
  });
  const live = (...blocks: ThinkingView[]) => ({
    status: '运行中',
    activity: [],
    waiting: 0,
    queued: [],
    thinking: blocks,
  });
  const order = (frame: string, ...needles: string[]) =>
    needles.map((needle) => frame.indexOf(needle));

  it('puts each thinking above the step that followed it, in the order it happened', async () => {
    const { store, ui } = setup();
    store.print({ kind: 'USER', text: '读一下 a.ts' });
    store.update(live(block(1, '先要读文件')));
    store.print({ kind: 'NOTICE', text: '已允许。' });
    store.print({ kind: 'STEP', text: '✓ read_file a.ts 0.1s' });
    store.update(live(block(1, '先要读文件'), block(2, '读完了，来总结', 'OPEN')));
    await tick();
    const frame = ui.lastFrame() ?? '';
    const [question, first, allowed, step, second] = order(
      frame,
      '> 读一下 a.ts',
      '先要读文件',
      '已允许。',
      '✓ read_file',
      '读完了，来总结',
    );
    expect(question).toBeGreaterThanOrEqual(0);
    expect([question, first, allowed, step, second]).toEqual(
      [question, first, allowed, step, second].sort((left, right) => (left ?? 0) - (right ?? 0)),
    );
    expect(new Set([question, first, allowed, step, second]).size).toBe(5);
  });

  it('keeps only the latest two thinkings open and folds the older ones to a line', async () => {
    const { store, ui } = setup();
    store.print({ kind: 'USER', text: '问题' });
    store.update(live(block(1, '第一段思考的内容')));
    store.print({ kind: 'STEP', text: '步骤一' });
    store.update(live(block(1, '第一段思考的内容'), block(2, '第二段思考的内容')));
    store.print({ kind: 'STEP', text: '步骤二' });
    store.update(
      live(
        block(1, '第一段思考的内容'),
        block(2, '第二段思考的内容'),
        block(3, '第三段思考的内容', 'OPEN'),
      ),
    );
    await tick();
    const frame = ui.lastFrame() ?? '';
    // The first one is a line now; the second and third are open with their text.
    expect(frame).toContain('✻ main 思考 3.0s（/think 1 展开）');
    expect(frame).not.toContain('第一段思考的内容');
    expect(frame).toContain('第二段思考的内容');
    expect(frame).toContain('第三段思考的内容');
    const [folded, firstStep, second, secondStep, third] = order(
      frame,
      '（/think 1 展开）',
      '步骤一',
      '第二段思考的内容',
      '步骤二',
      '第三段思考的内容',
    );
    expect([folded, firstStep, second, secondStep, third]).toEqual(
      [folded, firstStep, second, secondStep, third].sort((a, b) => (a ?? 0) - (b ?? 0)),
    );

    // A fourth pushes the second out in the same way.
    store.update(
      live(
        block(1, '第一段思考的内容'),
        block(2, '第二段思考的内容'),
        block(3, '第三段思考的内容'),
        block(4, '第四段思考的内容', 'OPEN'),
      ),
    );
    await tick();
    expect(ui.lastFrame()).toContain('（/think 2 展开）');
    expect(ui.lastFrame()).not.toContain('第二段思考的内容');
    expect(ui.lastFrame()).toContain('第三段思考的内容');
    expect(ui.lastFrame()).toContain('第四段思考的内容');
  });

  it('folds and opens the two open ones with Ctrl+O', async () => {
    const { store, ui } = setup();
    store.update(live(block(1, '甲的内容'), block(2, '乙的内容', 'OPEN')));
    await tick();
    expect(ui.lastFrame()).toContain('甲的内容');
    ui.stdin.write('\u000f');
    await tick();
    expect(ui.lastFrame()).not.toContain('甲的内容');
    expect(ui.lastFrame()).not.toContain('乙的内容');
    expect(ui.lastFrame()?.match(/▸ ✻ main 思考/gu)).toHaveLength(2);
    ui.stdin.write('\u000f');
    await tick();
    expect(ui.lastFrame()).toContain('甲的内容');
  });

  it('never draws more rows than the terminal has, by moving the oldest into the scroll-back', async () => {
    const { store, ui } = setup();
    store.update(live(block(1, '甲')));
    for (let index = 1; index <= 40; index += 1)
      store.print({ kind: 'STEP', text: `步骤 ${String(index)}` });
    await tick();
    await tick();
    // ink-testing-library has a terminal 100 columns wide and 24 rows high by default; the part
    // drawn in place has to fit, and the steps that left it are not lost.
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('步骤 1\n');
    expect(frame).toContain('步骤 40');
    const inPlace = frame.slice(
      frame.indexOf('✻ main 思考') < 0 ? 0 : frame.indexOf('▾ ✻ main 思考'),
    );
    expect(inPlace.split('\n').length).toBeLessThanOrEqual(24);
  });
});
