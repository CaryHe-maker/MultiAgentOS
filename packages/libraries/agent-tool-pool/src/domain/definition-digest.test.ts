import { describe, expect, it } from 'vitest';
import { documentAt, draftDocuments } from '../test-support/definition-fixtures.js';
import { computeDefinitionDigest, type DefinitionBody } from './definition-digest.js';

const body = (prefix: string, patch: object = {}): DefinitionBody =>
  ({ ...(documentAt(draftDocuments(), prefix).content as object), ...patch }) as DefinitionBody;
const noReferences = () => undefined;
const everyReference = (digest: string) => () => digest;

describe('computeDefinitionDigest', () => {
  it('is a stable sha256 of the content', () => {
    const first = computeDefinitionDigest(body('tools/'), noReferences);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeDefinitionDigest(body('tools/'), noReferences)).toBe(first);
  });

  it('does not depend on key order or on a declared digest', () => {
    const tool = body('tools/');
    const reordered = Object.fromEntries(Object.entries(tool).reverse()) as DefinitionBody;
    const withDigest = body('tools/', { digest: 'f'.repeat(64) });
    const expected = computeDefinitionDigest(tool, noReferences);
    expect(computeDefinitionDigest(reordered, noReferences)).toBe(expected);
    expect(computeDefinitionDigest(withDigest, noReferences)).toBe(expected);
  });

  it('changes with any content change', () => {
    const tool = body('tools/');
    expect(computeDefinitionDigest(body('tools/', { isIdempotent: false }), noReferences)).not.toBe(
      computeDefinitionDigest(tool, noReferences),
    );
  });

  it('covers the digests of referenced definitions', () => {
    const agent = body('agents/');
    const first = computeDefinitionDigest(agent, everyReference('a'.repeat(64)));
    const second = computeDefinitionDigest(agent, everyReference('b'.repeat(64)));
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
  });

  it('returns undefined when a reference cannot be resolved', () => {
    expect(computeDefinitionDigest(body('units/'), noReferences)).toBeUndefined();
  });
});
