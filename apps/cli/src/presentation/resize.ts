/**
 * What happens when the window is resized (docs/M2/Phase1Console.md, UI-8).
 *
 * Ink erases the part of the screen that is drawn in place by the number of lines it wrote. When the
 * window gets narrower the terminal wraps those lines again, so they take more rows than were
 * counted and the top of the old frame is left behind. So Ink's own answer to a resize is taken
 * off the stream, and the console answers instead (`frame-tracker.ts`): at once, because nothing
 * of Ink may be drawn between the window changing and the frame being erased as it is now.
 */

type Listener = (...args: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Takes the resize handlers Ink put on `stdout` (those not in `known`) off it, and calls `answer`
 * at every change of size instead. Returns what takes the handler away again.
 */
export function answerResize(
  stdout: NodeJS.WriteStream,
  known: ReadonlySet<Listener>,
  answer: () => void,
): () => void {
  for (const listener of stdout.listeners('resize') as Listener[])
    if (!known.has(listener)) stdout.off('resize', listener);
  stdout.on('resize', answer);
  return () => {
    stdout.off('resize', answer);
  };
}
