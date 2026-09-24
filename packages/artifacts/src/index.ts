import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactRef, ArtifactStorePort, CapabilityDescriptor } from '@multiagentos/contracts';

export class ArtifactIntegrityError extends Error {}

export class LocalArtifactStore implements ArtifactStorePort {
  public constructor(private readonly root: string) {}
  async put(content: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const artifactId = `art_${randomUUID().replaceAll('-', '')}`;
    await mkdir(this.root, { recursive: true });
    const target = join(this.root, sha256);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      const existing = await readFile(target);
      const existingDigest = createHash('sha256').update(existing).digest('hex');
      await unlink(temporary);
      if (existingDigest !== sha256 || existing.byteLength !== content.byteLength) {
        throw new ArtifactIntegrityError(`Existing artifact content mismatch: ${sha256}`);
      }
    }
    return Object.freeze({ artifactId, mediaType, sha256, size: content.byteLength });
  }
  async get(ref: ArtifactRef): Promise<Uint8Array> {
    const content = await readFile(join(this.root, ref.sha256));
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== ref.sha256 || content.byteLength !== ref.size)
      throw new ArtifactIntegrityError(`Artifact integrity mismatch: ${ref.artifactId}`);
    return content;
  }
  capabilities(): readonly CapabilityDescriptor[] {
    return Object.freeze([
      {
        capability: 'artifact.local-content-addressing',
        status: 'SUPPORTED',
        schemaNames: ['platform.artifact.Boundary'],
      },
      {
        capability: 'artifact.retention',
        status: 'UNSUPPORTED',
        schemaNames: ['platform.artifact.Boundary'],
        reason: 'M4+',
      },
      {
        capability: 'artifact.remote-store',
        status: 'UNSUPPORTED',
        schemaNames: ['platform.artifact.Boundary'],
        reason: 'M5+',
      },
    ]);
  }
}
