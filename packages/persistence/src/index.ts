import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CapabilityDescriptor, RepositoryPort } from '@multiagentos/contracts';

export class FileRepository<T extends { readonly id: string }> implements RepositoryPort<T> {
  public constructor(private readonly root: string) {}
  async get(id: string): Promise<T | undefined> {
    try {
      return JSON.parse(
        await readFile(join(this.root, `${encodeURIComponent(id)}.json`), 'utf8'),
      ) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async put(record: T): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = join(this.root, `${encodeURIComponent(record.id)}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, undefined, 2), {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, target);
  }
}

export const persistenceCapabilities = (): readonly CapabilityDescriptor[] =>
  Object.freeze([
    {
      capability: 'persistence.file-repository',
      status: 'SUPPORTED',
      schemaNames: ['platform.persistence.Boundary'],
    },
    {
      capability: 'persistence.transactions',
      status: 'UNSUPPORTED',
      schemaNames: ['platform.persistence.Boundary'],
      reason: 'M2+',
    },
    {
      capability: 'persistence.journal',
      status: 'UNSUPPORTED',
      schemaNames: ['platform.persistence.Boundary'],
      reason: 'M2+',
    },
    {
      capability: 'persistence.outbox-inbox',
      status: 'UNSUPPORTED',
      schemaNames: ['platform.persistence.Boundary'],
      reason: 'M2+',
    },
  ]);
