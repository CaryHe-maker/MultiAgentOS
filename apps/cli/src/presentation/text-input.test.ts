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
  inputOf,
  insert,
  left,
  lineEnd,
  lineStart,
  moveVertical,
  right,
  wrapLikeInk,
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
  const lead = '› ';
  const indent = '  ';

  it('stands after the prompt and the characters before it, wide ones counting two', () => {
    expect(cursorCell(at('你好吗', 3), lead, indent, 80)).toEqual({ row: 0, column: 2 + 6 });
    expect(cursorCell(at('你好吗', 2), lead, indent, 80)).toEqual({ row: 0, column: 2 + 4 });
  });

  it('is on the line of a box of several lines', () => {
    expect(cursorCell(at('first\nsecond', 9), lead, indent, 80)).toEqual({ row: 1, column: 2 + 3 });
  });

  it('follows a line that is cut: the rest goes on under the text, not under the prompt', () => {
    // 20 columns less the margin of 2 and the lead of 2: 16 columns for the text.
    const value = `abc ${'x'.repeat(30)}`;
    const state = at(value, value.length);
    expect(boxRows(state, lead, indent, 20)).toBe(3);
    expect(cursorCell(state, lead, indent, 20)).toEqual({ row: 2, column: 2 + 2 });
  });

  it('puts the cursor at the start of the next row when the character under it does not fit', () => {
    const state = at('x'.repeat(20), 16);
    expect(cursorCell(state, lead, indent, 20)).toEqual({ row: 1, column: 2 });
  });

  it('counts an empty line as a row', () => {
    expect(boxRows(at('a\n\nb', 0), lead, indent, 10)).toBe(3);
  });

  it('cuts exactly as Ink does: the same call on the same measure', () => {
    expect(wrapLikeInk('abc xxxxxxxxxxxxxxxxxxxxxxx', 10)).toEqual([
      'abc xxxxxx',
      'xxxxxxxxxx',
      'xxxxxxx',
    ]);
    expect(wrapLikeInk('你好你好你好', 5)).toEqual(['你好', '你好', '你好']);
    expect(wrapLikeInk('', 5)).toEqual(['']);
  });
});
