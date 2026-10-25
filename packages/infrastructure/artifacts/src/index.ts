import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  IdSchemas,
  ArtifactRefSchema,
  sha256Hex,
  validate,
  type ArtifactRef,
  type ArtifactStorePort,
  type CapabilityDescriptor,
  type HealthStatus,
  type LifecyclePort,
} from '@multiagentos/contracts';

/** Stored content does not match its reference, or a write could not be verified. */
export class ArtifactIntegrityError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtifactIntegrityError';
  }
}

/**
 * Local content-addressed store (docs/M1/Infrastructure/ArtifactStore.md):
 * `<dataDir>/runs/<workflowRunId>/artifacts/<sha256>`, with `artifactId = 'art_' + sha256`.
 * It does not decide access: Execution checks ownership before every read.
 */
export class LocalArtifactStore implements ArtifactStorePort, LifecyclePort {
  readonly manifest = { moduleId: 'artifact-store', version: '0.1.0', dependencies: [] } as const;
  readonly #dataDir: string;
  readonly #pending = new Set<Promise<ArtifactRef>>();
  #acceptingWrites = false;

  public constructor(dataDir: string) {
    if (!isAbsolute(dataDir)) throw new Error('dataDir must be an absolute path');
    this.#dataDir = dataDir;
  }

  async start(): Promise<void> {
    await this.#assertNoSymlink('tmp');
    await mkdir(join(this.#dataDir, 'tmp'), { recursive: true });
    await this.#assertNoSymlink('tmp');
    this.#acceptingWrites = true;
  }

  async stop(): Promise<void> {
    this.#acceptingWrites = false;
    await Promise.allSettled([...this.#pending]);
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({
      status: this.#acceptingWrites ? 'UP' : 'DOWN',
      checkedAt: new Date().toISOString(),
      details: [],
    });
  }

  put(workflowRunId: string, content: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    if (!this.#acceptingWrites) return Promise.reject(new Error('ArtifactStore is stopped'));
    const pending = this.#put(workflowRunId, content, mediaType);
    this.#pending.add(pending);
    const done = () => this.#pending.delete(pending);
    pending.then(done, done);
    return pending;
  }

  async #put(workflowRunId: string, content: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    if (!(content instanceof Uint8Array))
      throw new ArtifactIntegrityError('Invalid artifact content');
    const sha256 = sha256Hex(content);
    const ref: ArtifactRef = Object.freeze({
      artifactId: `art_${sha256}`,
      mediaType,
      sha256,
      size: content.byteLength,
    });
    if (!validate(ArtifactRefSchema, ref).ok)
      throw new ArtifactIntegrityError('Invalid artifact reference fields');
    const directory = this.#directory(workflowRunId);
    const target = join(directory, sha256);
    await this.#assertNoSymlink('runs', workflowRunId, 'artifacts', sha256);
    const existing = await this.#readIfExists(target);
    if (existing !== undefined) {
      if (!this.#matches(existing, ref))
        throw new ArtifactIntegrityError(`Stored artifact ${ref.artifactId} failed verification`);
      return ref;
    }
    await mkdir(directory, { recursive: true });
    await mkdir(join(this.#dataDir, 'tmp'), { recursive: true });
    await this.#assertNoSymlink('runs', workflowRunId, 'artifacts', sha256);
    await this.#assertNoSymlink('tmp');
    const temporary = join(this.#dataDir, 'tmp', randomUUID());
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      // An unfinished or damaged write must never become a usable reference.
      if (!this.#matches(await readFile(temporary), ref))
        throw new ArtifactIntegrityError(`Write of ${ref.artifactId} could not be verified`);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return ref;
  }

  async get(workflowRunId: string, ref: ArtifactRef): Promise<Uint8Array> {
    if (!validate(ArtifactRefSchema, ref).ok)
      throw new ArtifactIntegrityError('Invalid artifact reference');
    const directory = this.#directory(workflowRunId);
    await this.#assertNoSymlink('runs', workflowRunId, 'artifacts', ref.sha256);
    let content: Uint8Array;
    try {
      content = await readFile(join(directory, ref.sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ArtifactIntegrityError(`Artifact ${ref.artifactId} is not stored`, {
          cause: error,
        });
      throw error;
    }
    if (content.byteLength !== ref.size || sha256Hex(content) !== ref.sha256)
      throw new ArtifactIntegrityError(`Artifact ${ref.artifactId} failed verification`);
    return content;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return ARTIFACT_CAPABILITIES;
  }

  #directory(workflowRunId: string): string {
    // The id becomes a path segment, so it must have the exact identifier shape.
    if (!validate(IdSchemas.workflowRunId, workflowRunId).ok)
      throw new Error('Invalid workflowRunId');
    return join(this.#dataDir, 'runs', workflowRunId, 'artifacts');
  }

  async #readIfExists(path: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  #matches(content: Uint8Array, ref: ArtifactRef): boolean {
    return content.byteLength === ref.size && sha256Hex(content) === ref.sha256;
  }

  async #assertNoSymlink(...segments: string[]): Promise<void> {
    let path = this.#dataDir;
    for (const segment of segments) {
      path = join(path, segment);
      try {
        if ((await lstat(path)).isSymbolicLink())
          throw new ArtifactIntegrityError('Artifact path contains a symbolic link');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }
}

const ARTIFACT_CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze([
  { capability: 'artifact.local-content-addressing', status: 'SUPPORTED', schemaNames: [] },
  {
    capability: 'artifact.retention',
    status: 'UNSUPPORTED',
    schemaNames: ['platform.artifact.RetentionTokenRef.v0'],
    reason: 'M1 keeps artifacts with the run directory',
  },
]);
