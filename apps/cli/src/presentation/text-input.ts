/**
 * The text of the input box and where the cursor is in it (docs/M2/Phase1Console.md 2.1, UI-2).
 * Pure functions, so the box can be tested without a terminal: `value` is the text, `cursor` an
 * index into it that always stands between two characters (never inside a surrogate pair), and
 * every function returns the next state.
 */

export interface InputState {
  readonly value: string;
  readonly cursor: number;
}

export const EMPTY_INPUT: InputState = { value: '', cursor: 0 };

/** The box holding `value`, with the cursor at its end (a message taken back, a history entry). */
export const inputOf = (value: string): InputState => ({ value, cursor: value.length });

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** Nearest index before `index` that is not inside a surrogate pair. */
function before(value: string, index: number): number {
  if (index <= 0) return 0;
  const previous = index - 1;
  return isLowSurrogate(value.charCodeAt(previous)) && previous > 0 ? previous - 1 : previous;
}

function after(value: string, index: number): number {
  if (index >= value.length) return value.length;
  return isHighSurrogate(value.charCodeAt(index)) && index + 1 < value.length
    ? index + 2
    : index + 1;
}

/** Text typed or pasted at the cursor; line ends become line feeds. */
export function insert(state: InputState, text: string): InputState {
  const clean = text.replace(/\r\n?/gu, '\n');
  return {
    value: state.value.slice(0, state.cursor) + clean + state.value.slice(state.cursor),
    cursor: state.cursor + clean.length,
  };
}

export function backspace(state: InputState): InputState {
  if (state.cursor === 0) return state;
  const from = before(state.value, state.cursor);
  return {
    value: state.value.slice(0, from) + state.value.slice(state.cursor),
    cursor: from,
  };
}

export function deleteForward(state: InputState): InputState {
  if (state.cursor >= state.value.length) return state;
  const to = after(state.value, state.cursor);
  return {
    value: state.value.slice(0, state.cursor) + state.value.slice(to),
    cursor: state.cursor,
  };
}

export const left = (state: InputState): InputState => ({
  ...state,
  cursor: before(state.value, state.cursor),
});

export const right = (state: InputState): InputState => ({
  ...state,
  cursor: after(state.value, state.cursor),
});

/** Start and end (exclusive of the line feed) of the line the cursor is on. */
function lineBounds(state: InputState): { readonly start: number; readonly end: number } {
  const start = state.value.lastIndexOf('\n', state.cursor - 1) + 1;
  const next = state.value.indexOf('\n', state.cursor);
  return { start, end: next < 0 ? state.value.length : next };
}

export const lineStart = (state: InputState): InputState => ({
  ...state,
  cursor: lineBounds(state).start,
});

export const lineEnd = (state: InputState): InputState => ({
  ...state,
  cursor: lineBounds(state).end,
});

/** Index of the line the cursor is on, and how many lines there are. */
export function linePosition(state: InputState): { readonly line: number; readonly lines: number } {
  const lines = state.value.split('\n').length;
  const line = state.value.slice(0, state.cursor).split('\n').length - 1;
  return { line, lines };
}

/** One line up or down, to the same column when the line is long enough; false at the edge. */
export function moveVertical(state: InputState, direction: -1 | 1): InputState | undefined {
  const { line, lines } = linePosition(state);
  const target = line + direction;
  if (target < 0 || target >= lines) return undefined;
  const parts = state.value.split('\n');
  const column = state.cursor - lineBounds(state).start;
  let start = 0;
  for (let index = 0; index < target; index += 1) start += (parts[index]?.length ?? 0) + 1;
  const length = parts[target]?.length ?? 0;
  return { ...state, cursor: start + Math.min(column, length) };
}

/** Ctrl+U: everything before the cursor on its line. */
export function deleteToLineStart(state: InputState): InputState {
  const { start } = lineBounds(state);
  return {
    value: state.value.slice(0, start) + state.value.slice(state.cursor),
    cursor: start,
  };
}

/** Ctrl+K: everything after the cursor on its line. */
export function deleteToLineEnd(state: InputState): InputState {
  const { end } = lineBounds(state);
  return {
    value: state.value.slice(0, state.cursor) + state.value.slice(end),
    cursor: state.cursor,
  };
}

/** Ctrl+W: the word before the cursor, and the spaces between. */
export function deleteWordBefore(state: InputState): InputState {
  let from = state.cursor;
  while (from > 0 && /\s/u.test(state.value[from - 1] ?? '')) from -= 1;
  while (from > 0 && !/\s/u.test(state.value[from - 1] ?? '')) from -= 1;
  return { value: state.value.slice(0, from) + state.value.slice(state.cursor), cursor: from };
}

/** Columns a character takes in a terminal: 0 for combining marks, 2 for wide ones, else 1. */
export function charWidth(codePoint: number): number {
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  )
    return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Columns `text` takes on one terminal line. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += charWidth(character.codePointAt(0) ?? 0);
  return width;
}

/** Rows a line of `width` columns takes when the terminal is `columns` wide (an empty line takes one). */
export const rowsOf = (width: number, columns: number): number =>
  Math.max(1, Math.ceil(width / Math.max(1, columns)));

/**
 * Where the terminal cursor belongs, counted from the top-left of the box: the box is drawn after
 * `prefix` on its first line and after `continuation` on the others, and a line longer than the
 * terminal is wrapped, so a row is a screen row and not a line of the text.
 */
export function cursorCell(
  state: InputState,
  prefix: string,
  continuation: string,
  columns: number,
): { readonly row: number; readonly column: number } {
  const parts = state.value.split('\n');
  const { line } = linePosition(state);
  let row = 0;
  for (let index = 0; index < line; index += 1)
    row += rowsOf(
      displayWidth(index === 0 ? prefix : continuation) + displayWidth(parts[index] ?? ''),
      columns,
    );
  const before = state.value.slice(lineBounds(state).start, state.cursor);
  const offset = displayWidth(line === 0 ? prefix : continuation) + displayWidth(before);
  return {
    row: row + Math.floor(offset / Math.max(1, columns)),
    column: offset % Math.max(1, columns),
  };
}

/** Rows the whole box takes. */
export function boxRows(
  state: InputState,
  prefix: string,
  continuation: string,
  columns: number,
): number {
  return state.value
    .split('\n')
    .reduce(
      (sum, line, index) =>
        sum +
        rowsOf(displayWidth(index === 0 ? prefix : continuation) + displayWidth(line), columns),
      0,
    );
}
