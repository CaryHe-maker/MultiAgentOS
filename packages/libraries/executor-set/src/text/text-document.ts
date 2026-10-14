/**
 * Line handling shared by every Executor that returns repository text. A file is decoded as
 * UTF-8 and split on LF; a CR before the LF is dropped, so returned text always uses LF
 * (ExecutorSet 4.3). The text of a line range is what FILE_READ returns for that range, and its
 * SHA-256 is the `contentSha256` of every Provenance that cites the range.
 */
export interface TextDocument {
  readonly lines: readonly string[];
  /** False when the last line of a non-empty file has no line terminator. */
  readonly endsWithNewline: boolean;
}

/** Binary per ExecutorSet 3.1: a NUL byte within the first 8 KiB. */
export const BINARY_PROBE_BYTES = 8 * 1024;

export function isBinary(content: Uint8Array): boolean {
  return content.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

export function parseText(content: Buffer | string): TextDocument {
  const text = typeof content === 'string' ? content : content.toString('utf8');
  if (text.length === 0) return { lines: [], endsWithNewline: true };
  const endsWithNewline = text.endsWith('\n');
  const body = endsWithNewline ? text.slice(0, -1) : text;
  const lines = body.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  return { lines, endsWithNewline };
}

/** Lines `startLine..endLine` (1-based, inclusive) as LF-terminated text. */
export function lineRangeText(document: TextDocument, startLine: number, endLine: number): string {
  if (endLine < startLine) return '';
  const selected = document.lines.slice(startLine - 1, endLine);
  const lastIsUnterminated = endLine === document.lines.length && !document.endsWithNewline;
  return selected
    .map((line, index) =>
      lastIsUnterminated && index === selected.length - 1 ? line : `${line}\n`,
    )
    .join('');
}

/**
 * Lines prefixed with right-aligned line numbers, the format M0 measured as the cheapest and
 * clearest for the model (`experiments/minimal-agent-loop/RUNS.md`, C4).
 */
export function numberLines(lines: readonly string[], firstLine: number): string {
  const width = String(firstLine + Math.max(lines.length - 1, 0)).length;
  return lines
    .map((line, index) => `${String(firstLine + index).padStart(width)} | ${line}`)
    .join('\n');
}
