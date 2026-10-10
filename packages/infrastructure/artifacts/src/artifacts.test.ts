import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactIntegrityError, LocalArtifactStore } from './index.js';

const roots: string[] = [];
async function store(): Promise<{ store: LocalArtifactStore; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'artifact-store-'));
  roots.push(dataDir);
  const created = new LocalArtifactStore(dataDir);
  await created.start();
  return { store: created, dataDir };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const run = 'wfr_123456';
const bytes = (text: string) => new TextEncoder().encode(text);

describe('LocalArtifactStore', () => {
  it('stores content under its hash and reads it back verified', async () => {
    const { store: artifacts, dataDir } = await store();
    const ref = await artifacts.put(run, bytes('hello'), 'text/plain; charset=utf-8');
    expect(ref.artifactId).toBe(`art_${ref.sha256}`);
    expect(ref.size).toBe(5);
    expect(await readdir(join(dataDir, 'runs', run, 'artifacts'))).toEqual([ref.sha256]);
    expect(new TextDecoder().decode(await artifacts.get(run, ref))).toBe('hello');
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([]);
  });

  it('returns the same reference for the same content', async () => {
    const { store: artifacts } = await store();
    const first = await artifacts.put(run, bytes('same'), 'text/plain');
    expect(await artifacts.put(run, bytes('same'), 'text/plain')).toEqual(first);
  });

  it('keeps runs apart', async () => {
    const { store: artifacts } = await store();
    const ref = await artifacts.put(run, bytes('private'), 'text/plain');
    await expect(artifacts.get('wfr_another', ref)).rejects.toThrow(ArtifactIntegrityError);
  });

  it('refuses damaged content and malformed run ids', async () => {
    const { store: artifacts, dataDir } = await store();
    const ref = await artifacts.put(run, bytes('original'), 'text/plain');
    await writeFile(join(dataDir, 'runs', run, 'artifacts', ref.sha256), 'tampered');
    await expect(artifacts.get(run, ref)).rejects.toThrow(ArtifactIntegrityError);
    await expect(artifacts.put('../escape', bytes('x'), 'text/plain')).rejects.toThrow(
      'Invalid workflowRunId',
    );
  });
});
