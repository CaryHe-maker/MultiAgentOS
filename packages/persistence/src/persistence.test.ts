import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRepository, persistenceCapabilities } from './index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('FR-PER-001..003 file persistence', () => {
  it('round-trips records behind RepositoryPort', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multiagentos-repo-'));
    roots.push(root);
    const repository = new FileRepository<{ readonly id: string; readonly state: string }>(root);
    await repository.put({ id: 'run-1', state: 'CREATED' });
    await expect(repository.get('run-1')).resolves.toEqual({ id: 'run-1', state: 'CREATED' });
  });
  it('reports durable features as unsupported', () => {
    expect(persistenceCapabilities().filter((item) => item.status === 'UNSUPPORTED')).toHaveLength(
      3,
    );
  });
});
