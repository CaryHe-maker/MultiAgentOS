/**
 * The two retainers every tool preview goes through (ExecutorSet 4). They only answer what was
 * kept and how much was left out; which end to keep and the notice shown to the model belong to
 * each Executor. The same input always gives the same result, byte for byte.
 */
export interface PreviewLimits {
  readonly maxBytes: number;
  /** Absent for `v0` Units, which have no line limit. */
  readonly maxLines?: number;
}

export interface RetainedItems {
  readonly kept: readonly string[];
  readonly omittedItems: number;
  readonly totalItems: number;
}

export interface RetainedBytes {
  /** The kept start of the text; empty when only the tail is kept. */
  readonly head: string;
  /** The kept end of the text; empty when only the head is kept. */
  readonly tail: string;
  readonly omittedBytes: number;
  readonly totalBytes: number;
}

export type ByteRetention = 'HEAD' | 'TAIL' | 'BOTH';

const SEPARATOR_BYTES = 1;

/**
 * Keeps the first items that fit. Items are joined by one newline, so that byte counts the
 * rendered size; an item may hold several lines, and each one counts against `maxLines`.
 */
export function retainItems(items: readonly string[], limits: PreviewLimits): RetainedItems {
  let bytes = 0;
  let lines = 0;
  let count = 0;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(item, 'utf8') + (count === 0 ? 0 : SEPARATOR_BYTES);
    const itemLines = countLines(item);
    if (bytes + itemBytes > limits.maxBytes) break;
    if (limits.maxLines !== undefined && lines + itemLines > limits.maxLines) break;
    bytes += itemBytes;
    lines += itemLines;
    count += 1;
  }
  return {
    kept: items.slice(0, count),
    omittedItems: items.length - count,
    totalItems: items.length,
  };
}

/**
 * Keeps at most `maxBytes` of `text`. Cuts fall on code point boundaries, so neither a UTF-8
 * sequence nor a UTF-16 surrogate pair is split; `BOTH` gives the head the odd byte.
 */
export function retainBytes(
  text: string,
  maxBytes: number,
  retention: ByteRetention,
): RetainedBytes {
  const bytes = Buffer.from(text, 'utf8');
  const totalBytes = bytes.length;
  if (totalBytes <= maxBytes) {
    return retention === 'TAIL'
      ? { head: '', tail: text, omittedBytes: 0, totalBytes }
      : { head: text, tail: '', omittedBytes: 0, totalBytes };
  }
  const headBudget =
    retention === 'HEAD' ? maxBytes : retention === 'TAIL' ? 0 : Math.ceil(maxBytes / 2);
  const tailBudget = maxBytes - headBudget;
  const headEnd = boundaryAtOrBefore(bytes, headBudget);
  const tailStart = boundaryAtOrAfter(bytes, totalBytes - tailBudget);
  return {
    head: bytes.toString('utf8', 0, headEnd),
    tail: bytes.toString('utf8', tailStart),
    omittedBytes: tailStart - headEnd,
    totalBytes,
  };
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lines += 1;
  }
  return lines;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function boundaryAtOrBefore(bytes: Buffer, offset: number): number {
  let boundary = offset;
  while (boundary > 0 && isContinuation(bytes[boundary])) boundary -= 1;
  return boundary;
}

function boundaryAtOrAfter(bytes: Buffer, offset: number): number {
  let boundary = offset;
  while (boundary < bytes.length && isContinuation(bytes[boundary])) boundary += 1;
  return boundary;
}
