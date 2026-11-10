import { appendFileSync } from 'node:fs';
import stringWidth from 'string-width';

/**
 * A record of what the screen is told, for finding out why a frame was left behind
 * (`MAS_UI_TRACE=<file>`; nothing is written without it). One JSON line per write of Ink and per
 * resize: the size of the window, how many rows Ink erased and how many it wrote, and the widest
 * written row. A frame that Ink counted as N rows but the terminal drew as more shows here as a
 * row wider than `columns`, or as a size that changed between two frames.
 */

const ESC = String.fromCharCode(27);
const ERASE_ROW = `${ESC}[2K`;
// eslint-disable-next-line no-control-regex
const SEQUENCE = /\u001b\[[0-9;?]*[A-Za-z]/gu;

export interface Tracer {
  write(chunk: string): void;
  resize(): void;
}

type Sized = { readonly columns?: number; readonly rows?: number };

export function createTracer(file: string, stdout: Sized, now: () => number = Date.now): Tracer {
  const line = (entry: Record<string, unknown>): void => {
    try {
      appendFileSync(
        file,
        `${JSON.stringify({ at: new Date(now()).toISOString(), columns: stdout.columns, rows: stdout.rows, ...entry })}\n`,
      );
    } catch {
      // A trace that cannot be written never gets in the way of the screen.
    }
  };
  return {
    write: (chunk) => {
      const erased = chunk.split(ERASE_ROW).length - 1;
      const text = chunk.replace(SEQUENCE, '');
      const rows = text.split('\n');
      line({
        kind: 'WRITE',
        bytes: chunk.length,
        erased,
        written: rows.length,
        widest: Math.max(0, ...rows.map((each) => stringWidth(each))),
        clears: chunk.includes(`${ESC}[2J`),
      });
    },
    resize: () => line({ kind: 'RESIZE' }),
  };
}

/** `stdout` whose writes are also traced; the same object when tracing is off. */
export function traced(stdout: NodeJS.WriteStream, file: string | undefined): NodeJS.WriteStream {
  if (file === undefined || file.length === 0) return stdout;
  const tracer = createTracer(file, stdout);
  const write = (stdout.write as unknown as (...args: unknown[]) => boolean).bind(stdout);
  const traceWrite = (chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') tracer.write(chunk);
    return write(chunk, ...rest);
  };
  stdout.write = traceWrite;
  stdout.on('resize', () => tracer.resize());
  return stdout;
}
