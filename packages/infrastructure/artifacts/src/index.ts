import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  IdSchemas,
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
  public constructor(message: string) {
    super(message);
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

  public constructor(dataDir: string) {
    if (!isAbsolute(dataDir)) throw new Error('dataDir must be an absolute path');
    this.#dataDir = dataDir;
  }

  async start(): Promise<void> {
    await mkdir(join(this.#dataDir, 'tmp'), { recursive: true });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: [] });
  }

  async put(workflowRunId: string, content: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    const sha256 = sha256Hex(content);
    const ref: ArtifactRef = Object.freeze({
      artifactId: `art_${sha256}`,
      mediaType,
      sha256,
      size: content.byteLength,
    });
    const directory = this.#directory(workflowRunId);
    const target = join(directory, sha256);
    if (await this.#matches(target, ref)) return ref;
    await mkdir(directory, { recursive: true });
    await mkdir(join(this.#dataDir, 'tmp'), { recursive: true });
    const temporary = join(this.#dataDir, 'tmp', randomUUID());
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      // An unfinished or damaged write must never become a usable reference.
      if (!(await this.#matches(temporary, ref)))
        throw new ArtifactIntegrityError(`Write of ${ref.artifactId} could not be verified`);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return ref;
  }

  async get(workflowRunId: string, ref: ArtifactRef): Promise<Uint8Array> {
    let content: Uint8Array;
    try {
      content = await readFile(join(this.#directory(workflowRunId), ref.sha256));
    } catch {
      throw new ArtifactIntegrityError(`Artifact ${ref.artifactId} is not stored`);
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

  async #matches(path: string, ref: ArtifactRef): Promise<boolean> {
    try {
      const content = await readFile(path);
      return content.byteLength === ref.size && sha256Hex(content) === ref.sha256;
    } catch {
      return false;
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
