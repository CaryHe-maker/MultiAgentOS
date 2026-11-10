import { describe, expect, it } from 'vitest';
import { FrameTracker, rowsAboveCursor, wrap, type FrameShape } from './frame-tracker.js';

const frame = (lines: string[], columns: number, x: number, y: number): FrameShape => ({
  lines,
  columns,
  cursor: { x, y },
});

describe('how a line takes rows', () => {
  it('is one row when it fits, also when it fills the row exactly', () => {
    expect(wrap('abcde', 10).rows).toBe(1);
    expect(wrap('abcdefghij', 10).rows).toBe(1);
    expect(wrap('abcdefghijk', 10).rows).toBe(2);
    expect(wrap('', 10).rows).toBe(1);
  });

  it('puts a wide character whole on the next row when it does not fit', () => {
    // Four columns hold two wide characters; the third starts a row.
    expect(wrap('你好吗', 4).rows).toBe(2);
    // Three columns hold one wide character and a gap: each wide one takes a row of its own.
    expect(wrap('你好吗', 3).rows).toBe(3);
    expect(wrap('a你好', 3).rows).toBe(2);
  });

  it('says which row a column falls on', () => {
    const step = wrap('abcdefghijklmnopqrstu', 10);
    expect([0, 9, 10, 19, 20].map((column) => step.rowOf(column))).toEqual([0, 0, 1, 1, 2]);
  });
});

describe('the rows above the cursor', () => {
  it('are the lines above it when nothing wraps', () => {
    expect(rowsAboveCursor(frame(['a', 'b', 'c', '› x'], 40, 3, 3), 40)).toBe(3);
  });

  it('count the rows a line takes once the window is narrower', () => {
    const long = 'x'.repeat(35);
    // 35 columns at 10 take 4 rows; the line above the cursor is two rows more than before.
    expect(rowsAboveCursor(frame(['a', long, '› x'], 40, 3, 2), 10)).toBe(1 + 4);
    // The cursor is itself in a line that wraps: the row it is on counts.
    expect(rowsAboveCursor(frame(['a', '› ' + 'y'.repeat(30)], 40, 25, 1), 10)).toBe(1 + 2);
  });

  it('count a line as it was drawn: cut to the width of the window it was drawn in', () => {
    // Drawn at 20 columns, a 50-column line was cut to 20: at 10 columns that is 2 rows, not 5.
    expect(rowsAboveCursor(frame(['z'.repeat(50), '› x'], 20, 3, 1), 10)).toBe(2);
  });

  it('are none for a cursor in the first row', () => {
    expect(rowsAboveCursor(frame(['› x', 'b'], 40, 3, 0), 40)).toBe(0);
  });
});

describe('erasing the frame', () => {
  const stream = () => {
    const written: string[] = [];
    const out = {
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    };
    return { out: out as unknown as NodeJS.WriteStream, written };
  };
  const ESC = String.fromCharCode(27);

  it('moves up by the rows at the new width, erases to the end, and has Ink forget the frame without a write', () => {
    const { out, written } = stream();
    const tracker = new FrameTracker();
    tracker.attach(out);
    tracker.report(frame(['a', 'x'.repeat(35), '› x'], 40, 3, 2));
    out.write(`frame${ESC}[?25h`);
    written.length = 0;
    let forgot = false;
    tracker.erase(10, () => {
      out.write(`${ESC}[5A${ESC}[J`); // what Ink would write: it must not reach the terminal
      forgot = true;
    });
    expect(forgot).toBe(true);
    expect(written).toEqual([`${ESC}[?25l${ESC}[5A${ESC}[G${ESC}[J`]);
  });

  it('writes nothing when no frame was drawn yet, and gives the stream back when detached', () => {
    const { out, written } = stream();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared as a function
    const original = out.write;
    const tracker = new FrameTracker();
    const detach = tracker.attach(out);
    tracker.erase(10, () => undefined);
    expect(written).toEqual([]);
    detach();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared as a function
    expect(out.write).toBe(original);
  });

  it('erases what was drawn last, not what was only reported', () => {
    const { out, written } = stream();
    const tracker = new FrameTracker();
    tracker.attach(out);
    tracker.report(frame(['a', 'b', '› x'], 40, 3, 2));
    out.write(`one${ESC}[?25h`);
    tracker.report(frame(['a', 'b', 'c', 'd', '› x'], 40, 3, 4));
    written.length = 0;
    tracker.erase(40, () => undefined);
    expect(written).toEqual([`${ESC}[?25l${ESC}[2A${ESC}[G${ESC}[J`]);
  });
});
