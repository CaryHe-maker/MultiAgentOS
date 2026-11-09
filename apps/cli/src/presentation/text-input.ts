import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

const NEWLINE = '\n';

/**
 * The text of the input box and where the cursor is in it (docs/M2/Phase1Console.md 2.1, UI-2).
 * Pure functions, so the box can be tested without a terminal: `value` is the text, `cursor` an
 * index into it that always stands between two characters (never inside a surrogate pair), and
 * every function returns the next state.
 *
 * A long paste is not put into `value`: one placeholder character stands for it (a private-use
 * character, `PASTE_BASE` plus its index) and `pastes` keeps the text. The placeholder is one
 * character, so moving over it and deleting it are one step; the box draws it as
 * `[paste 14 lines]`; `expand` gives the real text back for sending.
 */

export interface InputState {
  readonly value: string;
  readonly cursor: number;
  /** The text behind each placeholder in `value`, by index. */
  readonly pastes?: readonly string[];
}

export const EMPTY_INPUT: InputState = { value: '', cursor: 0 };

/** The box holding `value`, with the cursor at its end (a message taken back, a history entry). */
export const inputOf = (value: string): InputState => ({ value, cursor: value.length });

/** A paste of more than this many characters becomes a placeholder. */
export const PASTE_FOLD_CHARS = 15;
/** The first placeholder character; the box holds at most `PASTE_LIMIT` of them. */
const PASTE_BASE = 0xe000;
const PASTE_LIMIT = 256;
const MARKS = new RegExp(
  `[${String.fromCharCode(PASTE_BASE)}-${String.fromCharCode(PASTE_BASE + PASTE_LIMIT - 1)}]`,
  'gu',
);

/** Typed or pasted text can never hold a placeholder character of its own. */
const cleanText = (text: string): string => text.replace(/\r\n?/gu, NEWLINE).replace(MARKS, '');

/** What a placeholder says: how much was pasted. */
export function pasteLabel(text: string): string {
  const lines = text.split(NEWLINE).length;
  return lines > 1 ? `[paste ${String(lines)} lines]` : `[paste ${String(text.length)} chars]`;
}

const pasteOf = (state: InputState, mark: string): string =>
  state.pastes?.[mark.charCodeAt(0) - PASTE_BASE] ?? '';

/** The text as the box draws it: placeholders written out as their labels. */
const shown = (state: InputState, text: string): string =>
  text.replace(MARKS, (mark) => pasteLabel(pasteOf(state, mark)));

/** The text as it is sent: placeholders replaced by what was pasted. */
export function expand(state: InputState): string {
  return state.value.replace(MARKS, (mark) => pasteOf(state, mark));
}

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

/** Text typed at the cursor; line ends become line feeds. */
export function insert(state: InputState, text: string): InputState {
  const clean = cleanText(text);
  return {
    ...state,
    value: state.value.slice(0, state.cursor) + clean + state.value.slice(state.cursor),
    cursor: state.cursor + clean.length,
  };
}

/** Text pasted at the cursor: a long one becomes one placeholder, a short one is typed text. */
export function insertPaste(state: InputState, text: string): InputState {
  const clean = cleanText(text);
  const pastes = state.pastes ?? [];
  if (clean.length <= PASTE_FOLD_CHARS || pastes.length >= PASTE_LIMIT) return insert(state, clean);
  const mark = String.fromCharCode(PASTE_BASE + pastes.length);
  return {
    value: state.value.slice(0, state.cursor) + mark + state.value.slice(state.cursor),
    cursor: state.cursor + 1,
    pastes: [...pastes, clean],
  };
}

export function backspace(state: InputState): InputState {
  if (state.cursor === 0) return state;
  const from = before(state.value, state.cursor);
  return {
    ...state,
    value: state.value.slice(0, from) + state.value.slice(state.cursor),
    cursor: from,
  };
}

export function deleteForward(state: InputState): InputState {
  if (state.cursor >= state.value.length) return state;
  const to = after(state.value, state.cursor);
  return {
    ...state,
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
    ...state,
    value: state.value.slice(0, start) + state.value.slice(state.cursor),
    cursor: start,
  };
}

/** Ctrl+K: everything after the cursor on its line. */
export function deleteToLineEnd(state: InputState): InputState {
  const { end } = lineBounds(state);
  return {
    ...state,
    value: state.value.slice(0, state.cursor) + state.value.slice(end),
    cursor: state.cursor,
  };
}

/** Ctrl+W: the word before the cursor, and the spaces between. */
export function deleteWordBefore(state: InputState): InputState {
  let from = state.cursor;
  while (from > 0 && /\s/u.test(state.value[from - 1] ?? '')) from -= 1;
  while (from > 0 && !/\s/u.test(state.value[from - 1] ?? '')) from -= 1;
  return {
    ...state,
    value: state.value.slice(0, from) + state.value.slice(state.cursor),
    cursor: from,
  };
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
interface BoxLine {
  readonly lead: string;
  /** The text before the cursor, the character under it (a space at the end) and the rest. */
  readonly before: string;
  readonly under: string;
  readonly after: string;
  /** Whether the cursor is on this line. */
  readonly here: boolean;
}

/** The lines of the box as they are drawn; the cursor line carries the cell the cursor stands on. */
function boxLines(state: InputState, prefix: string, continuation: string): BoxLine[] {
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
        before: shown(state, line.slice(0, column)),
        under: real === undefined ? ' ' : shown(state, real),
        after: real === undefined ? '' : shown(state, line.slice(column + real.length)),
        here,
      });
    } else lines.push({ lead, before: shown(state, line), under: '', after: '', here });
    start += line.length + 1;
  }
  return lines;
}

/** One screen row of the box: the lead, and the text with the cursor character in it, if it is here. */
export interface BoxRow {
  readonly lead: string;
  readonly before: string;
  readonly under: string;
  readonly after: string;
  readonly here: boolean;
}

export interface BoxLayout {
  readonly rows: readonly BoxRow[];
  /** Where the cell under the cursor is, counted from the top-left of the box. */
  readonly cursorRow: number;
  readonly cursorColumn: number;
}

/**
 * The box cut into the rows it is drawn as, and where the terminal cursor belongs: each line of
 * the text is cut as Ink cuts it (`wrapLikeInk`) in the width that is left beside its lead, and the
 * rest of a long line goes on under the text, not under the lead. The cursor is in the row that
 * holds the first cell of the character under it; one that does not fit the end of a row starts
 * the next.
 */
export function layoutBox(
  state: InputState,
  prefix: string,
  continuation: string,
  columns: number,
): BoxLayout {
  const rows: BoxRow[] = [];
  let cursorRow = 0;
  let cursorColumn = 0;
  for (const line of boxLines(state, prefix, continuation)) {
    const leadWidth = stringWidth(line.lead);
    const text = `${line.before}${line.under}${line.after}`;
    const blank = ' '.repeat(leadWidth);
    let offset = 0;
    for (const [index, piece] of wrapLikeInk(text, columns - BOX_MARGIN - leadWidth).entries()) {
      const lead = index === 0 ? line.lead : blank;
      const start = offset;
      offset += piece.length;
      const at = line.before.length;
      if (!line.here || at < start || at >= offset) {
        rows.push({ lead, before: piece, under: '', after: '', here: false });
        continue;
      }
      const stop = Math.min(offset, at + line.under.length) - start;
      rows.push({
        lead,
        before: piece.slice(0, at - start),
        under: piece.slice(at - start, stop),
        after: piece.slice(stop),
        here: true,
      });
      cursorRow = rows.length - 1;
      cursorColumn = leadWidth + stringWidth(piece.slice(0, at - start));
    }
  }
  return { rows, cursorRow, cursorColumn };
}

/** The box shows at most this many rows, and never fewer than the least, whatever the terminal. */
export const BOX_MAX_ROWS = 10;
export const BOX_MIN_ROWS = 2;

/** The rows the box may take on a terminal of `terminalRows` rows. */
export const boxHeight = (terminalRows: number): number =>
  Math.max(BOX_MIN_ROWS, Math.min(BOX_MAX_ROWS, terminalRows - 8));

/** Which rows of a box too tall for its height are drawn, and which side has more. */
export interface BoxWindow {
  /** Index of the first drawn row of the box. */
  readonly top: number;
  /** How many rows of the box are drawn (the markers are not counted). */
  readonly count: number;
  readonly hiddenAbove: boolean;
  readonly hiddenBelow: boolean;
}

/**
 * The window onto a box of `total` rows that is at most `height` rows tall, markers included: a
 * side that has more rows hidden has a `…` row in place of one row of text. The window stays where
 * it was (`top`) while the cursor is in it, and moves only as far as it must to show the cursor;
 * at least one row of text is always drawn.
 */
export function windowOf(total: number, cursorRow: number, top: number, height: number): BoxWindow {
  if (total <= height) return { top: 0, count: total, hiddenAbove: false, hiddenBelow: false };
  const shape = (first: number): BoxWindow => {
    const hiddenAbove = first > 0;
    const room = height - (hiddenAbove ? 1 : 0);
    const hiddenBelow = first + room < total && room - 1 >= 1;
    return { top: first, count: hiddenBelow ? room - 1 : room, hiddenAbove, hiddenBelow };
  };
  let first = Math.min(Math.max(0, top), total - 1);
  if (cursorRow < first) first = cursorRow;
  while (cursorRow >= first + shape(first).count) first += 1;
  // No empty room at the end: show more of the rows above instead.
  while (first > 0 && first + shape(first).count > total) first -= 1;
  return shape(first);
}

/** What is drawn of the box: the rows of the window, the markers, and where the cursor stands. */
export interface BoxView {
  readonly rows: readonly BoxRow[];
  readonly above: boolean;
  readonly below: boolean;
  /** The index of the first drawn row of the whole box: the next view starts from it. */
  readonly top: number;
  /** Screen rows the box takes: the rows and the markers. */
  readonly shown: number;
  /** The cursor, counted from the top-left of what is drawn (a marker above counts as a row). */
  readonly cursorRow: number;
  readonly cursorColumn: number;
}

/** The box cut into rows (`layoutBox`) and into the window of at most `height` rows (`windowOf`). */
export function viewBox(
  state: InputState,
  prefix: string,
  continuation: string,
  columns: number,
  height: number,
  top: number,
): BoxView {
  const layout = layoutBox(state, prefix, continuation, columns);
  const window = windowOf(layout.rows.length, layout.cursorRow, top, height);
  const rows = layout.rows.slice(window.top, window.top + window.count);
  const above = window.hiddenAbove;
  const below = window.hiddenBelow;
  return {
    rows,
    above,
    below,
    top: window.top,
    shown: rows.length + (above ? 1 : 0) + (below ? 1 : 0),
    cursorRow: layout.cursorRow - window.top + (above ? 1 : 0),
    cursorColumn: layout.cursorColumn,
  };
}
