/**
 * How wide the terminal draws the characters whose width the standard leaves open (East Asian
 * Ambiguous: the curly quotes, the dash, the ellipsis, the middle dot, which Chinese text is full
 * of). A terminal draws them one column wide or two, by its font, its locale or a setting, and
 * everything that lays text out (Ink, `wrap-ansi`, the cursor of the input box) has to count the
 * same as the terminal, or a line wraps where the screen does not and the cursor stands one cell
 * off.
 *
 * The answer is measured once, when the process starts, and kept in one place that `string-width`
 * reads (the patch in `patches/string-width@8.3.0.patch`): every caller then measures with one
 * ruler. Nothing is measured on a pipe, in CI or when the terminal does not answer: the standard's
 * default (narrow) stands, the same everywhere. `MAS_AMBIGUOUS_WIDTH=narrow|wide` overrides the
 * measurement; `auto` or nothing measures.
 */

export type AmbiguousWidth = 'narrow' | 'wide';

/** Where `string-width` looks for the answer: a global, so that one copy is enough for the process. */
const RULER = Symbol.for('multiagentos.ambiguousIsNarrow');

export function setAmbiguousWidth(width: AmbiguousWidth): void {
  (globalThis as Record<symbol, unknown>)[RULER] = width === 'narrow';
}

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

/** The characters asked about: “ — … · */
const PROBES = [0x201c, 0x2014, 0x2026, 0x00b7].map((code) => String.fromCodePoint(code));

/** The cursor position the terminal reports: ESC [ row ; column R. */
const REPORT = new RegExp(`${ESC}\\[(\\d+);(\\d+)R`, 'gu');
/** The start of a report that has not all arrived. */
const PARTIAL = new RegExp(`${ESC}(\\[[0-9;]*)?$`, 'u');

/** What the reported columns say: every probe starts in column 1, so a width is the column - 1. */
export function interpretProbe(columns: readonly number[]): AmbiguousWidth | undefined {
  if (columns.length !== PROBES.length) return undefined;
  const widths = columns.map((column) => column - 1);
  if (widths.some((width) => width !== 1 && width !== 2)) return undefined;
  const wide = widths.filter((width) => width === 2).length;
  return wide > widths.length - wide ? 'wide' : 'narrow';
}

/** Whatever the terminal does, asking it is never what stops the program from starting. */
function attempt(step: () => void): void {
  try {
    step();
  } catch {
    // Nothing more can be done about it.
  }
}

type ProbeInput = Pick<
  NodeJS.ReadStream,
  'isRaw' | 'setRawMode' | 'readableFlowing' | 'on' | 'off' | 'resume' | 'pause' | 'unshift'
>;
type ProbeOutput = Pick<NodeJS.WriteStream, 'write'>;

/**
 * Asks the terminal, in one write, where its cursor is after each probe character. It happens on
 * the alternate screen with the text concealed, inside a synchronized update where the terminal
 * has one, and nothing stays: the screen, the cursor and the input mode are put back whatever
 * happens, and what the person typed meanwhile is given back to the input. Gives up after
 * `timeoutMs`.
 */
export function probeAmbiguousWidth(
  stdin: ProbeInput,
  stdout: ProbeOutput,
  timeoutMs = 150,
): Promise<AmbiguousWidth | undefined> {
  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    const wasFlowing = stdin.readableFlowing === true;
    const columns: number[] = [];
    let held = '';
    let partial = '';
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Each step is put back on its own: one that fails must not leave the others undone.
      attempt(() => stdin.off('data', onData));
      attempt(() => stdout.write(`${CSI}0m${CSI}?25h${CSI}?1049l${CSI}?2026l`));
      attempt(() => stdin.setRawMode(wasRaw));
      attempt(() => {
        if (!wasFlowing) stdin.pause();
      });
      // What was typed while asking goes back to the input; a half report is not the person's.
      attempt(() => {
        if (held.length > 0) stdin.unshift(Buffer.from(held, 'utf8'));
      });
      resolve(interpretProbe(columns));
    };

    const onData = (chunk: Buffer | string): void => {
      const text = partial + chunk.toString();
      for (const match of text.matchAll(REPORT)) columns.push(Number(match[2]));
      const rest = text.replace(REPORT, '');
      const cut = PARTIAL.exec(rest);
      partial = cut === null ? '' : cut[0];
      held += cut === null ? rest : rest.slice(0, cut.index);
      if (columns.length >= PROBES.length) finish();
    };

    const timer = setTimeout(finish, timeoutMs);
    try {
      stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
      stdout.write(
        `${CSI}?2026h${CSI}?25l${CSI}?1049h${CSI}8m` +
          PROBES.map((probe) => `${CSI}1;1H${probe}${CSI}6n`).join(''),
      );
    } catch {
      finish();
    }
  });
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Decides the width and puts it where `string-width` reads it, before anything is drawn. The
 * setting wins; otherwise a terminal is asked; otherwise (not a terminal, no answer) narrow.
 */
export async function settleAmbiguousWidth(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  env: Environment,
): Promise<AmbiguousWidth> {
  const setting = env['MAS_AMBIGUOUS_WIDTH']?.trim().toLowerCase();
  let width: AmbiguousWidth | undefined =
    setting === 'narrow' || setting === 'wide' ? setting : undefined;
  if (width === undefined && stdin.isTTY && stdout.isTTY && env['TERM'] !== 'dumb')
    width = await probeAmbiguousWidth(stdin, stdout).catch(() => undefined);
  const settled = width ?? 'narrow';
  setAmbiguousWidth(settled);
  return settled;
}
