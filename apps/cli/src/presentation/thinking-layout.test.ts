import type { ThinkingView } from '@multiagentos/user-interaction';
import { describe, expect, it } from 'vitest';
import { layoutThinking, wrapLines } from './thinking-layout.js';

const block = (id: string, text: string, state: ThinkingView['state'] = 'DONE'): ThinkingView => ({
  id,
  label: 'main',
  turn: 1,
  state,
  startedAt: '2026-11-07T10:00:00.000Z',
  ...(state === 'OPEN' ? {} : { endedAt: '2026-11-07T10:00:03.200Z' }),
  text,
});

const NOW = Date.parse('2026-11-07T10:00:05.000Z');
const lay = (blocks: ThinkingView[], budget: number, folded = false) =>
  layoutThinking(blocks, { now: NOW, columns: 40, budget, folded });

describe('wrapLines', () => {
  it('keeps line breaks and cuts what is too wide, counting wide characters as two', () => {
    expect(wrapLines('ab\ncd', 10)).toEqual(['ab', 'cd']);
    expect(wrapLines('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapLines('你好吗啊', 4)).toEqual(['你好', '吗啊']);
    expect(wrapLines('', 4)).toEqual(['']);
  });
});

describe('layoutThinking', () => {
  it('shows a header with the time and the text under it', () => {
    const lines = lay([block('a', 'first\nsecond')], 10);
    expect(lines.map((line) => line.text)).toEqual(['▾ ✻ main 思考 3.2s', '  first', '  second']);
    expect(lines[0]?.kind).toBe('HEADER');
  });

  it('counts the time of a block that is still streaming up to now', () => {
    const lines = lay([block('a', 'x', 'OPEN')], 10);
    expect(lines[0]).toMatchObject({ text: '▾ ✻ main 思考 5.0s', live: true });
  });

  it('shows the header only when folded', () => {
    const lines = lay([block('a', 'one\ntwo')], 10, true);
    expect(lines.map((line) => line.text)).toEqual(['▸ ✻ main 思考 3.2s']);
  });

  it('gives what is left of the budget to the tail of the newest block', () => {
    const lines = lay([block('old', 'o1\no2\no3'), block('new', 'n1\nn2\nn3\nn4')], 5);
    // Both blocks get a header; what is left (3 lines) goes to the tail of the newest one.
    expect(lines.map((line) => line.text)).toEqual([
      '▾ ✻ main 思考 3.2s',
      '▾ ✻ main 思考 3.2s',
      '  n2',
      '  n3',
      '  n4',
    ]);
  });

  it('says how many older blocks did not fit', () => {
    const lines = lay([block('a', 'a1'), block('b', 'b1'), block('c', 'c1')], 2);
    expect(lines.map((line) => line.kind)).toEqual(['NOTE', 'HEADER', 'HEADER']);
    expect(lines[0]?.text).toBe('… 还有 1 段更早的思考（/think 查看）');
  });

  it('gives every block a header before any block a body, when room is short', () => {
    const lines = lay([block('a', 'a1'), block('b', 'b1'), block('c', 'c1')], 3);
    expect(lines.filter((line) => line.kind === 'HEADER')).toHaveLength(3);
    expect(lines.filter((line) => line.kind === 'BODY')).toHaveLength(0);
  });

  it('draws nothing when there is no room', () => {
    expect(lay([block('a', 'x')], 0).map((line) => line.kind)).toEqual(['NOTE']);
    expect(lay([], 10)).toEqual([]);
  });
});
