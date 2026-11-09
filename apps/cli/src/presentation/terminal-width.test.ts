import { PassThrough } from 'node:stream';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { afterEach, describe, expect, it } from 'vitest';
import {
  interpretProbe,
  probeAmbiguousWidth,
  setAmbiguousWidth,
  settleAmbiguousWidth,
  type AmbiguousWidth,
} from './terminal-width.js';

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const AMBIGUOUS = [0x201c, 0x2014, 0x2026, 0x00b7].map((code) => String.fromCodePoint(code));

afterEach(() => setAmbiguousWidth('narrow'));

/** A terminal stand-in: answers a cursor query with the column after the last character drawn. */
function terminal(options: {
  readonly draws?: AmbiguousWidth;
  readonly answers?: boolean;
  /** Reply bytes cut into pieces of this many characters. */
  readonly piece?: number;
  /** What the person typed before the reply came. */
  readonly typed?: string;
}) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (mode: boolean) => PassThrough;
  };
  stdin.isTTY = true;
  stdin.isRaw = false;
  const rawCalls: boolean[] = [];
  stdin.setRawMode = (mode: boolean) => {
    rawCalls.push(mode);
    stdin.isRaw = mode;
    return stdin;
  };
  const written: string[] = [];
  let typedWritten = false;
  const stdout = {
    isTTY: true,
    write: (text: string): boolean => {
      written.push(text);
      for (const part of text.split(CSI)) {
        if (part.startsWith('6n') && options.answers !== false) {
          const column = 1 + (options.draws === 'wide' ? 2 : 1);
          const reply = `${CSI}1;${String(column)}R`;
          setImmediate(() => {
            if (options.typed !== undefined && !typedWritten) stdin.write(options.typed);
            typedWritten = true;
            const size = options.piece ?? reply.length;
            for (let at = 0; at < reply.length; at += size) stdin.write(reply.slice(at, at + size));
          });
        }
      }
      return true;
    },
  };
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    written,
    rawCalls,
  };
}

describe('what a probe answer means', () => {
  it('is narrow when every character took one column and wide when every one took two', () => {
    expect(interpretProbe([2, 2, 2, 2])).toBe('narrow');
    expect(interpretProbe([3, 3, 3, 3])).toBe('wide');
  });

  it('follows the majority of a mixed answer, and narrow when they are even', () => {
    expect(interpretProbe([3, 3, 3, 2])).toBe('wide');
    expect(interpretProbe([2, 2, 2, 3])).toBe('narrow');
    expect(interpretProbe([2, 2, 3, 3])).toBe('narrow');
  });

  it('is no answer when the reports are too few or make no sense', () => {
    expect(interpretProbe([2, 2, 2])).toBeUndefined();
    expect(interpretProbe([1, 2, 2, 2])).toBeUndefined();
    expect(interpretProbe([5, 2, 2, 2])).toBeUndefined();
  });
});

describe('asking the terminal', () => {
  it('reads a narrow terminal and a wide one', async () => {
    const narrow = terminal({ draws: 'narrow' });
    expect(await probeAmbiguousWidth(narrow.stdin, narrow.stdout)).toBe('narrow');
    const wide = terminal({ draws: 'wide' });
    expect(await probeAmbiguousWidth(wide.stdin, wide.stdout)).toBe('wide');
  });

  it('shows nothing: all of it is on the alternate screen with the text concealed, and then put back', async () => {
    const t = terminal({ draws: 'narrow' });
    await probeAmbiguousWidth(t.stdin, t.stdout);
    const text = t.written.join('');
    // In: synchronized update, hidden cursor, alternate screen, concealed text; out: the reverse.
    expect(text.startsWith(`${CSI}?2026h${CSI}?25l${CSI}?1049h${CSI}8m`)).toBe(true);
    expect(text.endsWith(`${CSI}0m${CSI}?25h${CSI}?1049l${CSI}?2026l`)).toBe(true);
    // The probe characters are written only after the concealing, and one write asks them all.
    for (const probe of AMBIGUOUS) expect(text.indexOf(probe)).toBeGreaterThan(text.indexOf('8m'));
    expect(t.written).toHaveLength(2);
  });

  it('puts the input mode back, and leaves the input as it was', async () => {
    const t = terminal({ draws: 'narrow' });
    await probeAmbiguousWidth(t.stdin, t.stdout);
    expect(t.rawCalls).toEqual([true, false]);
    expect((t.stdin as unknown as PassThrough).isPaused()).toBe(true);
  });

  it('gives back what the person typed while it asked, and swallows the answers', async () => {
    const t = terminal({ draws: 'narrow', typed: 'ab' });
    await probeAmbiguousWidth(t.stdin, t.stdout);
    expect(String((t.stdin as unknown as PassThrough).read())).toBe('ab');
  });

  it('reads an answer that arrives in pieces', async () => {
    const t = terminal({ draws: 'wide', piece: 2 });
    expect(await probeAmbiguousWidth(t.stdin, t.stdout)).toBe('wide');
  });

  it('gives up when nothing answers, and still puts everything back', async () => {
    const t = terminal({ answers: false });
    expect(await probeAmbiguousWidth(t.stdin, t.stdout, 20)).toBeUndefined();
    expect(t.written.join('').endsWith(`${CSI}?1049l${CSI}?2026l`)).toBe(true);
    expect(t.rawCalls).toEqual([true, false]);
  });
});

describe('when the terminal misbehaves', () => {
  it('never throws and puts back what it can when the input mode cannot be set', async () => {
    const t = terminal({ draws: 'narrow' });
    (t.stdin as unknown as { setRawMode: () => never }).setRawMode = () => {
      throw new Error('EIO');
    };
    expect(await probeAmbiguousWidth(t.stdin, t.stdout)).toBeUndefined();
    // The screen is put back although nothing could be asked.
    expect(t.written.join('').endsWith(`${CSI}?1049l${CSI}?2026l`)).toBe(true);
  });

  it('never throws when the screen cannot be written to, and the input is let go of', async () => {
    const t = terminal({ draws: 'narrow' });
    (t.stdout as unknown as { write: () => never }).write = () => {
      throw new Error('EPIPE');
    };
    expect(await probeAmbiguousWidth(t.stdin, t.stdout)).toBeUndefined();
    expect(t.rawCalls).toEqual([true, false]);
    expect(await settleAmbiguousWidth(t.stdin, t.stdout, {})).toBe('narrow');
  });
});

describe('settling the width of a process', () => {
  it('uses the setting and asks nothing', async () => {
    const t = terminal({ draws: 'narrow' });
    expect(await settleAmbiguousWidth(t.stdin, t.stdout, { MAS_AMBIGUOUS_WIDTH: 'wide' })).toBe(
      'wide',
    );
    expect(t.written).toEqual([]);
    expect(stringWidth(AMBIGUOUS[0] ?? '')).toBe(2);
  });

  it('measures when the setting is auto or absent, and the ruler follows', async () => {
    const t = terminal({ draws: 'wide' });
    expect(await settleAmbiguousWidth(t.stdin, t.stdout, { MAS_AMBIGUOUS_WIDTH: 'auto' })).toBe(
      'wide',
    );
    expect(stringWidth(AMBIGUOUS[0] ?? '')).toBe(2);
  });

  it('is narrow without asking when it is not a terminal or the terminal is dumb', async () => {
    const piped = terminal({ draws: 'wide' });
    (piped.stdin as { isTTY: boolean }).isTTY = false;
    expect(await settleAmbiguousWidth(piped.stdin, piped.stdout, {})).toBe('narrow');
    expect(piped.written).toEqual([]);
    const dumb = terminal({ draws: 'wide' });
    expect(await settleAmbiguousWidth(dumb.stdin, dumb.stdout, { TERM: 'dumb' })).toBe('narrow');
    expect(dumb.written).toEqual([]);
  });

  it('is narrow when the terminal does not answer', async () => {
    const t = terminal({ answers: false });
    const settled = settleAmbiguousWidth(t.stdin, t.stdout, {});
    expect(await settled).toBe('narrow');
  });
});

describe('one ruler for everything that measures', () => {
  it('makes string-width and wrap-ansi, which Ink lays out with, count the same', () => {
    const quotes = AMBIGUOUS[0]?.repeat(4) ?? '';
    setAmbiguousWidth('narrow');
    expect(stringWidth(quotes)).toBe(4);
    expect(wrapAnsi(quotes, 4, { hard: true })).toBe(quotes);
    setAmbiguousWidth('wide');
    expect(stringWidth(quotes)).toBe(8);
    expect(wrapAnsi(quotes, 4, { hard: true })).toBe(
      `${AMBIGUOUS[0]?.repeat(2) ?? ''}\n${AMBIGUOUS[0]?.repeat(2) ?? ''}`,
    );
  });
});
