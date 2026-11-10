/**
 * The largest message the console sends: 100 KB of UTF-8. A message beyond it is not sent, and the
 * person is told only then (docs/M2/Phase1Console.md, input box). The input box checks the same
 * rule before it lets go of what was typed, so that nothing typed is lost.
 */
export const MAX_INPUT_BYTES = 100 * 1024;

export function inputBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function exceedsInputLimit(text: string): boolean {
  // A string cannot be longer in bytes than three times its length: no need to encode the short ones.
  return text.length * 3 > MAX_INPUT_BYTES && inputBytes(text) > MAX_INPUT_BYTES;
}
