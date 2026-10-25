import type { ArtifactRef } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { ArtifactOwnership, ArtifactOwnershipError } from './artifact-ownership.js';

const sha = 'a'.repeat(64);
const ref: ArtifactRef = {
  artifactId: `art_${sha}`,
  mediaType: 'application/vnd.multiagentos.context-pack+json',
  sha256: sha,
  size: 3,
};

describe('ArtifactOwnership', () => {
  it('registers the same reference for multiple producers without replacing it', () => {
    const ownership = new ArtifactOwnership();
    ownership.register(ref, 'una_000001');
    ownership.register(ref, 'una_000002');

    expect(ownership.owns(ref)).toBe(true);
    expect(ownership.get(ref)).toEqual(ref);
  });

  it('treats mediaType as part of the reference identity', () => {
    const ownership = new ArtifactOwnership();
    ownership.register(ref, 'una_000001');
    const other: ArtifactRef = { ...ref, mediaType: 'text/plain; charset=utf-8' };

    expect(ownership.owns(other)).toBe(false);
    ownership.register(other, 'una_000002');
    expect(ownership.owns(ref)).toBe(true);
    expect(ownership.owns(other)).toBe(true);
  });

  it('rejects conflicting integrity fields for the same reference identity', () => {
    const ownership = new ArtifactOwnership();
    ownership.register(ref, 'una_000001');

    expect(() => ownership.register({ ...ref, size: 4 }, 'una_000002')).toThrow(
      ArtifactOwnershipError,
    );
  });

  it('does not own an unregistered reference', () => {
    const ownership = new ArtifactOwnership();
    expect(ownership.owns(ref)).toBe(false);
    expect(ownership.get(ref)).toBeUndefined();
  });
});
