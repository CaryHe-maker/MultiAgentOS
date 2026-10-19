import type { ArtifactRef } from '@multiagentos/contracts';

interface Entry {
  readonly ref: ArtifactRef;
  readonly producers: Set<string>;
}

/** The same content was registered with different integrity fields. */
export class ArtifactOwnershipError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactOwnershipError';
  }
}

/**
 * Per-run artifact ownership (docs/M1/Kernel/Execution.md 4). The index is authoritative for
 * "does this reference belong to this run"; ArtifactStore remains authoritative for content.
 * A reference is identified by artifactId and mediaType, and its integrity fields must match.
 */
export class ArtifactOwnership {
  readonly #entries = new Map<string, Entry>();

  public register(ref: ArtifactRef, producer: string): void {
    const key = keyOf(ref);
    const existing = this.#entries.get(key);
    if (existing === undefined) {
      this.#entries.set(key, { ref: Object.freeze({ ...ref }), producers: new Set([producer]) });
      return;
    }
    if (existing.ref.sha256 !== ref.sha256 || existing.ref.size !== ref.size)
      throw new ArtifactOwnershipError(
        `Conflicting integrity fields for ${ref.artifactId} (${ref.mediaType})`,
      );
    existing.producers.add(producer);
  }

  public owns(ref: ArtifactRef): boolean {
    const entry = this.#entries.get(keyOf(ref));
    return (
      entry !== undefined &&
      entry.ref.sha256 === ref.sha256 &&
      entry.ref.size === ref.size &&
      entry.ref.artifactId === ref.artifactId
    );
  }

  /** The registered reference, or undefined when this run does not own it. */
  public get(ref: ArtifactRef): ArtifactRef | undefined {
    return this.owns(ref) ? this.#entries.get(keyOf(ref))?.ref : undefined;
  }
}

function keyOf(ref: ArtifactRef): string {
  return `${ref.artifactId}\u0000${ref.mediaType}`;
}
