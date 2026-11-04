import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  ArtifactRefSchema,
  sha256Hex,
  validate,
  type ArtifactRef,
  type ArtifactStorePort,
  type CapabilityDescriptor,
  type HealthStatus,
  type LifecyclePort,
} from '@multiagentos/contracts';
import { ArtifactIntegrityError } from './integrity-error.js';

export class ArtifactMissingError extends Error {
  public constructor(artifactId: string) {
    super(`Artifact ${artifactId} is not stored`);
    this.name = 'ArtifactMissingError';
  }
}

const SHA256_NAME = /^[a-f0-9]{64}$/u;

/**
 * M2 content-addressed store (Infrastructure/ArtifactStore): `<dataDir>/artifacts/<sha256>`,
 * shared by every Session. Ownership and retention belong to Execution; this store only keeps
 * and removes bodies. `put` and the check-then-delete of `sweep` exclude each other per body, so
 * a returned reference never points at a body a sweep is about to remove.
 */
export class GlobalArtifactStore implements ArtifactStorePort, LifecyclePort {
  readonly manifest = { moduleId: 'artifact-store', version: '0.2.0', dependencies: [] } as const;
  readonly #dataDir: string;
  readonly #directory: string;
  readonly #locks = new Map<string, Promise<unknown>>();

  public constructor(dataDir: string) {
    if (!isAbsolute(dataDir)) throw new Error('dataDir must be an absolute path');
    this.#dataDir = dataDir;
    this.#directory = join(dataDir, 'artifacts');
  }

  #exclusive<T>(sha256: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sha256) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.#locks.set(sha256, current);
    const forget = (): void => {
      if (this.#locks.get(sha256) === current) this.#locks.delete(sha256);
    };
    current.then(forget, forget);
    return current;
  }

  put(content: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    const sha256 = sha256Hex(content);
    const ref: ArtifactRef = Object.freeze({
      artifactId: `art_${sha256}`,
      mediaType,
      sha256,
      size: content.byteLength,
    });
    if (!validate(ArtifactRefSchema, ref).ok)
      return Promise.reject(new ArtifactIntegrityError('Invalid artifact reference fields'));
    return this.#exclusive(sha256, async () => {
      await this.#assertDirectories();
      const target = join(this.#directory, sha256);
      const existing = await readIfExists(target);
      if (existing !== undefined) {
        if (!matches(existing, ref))
          throw new ArtifactIntegrityError(`Stored artifact ${ref.artifactId} failed verification`);
        // A sweep that already started must not remove a body that was just written again.
        const now = new Date();
        await utimes(target, now, now);
        return ref;
      }
      const temporary = join(this.#dataDir, 'tmp', randomUUID());
      try {
        await writeFile(temporary, content, { flag: 'wx' });
        if (!matches(await readFile(temporary), ref))
          throw new ArtifactIntegrityError(`Write of ${ref.artifactId} could not be verified`);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      return ref;
    });
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    if (!validate(ArtifactRefSchema, ref).ok)
      throw new ArtifactIntegrityError('Invalid artifact reference');
    await this.#assertNotLink(join(this.#directory, ref.sha256));
    const content = await readIfExists(join(this.#directory, ref.sha256));
    if (content === undefined) throw new ArtifactMissingError(ref.artifactId);
    if (!matches(content, ref))
      throw new ArtifactIntegrityError(`Artifact ${ref.artifactId} failed verification`);
    return content;
  }

  async sweep(input: {
    readonly retained: ReadonlySet<string>;
    readonly olderThan: string;
  }): Promise<{ readonly removed: number }> {
    const cutoff = new Date(input.olderThan).getTime();
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0 };
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      if (!SHA256_NAME.test(name) || input.retained.has(`art_${name}`)) continue;
      const deleted = await this.#exclusive(name, async () => {
        const path = join(this.#directory, name);
        try {
          if ((await stat(path)).mtimeMs >= cutoff) return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
        await rm(path, { force: true });
        return true;
      });
      if (deleted) removed += 1;
    }
    return { removed };
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  /** Waits for writes already started; nothing new is refused, the store has no open state. */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.#locks.values()]);
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: [] });
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return [
      { capability: 'artifact.local-content-addressing', status: 'SUPPORTED', schemaNames: [] },
      { capability: 'artifact.retention', status: 'SUPPORTED', schemaNames: [] },
    ];
  }

  async #assertNotLink(path: string): Promise<void> {
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new ArtifactIntegrityError('Artifact path contains a symbolic link');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async #assertDirectories(): Promise<void> {
    await this.#assertNotLink(this.#directory);
    await this.#assertNotLink(join(this.#dataDir, 'tmp'));
    await mkdir(this.#directory, { recursive: true });
    await mkdir(join(this.#dataDir, 'tmp'), { recursive: true });
  }
}

async function readIfExists(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function matches(content: Uint8Array, ref: ArtifactRef): boolean {
  return content.byteLength === ref.size && sha256Hex(content) === ref.sha256;
}
