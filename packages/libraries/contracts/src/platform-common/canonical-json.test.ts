import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,1]},"b":1}',
    );
  });

  it('is independent of key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(record));
      }),
    );
  });

  it('round-trips through JSON.parse for any JSON value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const encoded = canonicalJson(value);
        expect(canonicalJson(JSON.parse(encoded))).toBe(encoded);
      }),
    );
  });

  it('normalizes negative zero', () => {
    expect(canonicalJson({ value: -0 })).toBe('{"value":0}');
  });

  it.each([
    ['undefined', { value: undefined }],
    ['NaN', { value: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['bigint', { value: 1n }],
    ['Date', { value: new Date(0) }],
    ['Map', new Map()],
  ])('rejects %s instead of silently changing it', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });
});
