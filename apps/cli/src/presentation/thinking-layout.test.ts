import type { ThinkingView, TranscriptRecord } from '@multiagentos/user-interaction';
import { describe, expect, it } from 'vitest';
import type { TailItem } from './console-store.js';
import { safeCharWidth } from './text-input.js';
import {
  blockLines,
  layoutWriting,
  planTail,
  recordLines,
  recordRows,
  wrapLines,
} from './thinking-layout.js';

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
});

describe('blockLines', () => {
  it('shows a header with the time and the last lines of the text under it', () => {
    const lines = blockLines(block(1, 'first\nsecond\nthird'), { ...options, bodyLines: 2 });
    expect(lines.map((line) => line.text)).toEqual(['▾ ✻ main 思考 3.2s', '  second', '  third']);
    expect(lines[0]?.kind).toBe('HEADER');
  });

  it('counts the time of a block that is still streaming up to now', () => {
    const lines = blockLines(block(1, 'x', 'OPEN'), { ...options, bodyLines: 5 });
    expect(lines[0]).toMatchObject({ text: '▾ ✻ main 思考 5.0s', live: true });
  });

  it('is the header only when folded or when it has no lines to show', () => {
    expect(
      blockLines(block(1, 'one\ntwo'), { ...options, folded: true, bodyLines: 5 }).map(
        (line) => line.text,
      ),
    ).toEqual(['▸ ✻ main 思考 3.2s']);
    expect(blockLines(block(1, 'one'), { ...options, bodyLines: 0 })).toHaveLength(1);
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
  it('keeps the order of what happened: thinking, then the step, then the next thinking', () => {
    const tail = [
      blockItem(block(1, 'a1\na2'), 1),
      record('NOTICE', '已允许。', 2),
      record('STEP', '✓ read_file 0.1s', 3),
      blockItem(block(2, 'b1'), 4),
    ];
    const plan = planTail(tail, { ...options, room: 20 });
    expect(plan.items.map((item) => item.kind)).toEqual(['BLOCK', 'RECORD', 'RECORD', 'BLOCK']);
    expect(plan.items.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(plan.commitBefore).toBeUndefined();
  });

  it('gives the rows that are left to the text of the newest block first', () => {
    const tail = [
      blockItem(block(1, 'a1\na2\na3\na4'), 1),
      record('STEP', '✓ step', 2),
      blockItem(block(2, 'b1\nb2\nb3'), 3),
    ];
    // 2 headers + 1 record = 3 rows; 4 rows are left: 3 for the newest, 1 for the older one.
    const plan = planTail(tail, { ...options, room: 7 });
    const [older, , newer] = plan.items;
    expect(newer?.kind === 'BLOCK' ? newer.lines.map((line) => line.text) : []).toEqual([
      '▾ ✻ main 思考 3.2s',
      '  b1',
      '  b2',
      '  b3',
    ]);
    expect(older?.kind === 'BLOCK' ? older.lines.map((line) => line.text) : []).toEqual([
      '▾ ✻ main 思考 3.2s',
      '  a4',
    ]);
    expect(plan.rows).toBe(7);
  });

  it('shows only the headers when folded', () => {
    const plan = planTail([blockItem(block(1, 'a\nb'), 1), blockItem(block(2, 'c\nd'), 2)], {
      ...options,
      room: 20,
      folded: true,
    });
    expect(plan.rows).toBe(2);
  });

  it('keeps the newest items that fit and sends the older ones to the scroll-back', () => {
    const tail = [
      blockItem(block(1, 'x'), 1),
      record('REPLY', 'a long reply\nof several\nlines', 2),
      blockItem(block(2, 'y'), 3),
    ];
    // Header 1 + three-line reply + header 1 = 5 rows.
    const fits = planTail(tail, { ...options, room: 5 });
    expect(fits.commitBefore).toBeUndefined();
    expect(fits.items.map((item) => item.seq)).toEqual([1, 2, 3]);
    // With 4 rows the oldest does not fit: it is not drawn, and it goes into the scroll-back.
    const short = planTail(tail, { ...options, room: 4 });
    expect(short.items.map((item) => item.seq)).toEqual([2, 3]);
    expect(short.commitBefore).toBe(2);
    expect(short.rows).toBeLessThanOrEqual(4);
  });

  it('commits everything when not even the newest item fits, and what comes later is new', () => {
    const long = Array.from({ length: 30 }, (_, index) => `line ${String(index)}`).join('\n');
    const tail = [record('USER', 'question', 5), record('REPLY', long, 6)];
    const plan = planTail(tail, { ...options, room: 10 });
    expect(plan.items).toEqual([]);
    expect(plan.rows).toBe(0);
    // Every item has a number below this; the next one that comes has this number or more.
    expect(plan.commitBefore).toBe(7);
  });

  it('never gives a frame more rows than it was allowed', () => {
    for (let room = 0; room <= 12; room += 1) {
      const tail = [
        blockItem(block(1, 'a\nb\nc\nd\ne'), 1),
        record('STEP', 'step', 2),
        record('REPLY', 'x\ny\nz\nw', 3),
        blockItem(block(2, 'f\ng\nh\ni\nj'), 4),
      ];
      expect(planTail(tail, { ...options, room }).rows).toBeLessThanOrEqual(room);
    }
  });

  it('cuts a record to lines with the prefix of its kind, and counts the rows from them', () => {
    expect(recordRows({ kind: 'USER', text: 'hi' }, 40)).toBe(1);
    expect(recordRows({ kind: 'REPLY', agentLabel: 'main', text: 'a\nb' }, 40)).toBe(2);
    // 38 columns are usable of 40 (two stay free at the right edge).
    expect(recordRows({ kind: 'NOTICE', text: 'x'.repeat(85) }, 40)).toBe(3);
    expect(recordLines({ kind: 'USER', text: 'hi' }, 40)).toEqual(['> hi']);
  });

  it('counts dashes, quotes and symbols as wide, so a terminal that draws them wide never wraps a line', () => {
    // 20 em dashes are 20 columns when narrow and 40 when wide: they have to be cut for the wide
    // measure, or the terminal would wrap the line and Ink would erase one row too few.
    const lines = recordLines({ kind: 'NOTICE', text: '—'.repeat(20) }, 30);
    expect(lines.length).toBe(2);
    for (const line of lines)
      expect(
        [...line].reduce((sum, ch) => sum + safeCharWidth(ch.codePointAt(0) ?? 0), 0),
      ).toBeLessThanOrEqual(28);
    expect(safeCharWidth(0x2014)).toBe(2);
    expect(safeCharWidth(0x201c)).toBe(2);
    expect(safeCharWidth(0x2713)).toBe(2);
    expect(safeCharWidth(0x41)).toBe(1);
    expect(safeCharWidth(0x4f60)).toBe(2);
  });
});

describe('layoutWriting', () => {
  it('gives the newest lines of what is being written, with the label like the message', () => {
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
