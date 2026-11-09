import type { ThinkingView, TranscriptRecord } from '@multiagentos/user-interaction';
import { describe, expect, it } from 'vitest';
import type { TailItem } from './console-store.js';
import stringWidth from 'string-width';
import { setAmbiguousWidth } from './terminal-width.js';
import { blockLines, planTail, recordLines, recordRows, wrapLines } from './thinking-layout.js';

const lines = (count: number, prefix = 'line'): string =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1)}`).join('\n');

const block = (
  number: number,
  text: string,
  state: ThinkingView['state'] = 'DONE',
): ThinkingView => ({
  id: `exe_${String(number)}`,
  number,
  label: 'main',
  state,
  startedAt: '2026-11-07T10:00:00.000Z',
  ...(state === 'OPEN' ? {} : { endedAt: '2026-11-07T10:00:03.200Z' }),
  text,
});

const NOW = Date.parse('2026-11-07T10:00:05.000Z');
const options = { now: NOW, columns: 40, folded: false };

describe('wrapLines', () => {
  it('keeps line breaks and cuts what is too wide, counting wide characters as two', () => {
    expect(wrapLines('ab\ncd', 10)).toEqual(['ab', 'cd']);
    expect(wrapLines('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapLines('你好吗啊', 4)).toEqual(['你好', '吗啊']);
    expect(wrapLines('', 4)).toEqual(['']);
  });

  it('cuts before a word instead of through it, when the word fits on a line of its own', () => {
    expect(wrapLines('hello world foo', 11)).toEqual(['hello world', 'foo']);
    expect(wrapLines('think about the following problem', 12)).toEqual([
      'think about',
      'the',
      'following',
      'problem',
    ]);
    // A word longer than the line has no choice.
    expect(wrapLines('say supercalifragilistic now', 8)).toEqual([
      'say',
      'supercal',
      'ifragili',
      'stic now',
    ]);
  });
});

describe('blockLines', () => {
  it('shows a header with the time and the last lines of the text under it', () => {
    const shown = blockLines(block(1, 'first\nsecond\nthird'), { ...options, bodyLines: 2 });
    expect(shown.map((line) => line.text)).toEqual(['▾ ✻ main 思考 3.2s', '  second', '  third']);
    expect(shown[0]?.kind).toBe('HEADER');
  });

  it('counts the time of a block that is still streaming up to now', () => {
    const shown = blockLines(block(1, 'x', 'OPEN'), { ...options, bodyLines: 5 });
    expect(shown[0]).toMatchObject({ text: '▾ ✻ main 思考 5.0s' });
  });

  it('is the header only when folded', () => {
    expect(
      blockLines(block(1, 'one\ntwo'), { ...options, folded: true, bodyLines: 5 }).map(
        (line) => line.text,
      ),
    ).toEqual(['▸ ✻ main 思考 3.2s']);
  });

  it('puts … where the beginning was left out', () => {
    const shown = blockLines(block(1, lines(10)), { ...options, bodyLines: 2, elided: true });
    expect(shown.map((line) => line.text)).toEqual([
      '▾ ✻ main 思考 3.2s',
      '  …',
      '  line9',
      '  line10',
    ]);
  });
});

const record = (kind: TranscriptRecord['kind'], text: string, seq: number): TailItem => ({
  kind: 'RECORD',
  seq,
  record: { kind, text } as TranscriptRecord,
});
const blockItem = (view: ThinkingView, seq: number): TailItem => ({
  kind: 'BLOCK',
  seq,
  block: view,
});

describe('planTail', () => {
  it('shows everything in full, in the order it happened, when it fits', () => {
    const tail = [
      blockItem(block(1, 'a1\na2'), 1),
      record('NOTICE', '已允许。', 2),
      record('STEP', '✓ read_file 0.1s', 3),
      blockItem(block(2, 'b1'), 4),
    ];
    const plan = planTail(tail, { ...options, limit: 20 });
    expect(plan.items.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(plan.items.map((item) => item.kind)).toEqual(['BLOCK', 'RECORD', 'RECORD', 'BLOCK']);
    // 2 headers, 3 lines of text, 2 records.
    expect(plan.rows).toBe(7);
    expect(plan.commitBefore).toBeUndefined();
    expect(plan.fold).toEqual([]);
    expect(plan.elided).toEqual([]);
  });

  it('keeps an earlier thinking open as long as everything fits, however many there are', () => {
    const tail = [1, 2, 3].map((number) => blockItem(block(number, lines(2)), number));
    const plan = planTail(tail, { ...options, limit: 12 });
    expect(plan.fold).toEqual([]);
    expect(plan.items).toHaveLength(3);
    expect(plan.rows).toBe(9);
  });

  it('folds the oldest open thinking when everything together would be too tall', () => {
    const tail = [
      blockItem(block(1, lines(5, 'a')), 1),
      record('STEP', '✓ step', 2),
      blockItem(block(2, lines(5, 'b')), 3),
    ];
    // In full: 6 + 1 + 6 = 13 rows; with room for 10 the first one has to go.
    const plan = planTail(tail, { ...options, limit: 10 });
    expect(plan.fold).toEqual(['exe_1']);
    // What came before the second block goes with it into the scroll-back.
    expect(plan.commitBefore).toBe(3);
    expect(plan.items.map((item) => item.seq)).toEqual([3]);
    expect(plan.elided).toEqual([]);
    expect(plan.rows).toBe(6);
  });

  it('folds the oldest ones one after the other until the rest fits', () => {
    const tail = [1, 2, 3, 4].map((number) => blockItem(block(number, lines(4)), number));
    // Each takes 5 rows; room for 11 holds two.
    const plan = planTail(tail, { ...options, limit: 11 });
    expect(plan.fold).toEqual(['exe_1', 'exe_2']);
    expect(plan.items.map((item) => item.seq)).toEqual([3, 4]);
    expect(plan.commitBefore).toBe(3);
  });

  it('never folds the newest open thinking for its size: it is cut at the beginning instead', () => {
    const tail = [blockItem(block(1, lines(30)), 1)];
    const plan = planTail(tail, { ...options, limit: 10 });
    expect(plan.fold).toEqual([]);
    expect(plan.elided).toEqual(['exe_1']);
    const [item] = plan.items;
    const shown = item?.kind === 'BLOCK' ? item.lines.map((line) => line.text) : [];
    // Header, …, and the last 8 lines: the whole thing is the 10 rows it was allowed.
    expect(shown).toEqual([
      '▾ ✻ main 思考 3.2s',
      '  …',
      ...Array.from({ length: 8 }, (_, index) => `  line${String(index + 23)}`),
    ]);
    expect(plan.rows).toBe(10);
  });

  it('folds the older one first and cuts the newest only if that is not enough', () => {
    const tail = [blockItem(block(1, lines(8)), 1), blockItem(block(2, lines(30)), 2)];
    const plan = planTail(tail, { ...options, limit: 10 });
    expect(plan.fold).toEqual(['exe_1']);
    expect(plan.elided).toEqual(['exe_2']);
    expect(plan.rows).toBe(10);
    expect(plan.items.map((item) => item.seq)).toEqual([2]);
  });

  it('counts what stands between and after the blocks in the rows the text may take', () => {
    const tail = [
      blockItem(block(1, lines(20)), 1),
      record('STEP', '✓ one', 2),
      record('NOTICE', 'two\nlines', 3),
    ];
    const plan = planTail(tail, { ...options, limit: 12 });
    // 3 rows of records, a header and a … line leave 7 lines of text.
    expect(plan.rows).toBe(12);
    const [item] = plan.items;
    expect(item?.kind === 'BLOCK' ? item.lines.length : 0).toBe(9);
  });

  it('shows the headers only when folded with Ctrl+O', () => {
    const plan = planTail([blockItem(block(1, 'a\nb'), 1), blockItem(block(2, 'c\nd'), 2)], {
      ...options,
      limit: 20,
      folded: true,
    });
    expect(plan.rows).toBe(2);
    expect(plan.fold).toEqual([]);
  });

  it('keeps the newest items that fit and sends the older ones to the scroll-back', () => {
    const tail = [
      blockItem(block(1, 'x'), 1),
      record('REPLY', 'a long reply\nof several\nlines', 2),
      blockItem(block(2, 'y'), 3),
    ];
    const fits = planTail(tail, { ...options, limit: 7 });
    expect(fits.commitBefore).toBeUndefined();
    expect(fits.items.map((item) => item.seq)).toEqual([1, 2, 3]);
    // With 4 rows the oldest does not fit even as a header: it goes into the scroll-back.
    const short = planTail(tail, { ...options, limit: 4 });
    expect(short.items.map((item) => item.seq)).toEqual([2, 3]);
    expect(short.commitBefore).toBe(2);
    expect(short.rows).toBeLessThanOrEqual(4);
  });

  it('commits everything when not even the newest item fits, and what comes later is new', () => {
    const tail = [record('USER', 'question', 5), record('REPLY', lines(30), 6)];
    const plan = planTail(tail, { ...options, limit: 10 });
    expect(plan.items).toEqual([]);
    expect(plan.rows).toBe(0);
    // Every item has a number below this; the next one that comes has this number or more.
    expect(plan.commitBefore).toBe(7);
  });

  it('never gives a frame more rows than it was allowed', () => {
    for (let limit = 0; limit <= 25; limit += 1) {
      const tail = [
        blockItem(block(1, lines(9)), 1),
        record('STEP', 'step', 2),
        record('REPLY', 'x\ny\nz\nw', 3),
        blockItem(block(2, lines(12)), 4),
        blockItem(block(3, lines(20), 'OPEN'), 5),
      ];
      expect(
        planTail(tail, { ...options, limit }).rows,
        `limit ${String(limit)}`,
      ).toBeLessThanOrEqual(limit);
    }
  });

  it('cuts a record to lines with the prefix of its kind, and counts the rows from them', () => {
    expect(recordRows({ kind: 'USER', text: 'hi' }, 40)).toBe(1);
    expect(recordRows({ kind: 'REPLY', agentLabel: 'main', text: 'a\nb' }, 40)).toBe(2);
    // 38 columns are usable of 40 (two stay free at the right edge).
    expect(recordRows({ kind: 'NOTICE', text: 'x'.repeat(85) }, 40)).toBe(3);
    expect(recordLines({ kind: 'USER', text: 'hi' }, 40)).toEqual(['> hi']);
  });

  it('cuts by the ruler of the terminal in use: a wide terminal gets shorter lines', () => {
    const dashes = { kind: 'NOTICE', text: '—'.repeat(20) } as const;
    expect(recordLines(dashes, 30)).toHaveLength(1);
    setAmbiguousWidth('wide');
    try {
      const cut = recordLines(dashes, 30);
      expect(cut).toHaveLength(2);
      for (const line of cut) expect(stringWidth(line)).toBeLessThanOrEqual(28);
    } finally {
      setAmbiguousWidth('narrow');
    }
  });
});
