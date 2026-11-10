import stringWidth from 'string-width';

/**
 * What the part of the screen that is drawn in place looks like, kept so that it can be erased
 * exactly when the window changes size (docs/M2/Phase1Console.md, UI-8).
 *
 * Ink erases a frame by moving the cursor up by the number of lines it wrote. When the window gets
 * narrower the terminal wraps those lines again, so the frame takes more rows than lines, and the
 * erase stops short: the top of the old frame stays. Here the rows are counted again, at the width
 * the window has now, from the text of the lines, and exactly the frame is erased: nothing above
 * it, the conversation in the scroll-back, is touched.
 */

const ESC = String.fromCharCode(27);

/** One frame as it was drawn: its lines (what Ink was given) and where the cursor was left. */
export interface FrameShape {
  readonly lines: readonly string[];
  /** The width of the window when it was drawn: a line is cut to it, never drawn wider. */
  readonly columns: number;
  /** The cursor: a column, and a row counted in lines from the top of the frame. */
  readonly cursor: { readonly x: number; readonly y: number };
}

interface Step {
  readonly rows: number;
  /** The row (counted from the first one of the line) the character at `column` falls on. */
  readonly rowOf: (column: number) => number;
}

/**
 * How a line takes rows in a window `columns` wide: by the same ruler as everything else
 * (`string-width`), a character that does not fit goes to the next row whole, and a line that
 * exactly fills a row does not use another one.
 */
export function wrap(text: string, columns: number): Step {
  const width = Math.max(1, columns);
  const starts: { readonly from: number; readonly row: number }[] = [];
  let rows = 1;
  let used = 0;
  let shown = 0;
  for (const character of text) {
    const w = stringWidth(character);
    if (w === 0) continue;
    if (used + w > width) {
      rows += 1;
      used = 0;
    }
    starts.push({ from: shown, row: rows - 1 });
    used += w;
    shown += w;
  }
  return {
    rows,
    rowOf: (column) => {
      let found = 0;
      for (const each of starts) if (each.from <= column) found = each.row;
      return found;
    },
  };
}

/** `text` cut to `columns` the way Ink cuts a line that is too long. */
function cut(text: string, columns: number): string {
  if (stringWidth(text) <= columns) return text;
  let out = '';
  for (const character of text) {
    if (stringWidth(out + character) > columns) break;
    out += character;
  }
  return out;
}

/** The rows between the top of the frame and its cursor, in a window `columns` wide. */
export function rowsAboveCursor(frame: FrameShape, columns: number): number {
  let rows = 0;
  for (let index = 0; index < frame.cursor.y && index < frame.lines.length; index += 1)
    rows += wrap(cut(frame.lines[index] ?? '', frame.columns), columns).rows;
  const own = frame.lines[frame.cursor.y];
  if (own !== undefined) rows += wrap(cut(own, frame.columns), columns).rowOf(frame.cursor.x);
  return rows;
}

type Write = NodeJS.WriteStream['write'];

/** The marker of a write of a frame: Ink ends one with the cursor shown, where it is typed. */
const SHOW_CURSOR = `${ESC}[?25h`;

export class FrameTracker {
  #reported: FrameShape | undefined;
  #drawn: FrameShape | undefined;
  #write: Write | undefined;
  #swallow = false;

  /** The component says what it is giving Ink to draw; it is what the next write of a frame draws. */
  public report(frame: FrameShape): void {
    this.#reported = frame;
  }

  /** Puts itself between Ink and `stdout`: every write goes through, and a frame is noted. */
  public attach(stdout: NodeJS.WriteStream): () => void {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- kept to put it back as it was
    const own = stdout.write;
    const original: Write = own.bind(stdout);
    this.#write = original;
    const wrapped = (chunk: unknown, ...rest: unknown[]): boolean => {
      if (this.#swallow) {
        const done = rest.find((each) => typeof each === 'function');
        if (typeof done === 'function') (done as () => void)();
        return true;
      }
      if (typeof chunk === 'string' && chunk.includes(SHOW_CURSOR)) this.#drawn = this.#reported;
      return (original as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
    };
    stdout.write = wrapped;
    return () => {
      stdout.write = own;
    };
  }

  /**
   * Erases the frame that is on the screen, as it is at the width the window has now, and leaves
   * the cursor where the frame began. `forget` makes Ink forget the frame without writing: what it
   * would write counts the lines, and would reach up into what is above the frame.
   */
  public erase(columns: number, forget: () => void): void {
    const frame = this.#drawn;
    this.#drawn = undefined;
    if (this.#write !== undefined && frame !== undefined) {
      const up = rowsAboveCursor(frame, columns);
      this.#write.call(
        undefined,
        `${ESC}[?25l${up > 0 ? `${ESC}[${String(up)}A` : ''}${ESC}[G${ESC}[J`,
      );
    }
    this.#swallow = true;
    try {
      forget();
    } finally {
      this.#swallow = false;
    }
  }
}
