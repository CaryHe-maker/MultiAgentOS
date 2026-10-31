import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { retainBytes, retainItems } from './retention.js';
import type { ByteRetention } from './retention.js';

const size = (text: string): number => Buffer.byteLength(text, 'utf8');
/** The `binary` unit never yields lone surrogates, which UTF-8 cannot carry. */
const text = fc.string({ unit: 'binary', maxLength: 200 });

describe('retainItems', () => {
  it('keeps everything that fits', () => {
    expect(retainItems(['a', 'b'], { maxBytes: 3 })).toEqual({
      kept: ['a', 'b'],
      omittedItems: 0,
      totalItems: 2,
    });
  });

  it('counts the newline between items against the byte limit', () => {
    expect(retainItems(['a', 'b'], { maxBytes: 2 }).kept).toEqual(['a']);
  });

  it('counts every line of a multi-line item against the line limit', () => {
    const result = retainItems(['one\ntwo', 'three'], { maxBytes: 100, maxLines: 2 });
    expect(result).toEqual({ kept: ['one\ntwo'], omittedItems: 1, totalItems: 2 });
  });

  it('never keeps a later item after an earlier one was left out', () => {
    expect(retainItems(['long item', 'x'], { maxBytes: 3 }).kept).toEqual([]);
  });

  it('accounts for every item and stays within the limits', () => {
    fc.assert(
      fc.property(
        fc.array(text, { maxLength: 30 }),
        fc.nat(300),
        fc.integer({ min: 1, max: 20 }),
        (items, maxBytes, maxLines) => {
          const result = retainItems(items, { maxBytes, maxLines });
          const rendered = result.kept.join('\n');
          expect(result.kept.length + result.omittedItems).toBe(items.length);
          expect(result.kept).toEqual(items.slice(0, result.kept.length));
          expect(size(rendered)).toBeLessThanOrEqual(maxBytes);
          if (result.kept.length > 0) {
            expect(rendered.split('\n').length).toBeLessThanOrEqual(maxLines);
          }
        },
      ),
    );
  });
});

describe('retainBytes', () => {
  it('returns text within the limit untouched', () => {
    expect(retainBytes('abc', 3, 'HEAD')).toEqual({
      head: 'abc',
      tail: '',
      omittedBytes: 0,
      totalBytes: 3,
    });
    expect(retainBytes('abc', 3, 'TAIL').tail).toBe('abc');
  });

  it('does not cut a UTF-8 sequence', () => {
    expect(retainBytes('é€', 4, 'HEAD')).toMatchObject({ head: 'é', omittedBytes: 3 });
    expect(retainBytes('é€', 4, 'TAIL')).toMatchObject({ tail: '€', omittedBytes: 2 });
  });

  it('does not split a surrogate pair', () => {
    expect(retainBytes('😀😀', 6, 'HEAD')).toMatchObject({ head: '😀', omittedBytes: 4 });
    expect(retainBytes('😀😀', 6, 'TAIL')).toMatchObject({ tail: '😀', omittedBytes: 4 });
  });

  it('gives the head the odd byte', () => {
    expect(retainBytes('abcdefgh', 5, 'BOTH')).toEqual({
      head: 'abc',
      tail: 'gh',
      omittedBytes: 3,
      totalBytes: 8,
    });
  });

  it('keeps nothing when the limit is zero', () => {
    expect(retainBytes('abc', 0, 'BOTH')).toEqual({
      head: '',
      tail: '',
      omittedBytes: 3,
      totalBytes: 3,
    });
  });

  it('keeps exact counts, stays within the limit and only ever returns whole text', () => {
    fc.assert(
      fc.property(
        text,
        fc.nat(120),
        fc.constantFrom<ByteRetention>('HEAD', 'TAIL', 'BOTH'),
        (value, maxBytes, retention) => {
          const result = retainBytes(value, maxBytes, retention);
          const kept = size(result.head) + size(result.tail);
          expect(result.totalBytes).toBe(size(value));
          expect(kept + result.omittedBytes).toBe(result.totalBytes);
          expect(kept).toBeLessThanOrEqual(Math.max(maxBytes, 0));
          expect(value.startsWith(result.head)).toBe(true);
          expect(value.endsWith(result.tail)).toBe(true);
        },
      ),
    );
  });
});
