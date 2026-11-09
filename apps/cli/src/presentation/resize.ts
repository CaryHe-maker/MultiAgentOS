/**
 * What happens when the window is resized (docs/M2/Phase1Console.md, UI-8).
 *
 * The part of the screen that is drawn in place is erased by counting its rows. When the window
 * gets narrower the terminal wraps the rows that are on the screen again, so there are more of
 * them than were counted, the rows above the count stay, and every step of a drag leaves a copy of
 * the frame behind. Ink erases the counted rows at each step.
 *
 * So the steps of a drag are not drawn at all: when the size has not changed for a moment, the
 * screen is erased as a whole (nothing on it is counted any more), and the part in place is drawn
 * again, once, at the size the window has.
 */

const ESC = String.fromCharCode(27);

/** Erases the screen and puts the cursor at its top left. */
export const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;

/** How long the size has to stay the same before the screen is drawn again. */
export const RESIZE_SETTLE_MS = 150;

type Listener = (...args: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Takes the resize handlers Ink put on `stdout` (those not in `known`) off it, and calls `settled`
 * instead, once, after the size has stopped changing. Returns what takes the handler away again.
 */
export function clearOnResize(
  stdout: NodeJS.WriteStream,
  known: ReadonlySet<Listener>,
  settled: () => void,
  wait = RESIZE_SETTLE_MS,
): () => void {
  for (const listener of stdout.listeners('resize') as Listener[])
    if (!known.has(listener)) stdout.off('resize', listener);
  let timer: NodeJS.Timeout | undefined;
  const onResize = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      settled();
    }, wait);
  };
  stdout.on('resize', onResize);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    stdout.off('resize', onResize);
  };
}
