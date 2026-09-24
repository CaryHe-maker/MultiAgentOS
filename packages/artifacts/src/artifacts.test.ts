import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactIntegrityError, LocalArtifactStore } from './index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('FR-ART-001 FR-ART-002 artifact integrity', () => {
  it('uses content addressing and verifies reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multiagentos-artifacts-'));
    roots.push(root);
    const store = new LocalArtifactStore(root);
    const ref = await store.put(Buffer.from('evidence'), 'text/plain');
    const duplicate = await store.put(Buffer.from('evidence'), 'text/plain');
    expect(Buffer.from(await store.get(ref)).toString()).toBe('evidence');
    expect(duplicate.sha256).toBe(ref.sha256);
    await writeFile(join(root, ref.sha256), 'tampered');
    await expect(store.get(ref)).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });
});
