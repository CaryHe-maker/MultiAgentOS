import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

const NEWLINE = '\n';

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

/**
 * Columns left unused at the right edge of the box, as for everything else drawn in place: a
 * terminal that draws a symbol wider than `string-width` counts it still has room for it.
 */
export const BOX_MARGIN = 2;

/**
 * The text cut into rows exactly as Ink cuts a `<Text wrap="hard">` that is `width` columns wide:
 * the same call, with the same options, as `wrapText` in Ink (`build/wrap-text.js`), on the same
 * measure of width (`string-width`, which `wrap-ansi` uses). Nothing here is a model of Ink: when
 * Ink changes how it wraps, the test that draws the box with Ink and compares the rows fails.
 */
export function wrapLikeInk(text: string, width: number): string[] {
  // Ink leaves a text with no room as it is, and gives a fraction of a column one whole column.
  if (width <= 0) return text.split(NEWLINE);
  return wrapAnsi(text, Math.max(1, width), { trim: false, hard: true, wordWrap: false }).split(
    NEWLINE,
  );
}

/** What the box draws for one line of its text: the lead, and the text with the cursor in it. */
export interface BoxLine {
  readonly lead: string;
  /** The text before the cursor, the character under it (a space at the end) and the rest. */
  readonly before: string;
  readonly under: string;
  readonly after: string;
  /** Whether the cursor is on this line. */
  readonly here: boolean;
}

/** The lines of the box as they are drawn; the cursor line carries the cell the cursor stands on. */
export function boxLines(state: InputState, prefix: string, continuation: string): BoxLine[] {
  const lines: BoxLine[] = [];
  let start = 0;
  for (const [index, line] of state.value.split(NEWLINE).entries()) {
    const lead = index === 0 ? prefix : continuation;
    const here = state.cursor >= start && state.cursor <= start + line.length;
    if (here) {
      const column = state.cursor - start;
      const real = [...line.slice(column)][0];
      lines.push({
        lead,
        before: line.slice(0, column),
        under: real ?? ' ',
        after: real === undefined ? '' : line.slice(column + real.length),
        here,
      });
    } else lines.push({ lead, before: line, under: '', after: '', here });
    start += line.length + 1;
  }
  return lines;
}

/** The width of the text beside the lead: what is left of the box after it, as Ink lays it out. */
const textWidth = (lead: string, columns: number): number =>
  columns - BOX_MARGIN - stringWidth(lead);

const textOf = (line: BoxLine): string => `${line.before}${line.under}${line.after}`;

/** Rows the whole box takes: the rows each line is cut into, and a line is at least one row. */
export function boxRows(
  state: InputState,
  prefix: string,
  continuation: string,
  columns: number,
): number {
  return boxLines(state, prefix, continuation).reduce(
    (sum, line) => sum + wrapLikeInk(textOf(line), textWidth(line.lead, columns)).length,
    0,
  );
}

/**
 * Where the terminal cursor belongs, counted from the top-left of the box: the row, and the column
 * of the first cell of the character under the cursor. The text before the cursor is cut the way
 * Ink cuts the whole line (cutting is sequential, so a prefix is cut like the beginning of the
 * whole); if the character under the cursor does not fit on that row it starts the next one.
 */
export function cursorCell(
  state: InputState,
  prefix: string,
  continuation: string,
  columns: number,
): { readonly row: number; readonly column: number } {
  let row = 0;
  for (const line of boxLines(state, prefix, continuation)) {
    const width = textWidth(line.lead, columns);
    if (!line.here) {
      row += wrapLikeInk(line.before, width).length;
      continue;
    }
    const before = wrapLikeInk(line.before, width);
    const through = wrapLikeInk(`${line.before}${line.under}`, width);
    const last = before.at(-1) ?? '';
    return through.length > before.length
      ? { row: row + before.length, column: stringWidth(line.lead) }
      : { row: row + before.length - 1, column: stringWidth(line.lead) + stringWidth(last) };
  }
  return { row, column: 0 };
}
