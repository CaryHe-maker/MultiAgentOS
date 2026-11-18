import { describe, expect, it } from 'vitest';
import {
  EMPTY_INPUT,
  backspace,
  boxHeight,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBefore,
  expand,
  inputOf,
  insert,
  insertPaste,
  layoutBox,
  left,
  lineEnd,
  lineStart,
  moveVertical,
  pasteLabel,
  right,
  viewBox,
  windowOf,
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
  const cell = (state: InputState, columns: number) => {
    const layout = layoutBox(state, lead, indent, columns);
    return { row: layout.cursorRow, column: layout.cursorColumn };
  };
  const rowsOf = (state: InputState, columns: number) =>
    layoutBox(state, lead, indent, columns).rows.length;

  it('stands after the prompt and the characters before it, wide ones counting two', () => {
    expect(cell(at('你好吗', 3), 80)).toEqual({ row: 0, column: 2 + 6 });
    expect(cell(at('你好吗', 2), 80)).toEqual({ row: 0, column: 2 + 4 });
  });

  it('is on the line of a box of several lines', () => {
    expect(cell(at('first\nsecond', 9), 80)).toEqual({ row: 1, column: 2 + 3 });
  });

  it('follows a line that is cut: the rest goes on under the text, not under the prompt', () => {
    // 20 columns less the margin of 2 and the lead of 2: 16 columns for the text.
    const value = `abc ${'x'.repeat(30)}`;
    const state = at(value, value.length);
    expect(rowsOf(state, 20)).toBe(3);
    expect(cell(state, 20)).toEqual({ row: 2, column: 2 + 2 });
  });

  it('puts the cursor at the start of the next row when the character under it does not fit', () => {
    expect(cell(at('x'.repeat(20), 16), 20)).toEqual({ row: 1, column: 2 });
  });

  it('counts an empty line as a row', () => {
    expect(rowsOf(at('a\n\nb', 0), 10)).toBe(3);
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

describe('a long paste', () => {
  const text = 'a paste of some length';
  const lines = ['first line here', 'second line here', 'third line here'].join('\n');

  it('is typed text up to fifteen characters and one placeholder beyond', () => {
    expect(insertPaste(EMPTY_INPUT, 'x'.repeat(15))).toEqual(at('x'.repeat(15), 15));
    const folded = insertPaste(EMPTY_INPUT, text);
    expect(folded.value).toHaveLength(1);
    expect(folded.cursor).toBe(1);
    expect(expand(folded)).toBe(text);
  });

  it('is drawn as a label with the lines of the paste, or its characters when it is one line', () => {
    expect(pasteLabel(lines)).toBe('[paste 3 lines]');
    expect(pasteLabel(text)).toBe(`[paste ${String(text.length)} chars]`);
    const state = insertPaste(inputOf('ab '), lines);
    const [only] = layoutBox(state, '› ', '  ', 80).rows;
    expect(`${only?.before ?? ''}${only?.under ?? ''}${only?.after ?? ''}`).toBe(
      // The last cell is the one the cursor stands on.
      'ab [paste 3 lines] ',
    );
  });

  it('is one step for the cursor and one deletion, wherever it is', () => {
    const folded = insertPaste(inputOf('ab '), lines);
    expect(left(folded).cursor).toBe(folded.cursor - 1);
    expect(backspace(folded).value).toBe('ab ');
    expect(backspace(folded).pastes).toBeDefined();
    const inside = { ...left(folded) };
    expect(deleteForward(inside).value).toBe('ab ');
    expect(deleteToLineStart(folded).value).toBe('');
    expect(deleteWordBefore(folded).value).toBe('ab ');
  });

  it('keeps its text for sending, with the typed text around it', () => {
    const state = insert(insertPaste(inputOf('before '), lines), ' after');
    expect(expand(state)).toBe(`before ${lines} after`);
  });

  it('is kept by every edit made around it', () => {
    let state = insertPaste(EMPTY_INPUT, lines);
    state = insert(state, 'x');
    state = insert(left(state), 'y');
    state = backspace(lineEnd(lineStart(lineEnd(state))));
    expect(expand(state)).toBe(`${lines}y`);
  });

  it('cannot be forged by typing the placeholder character', () => {
    const forged = insert(EMPTY_INPUT, String.fromCharCode(0xe000));
    expect(forged.value).toBe('');
    expect(expand(insertPaste(EMPTY_INPUT, `${String.fromCharCode(0xe000)}${text}`))).toBe(text);
  });

  it('has a window onto it when the box is higher than its height', () => {
    expect(boxHeight(40)).toBe(10);
    expect(boxHeight(14)).toBe(6);
    expect(boxHeight(5)).toBe(2);
    expect(boxHeight(1)).toBe(2);
  });
});

describe('the window onto a box that is too high', () => {
  it('shows all of a box that fits', () => {
    expect(windowOf(4, 3, 0, 10)).toEqual({
      top: 0,
      count: 4,
      hiddenAbove: false,
      hiddenBelow: false,
    });
  });

  it('shows the start with a marker below, and the end with a marker above', () => {
    expect(windowOf(30, 0, 0, 10)).toEqual({
      top: 0,
      count: 9,
      hiddenAbove: false,
      hiddenBelow: true,
    });
    expect(windowOf(30, 29, 0, 10)).toEqual({
      top: 21,
      count: 9,
      hiddenAbove: true,
      hiddenBelow: false,
    });
  });

  it('shows markers on both sides in the middle', () => {
    expect(windowOf(30, 15, 12, 10)).toEqual({
      top: 12,
      count: 8,
      hiddenAbove: true,
      hiddenBelow: true,
    });
  });

  it('stays where it is while the cursor is in it, and moves only as far as it must', () => {
    expect(windowOf(30, 15, 12, 10).top).toBe(12);
    expect(windowOf(30, 11, 12, 10).top).toBe(11);
    expect(windowOf(30, 22, 12, 10).top).toBe(15);
  });

  it('always shows a row of text, even in two rows', () => {
    for (let cursor = 0; cursor < 30; cursor += 1) {
      const window = windowOf(30, cursor, 0, 2);
      const shown = window.count + (window.hiddenAbove ? 1 : 0) + (window.hiddenBelow ? 1 : 0);
      expect(window.count).toBeGreaterThanOrEqual(1);
      expect(shown).toBeLessThanOrEqual(2);
      expect(cursor).toBeGreaterThanOrEqual(window.top);
      expect(cursor).toBeLessThan(window.top + window.count);
    }
  });

  it('is a view of the box with the cursor counted from what is drawn', () => {
    const value = Array.from({ length: 30 }, (_, index) => `line ${String(index)}`).join('\n');
    const view = viewBox(at(value, value.length), '› ', '  ', 80, 10, 0);
    expect(view.above).toBe(true);
    expect(view.below).toBe(false);
    expect(view.rows).toHaveLength(9);
    expect(view.shown).toBe(10);
    expect(view.cursorRow).toBe(9);
  });
});
