import type { ThinkingView } from '@multiagentos/user-interaction';
import { afterEach, describe, expect, it } from 'vitest';
import { createInkConsole } from './ink-console.js';
import {
  block,
  charWidth,
  connect,
  conversation,
  expectEveryReplyOnce,
  mounted,
  tick,
} from '../test-support/terminal-emulator.js';
import { setAmbiguousWidth } from './terminal-width.js';

afterEach(() => {
  mounted.unmount?.();
  setAmbiguousWidth('narrow');
});

describe('the conversation a terminal is left with', () => {
  it('has every reply once, however long, on a terminal that counts dashes and symbols as one column', async () => {
    expectEveryReplyOnce(await conversation(76, 30, false));
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
    mounted.unmount = () => instance.unmount();
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
    mounted.unmount = () => instance.unmount();
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

  it('stays at the end of a typed text that is longer than a row, with a long word in it', async () => {
    // Ink wraps by words: the long word used to move to the next row whole, and a cursor counted
    // for a cut at the edge was left in the middle of the text.
    const { terminal, stdin, stdout } = connect(40, 20, false);
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
    const text =
      '帮我搜索 DeepSeek 账户的速率是多少 为什么能实现同一个 Api key同时调用不同的对话不会矛盾吗然后回到';
    for (const character of text) stdin.write(character);
    await tick();
    const { row, column, rows } = terminal.cursor();
    const box = rows.slice(Math.max(0, row - 2), row + 1).map((each) => each.trimEnd());
    // Nothing is lost or reordered, and the first row has the prompt, the others the indent.
    expect(box.join('').replace(/\s+/gu, '').replace('›', '')).toContain(
      'Apikey同时调用不同的对话不会矛盾吗然后回到',
    );
    expect(rows[row]?.startsWith('  ')).toBe(true);
    // The cursor is just after the last character of the last row.
    expect(column).toBe(
      [...(rows[row]?.trimEnd() ?? '')].reduce(
        (sum, each) => sum + charWidth(each.codePointAt(0) ?? 0),
        0,
      ),
    );
  });

  it('takes a late answer of the terminal to the width probe for what it is, not for typing', async () => {
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
    mounted.unmount = () => instance.unmount();
    await tick();
    const escape = String.fromCharCode(27);
    for (let report = 0; report < 4; report += 1) stdin.write(`${escape}[1;2R`);
    await tick();
    stdin.write('a');
    await tick();
    const { row, rows } = terminal.cursor();
    expect(rows[row]).toBe('› a');
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
    mounted.unmount = () => instance.unmount();
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
