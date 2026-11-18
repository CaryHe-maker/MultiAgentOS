/**
 * The records of a JSONL file the system may still be appending to (the session log, the audit, an
 * index): a line counts once its newline is there, as the log store reads it, so a line being
 * written is never read half.
 */
export function jsonLines<T = Record<string, unknown>>(text: string): T[] {
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
