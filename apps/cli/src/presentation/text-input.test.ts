import { describe, expect, it } from 'vitest';
import {
  EMPTY_INPUT,
  backspace,
  boxRows,
  cursorCell,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBefore,
  displayWidth,
  layoutBox,
  inputOf,
  insert,
  left,
  lineEnd,
  lineStart,
  moveVertical,
  right,
  type InputState,
} from './text-input.js';

const at = (value: string, cursor: number): InputState => ({ value, cursor });

describe('the input box', () => {
  it('types and pastes at the cursor, not only at the end', () => {
    expect(insert(at('hello', 2), 'XY')).toEqual(at('heXYllo', 4));
    expect(insert(EMPTY_INPUT, 'a\r\nb\rc')).toEqual(at('a\nb\nc', 5));
  });

  it('moves the cursor and edits where it stands', () => {
    expect(left(at('abc', 3)).cursor).toBe(2);
    expect(left(at('abc', 0)).cursor).toBe(0);
    expect(right(at('abc', 3)).cursor).toBe(3);
    expect(backspace(at('abc', 2))).toEqual(at('ac', 1));
    expect(backspace(at('abc', 0))).toEqual(at('abc', 0));
    expect(deleteForward(at('abc', 1))).toEqual(at('ac', 1));
    expect(deleteForward(at('abc', 3))).toEqual(at('abc', 3));
  });

  it('treats a character outside the basic plane as one character', () => {
    const smile = '😀';
    expect(smile).toHaveLength(2);
    expect(left(at(`a${smile}`, 3)).cursor).toBe(1);
    expect(right(at(`${smile}a`, 0)).cursor).toBe(2);
    expect(backspace(at(`a${smile}`, 3))).toEqual(at('a', 1));
    expect(deleteForward(at(`${smile}a`, 0))).toEqual(at('a', 0));
  });

  it('goes to the start and the end of the line it is on', () => {
    const state = at('one\ntwo three\nfour', 8);
    expect(lineStart(state).cursor).toBe(4);
    expect(lineEnd(state).cursor).toBe(13);
  });

  it('moves between lines to the same column, and says when there is no line', () => {
    const state = at('abcdef\nxy\nlonger line', 5);
    const down = moveVertical(state, 1);
    expect(down).toEqual(at(state.value, 9));
    expect(moveVertical(down ?? state, 1)?.cursor).toBe(12);
    expect(moveVertical(at('single', 3), -1)).toBeUndefined();
    expect(moveVertical(at('single', 3), 1)).toBeUndefined();
  });

  it('deletes to the start or end of the line, and the word before the cursor', () => {
    expect(deleteToLineStart(at('one\ntwo three', 9))).toEqual(at('one\nhree', 4));
    expect(deleteToLineEnd(at('one two\nx', 3))).toEqual(at('one\nx', 3));
    expect(deleteWordBefore(at('keep this word', 14))).toEqual(at('keep this ', 10));
    expect(deleteWordBefore(at('keep   ', 7))).toEqual(at('', 0));
  });

  it('puts a message taken back at its end', () => {
    expect(inputOf('again')).toEqual(at('again', 5));
  });
});

describe('where the terminal cursor goes', () => {
  it('counts wide characters as two columns, so the input window opens at the right place', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('你好')).toBe(4);
    expect(displayWidth('é')).toBe(1);
    const state = at('你好吗', 6);
    expect(cursorCell(state, '› ', '  ', 80)).toEqual({ row: 0, column: 2 + 6 });
    expect(cursorCell(at('你好吗', 2), '› ', '  ', 80)).toEqual({ row: 0, column: 2 + 4 });
  });

  it('is on the line of a box of several lines', () => {
    const state = at('first\nsecond', 9);
    expect(cursorCell(state, '› ', '  ', 80)).toEqual({ row: 1, column: 2 + 3 });
  });

  it('follows a line that wraps at the edge of the terminal', () => {
    const state = at('x'.repeat(25), 25);
    // A 10-wide screen leaves 8 columns; the generous measure counts › as 2,
    // so the first row holds 5 characters (the prompt counts 3) and the others 6: 25 characters make 5 rows.
    expect(boxRows(state, '› ', '  ', 10)).toBe(5);
    expect(cursorCell(state, '› ', '  ', 10)).toEqual({ row: 4, column: 2 + 2 });
    expect(boxRows(at('a\n\nb', 0), '› ', '  ', 10)).toBe(3);
  });

  it('cuts by characters, never by words, and puts the rest under an indent', () => {
    const value = `abc ${'x'.repeat(30)}`;
    const rows = layoutBox(at(value, value.length), '› ', '  ', 20);
    // The first row holds 15 columns after the prompt, the others 16: the long word does not move to the next row whole.
    expect(rows.map((row) => value.slice(row.start, row.end))).toEqual([
      'abc xxxxxxxxxxx',
      'xxxxxxxxxxxxxxxx',
      'xxx',
    ]);
    expect(rows.map((row) => row.lead)).toEqual(['› ', '  ', '  ']);
  });

  it('puts the cursor at the start of the next row where a line was cut', () => {
    const state = at('x'.repeat(20), 15);
    const rows = layoutBox(state, '› ', '  ', 20);
    expect(rows).toHaveLength(2);
    expect(cursorCell(state, '› ', '  ', 20)).toEqual({ row: 1, column: 2 });
  });

  it('keeps the cursor on the row of a CJK line that is cut', () => {
    const value = '你好'.repeat(10);
    const state = at(value, value.length);
    const { row, column } = cursorCell(state, '› ', '  ', 20);
    const rows = layoutBox(state, '› ', '  ', 20);
    expect(row).toBe(rows.length - 1);
    const last = rows.at(-1);
    expect(column).toBe(2 + displayWidth(value.slice(last?.start, value.length)));
  });
});
