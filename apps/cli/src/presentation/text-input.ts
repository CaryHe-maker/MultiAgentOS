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
function linePosition(state: InputState): { readonly line: number; readonly lines: number } {
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

/**
 * Columns a character takes if the terminal is generous: the characters whose width depends on the
 * font and the locale (dashes and quotes, arrows, boxes, the symbols of dingbats) count as two.
 * The part of the screen that is drawn in place is cut to lines that fit by this measure, so that
 * a terminal that draws them wide still never wraps a line: a wrapped line takes a row more than
 * Ink counted, Ink then erases one row too few on the next frame, and a copy of the old frame
 * stays behind.
 */
export function safeCharWidth(codePoint: number): number {
  const width = charWidth(codePoint);
  if (width !== 1) return width;
  if (
    codePoint === 0x00a1 ||
    codePoint === 0x00a4 ||
    (codePoint >= 0x00a7 && codePoint <= 0x00ae) ||
    (codePoint >= 0x00b0 && codePoint <= 0x00bf) ||
    codePoint === 0x00d7 ||
    codePoint === 0x00f7 ||
    (codePoint >= 0x2010 && codePoint <= 0x2027) ||
    (codePoint >= 0x2030 && codePoint <= 0x205e) ||
    (codePoint >= 0x2100 && codePoint <= 0x23ff) ||
    (codePoint >= 0x2460 && codePoint <= 0x27bf) ||
    (codePoint >= 0xe000 && codePoint <= 0xf8ff)
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

/** Columns left unused at the right edge of the box, as for everything else drawn in place. */
const BOX_MARGIN = 2;

/** One screen row of the box: the part of the text it shows, and where that part is in the value. */
export interface BoxRow {
  /** `prefix` on the first row of the text, `continuation` on every other one. */
  readonly lead: string;
  /** The row shows `value.slice(start, end)`. */
  readonly start: number;
  readonly end: number;
  /** Whether the logical line goes on in the next row. */
  readonly wrapped: boolean;
}

const safeWidth = (text: string): number => {
  let width = 0;
  for (const character of text) width += safeCharWidth(character.codePointAt(0) ?? 0);
  return width;
};

/**
 * The box cut into the rows it is drawn as. The cut is made here, character by character by the
 * generous measure, and each row is drawn as it is, so that neither the terminal nor Ink wraps
 * anything: the row and column of the cursor computed from these rows are then where the text
 * really is. (Ink wraps by words: a long word goes to the next row whole, and a cursor computed
 * for a cut at the edge lands in the wrong place.)
 */
export function layoutBox(
  state: InputState,
  prefix: string,
  continuation: string,
  columns: number,
): BoxRow[] {
  const rows: BoxRow[] = [];
  const total = Math.max(4, columns - BOX_MARGIN);
  let offset = 0;
  for (const [index, line] of state.value.split('\n').entries()) {
    let lead = index === 0 ? prefix : continuation;
    let from = 0;
    let at = 0;
    let used = 0;
    for (const character of line) {
      const width = safeCharWidth(character.codePointAt(0) ?? 0);
      if (used + width > Math.max(2, total - safeWidth(lead)) && at > from) {
        rows.push({ lead, start: offset + from, end: offset + at, wrapped: true });
        lead = continuation;
        from = at;
        used = 0;
      }
      used += width;
      at += character.length;
    }
    rows.push({ lead, start: offset + from, end: offset + line.length, wrapped: false });
    offset += line.length + 1;
  }
  return rows;
}

/**
 * Where the terminal cursor belongs, counted from the top-left of the box, in the rows of
 * `layoutBox`. Where a long line was cut, the cursor is at the start of the next row.
 */
export function cursorCell(
  state: InputState,
  prefix: string,
  continuation: string,
  columns: number,
): { readonly row: number; readonly column: number } {
  const rows = layoutBox(state, prefix, continuation, columns);
  const found = rows.findIndex(
    (each) =>
      state.cursor >= each.start &&
      (state.cursor < each.end || (!each.wrapped && state.cursor === each.end)),
  );
  const row = found < 0 ? rows.length - 1 : found;
  const at = rows[row];
  if (at === undefined) return { row: 0, column: 0 };
  return {
    row,
    column: displayWidth(at.lead) + displayWidth(state.value.slice(at.start, state.cursor)),
  };
}

/** Rows the whole box takes. */
export function boxRows(
  state: InputState,
  prefix: string,
  continuation: string,
  columns: number,
): number {
  return layoutBox(state, prefix, continuation, columns).length;
}
