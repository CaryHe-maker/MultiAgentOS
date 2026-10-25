import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  it('reports its availability before start, while running and after stop', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    roots.push(dataDir);
    const artifacts = new LocalArtifactStore(dataDir);
    expect((await artifacts.health()).status).toBe('DOWN');
    await artifacts.start();
    expect((await artifacts.health()).status).toBe('UP');
    await artifacts.stop();
    expect((await artifacts.health()).status).toBe('DOWN');
  });

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

  it('drains accepted writes on stop and retains them across a new store instance', async () => {
    const { store: artifacts, dataDir } = await store();
    const pending = artifacts.put(run, bytes('retained'), 'text/plain');
    await artifacts.stop();
    expect(await readdir(join(dataDir, 'runs', run, 'artifacts'))).toHaveLength(1);
    const ref = await pending;
    await expect(artifacts.put(run, bytes('late'), 'text/plain')).rejects.toThrow(
      'ArtifactStore is stopped',
    );
    const restarted = new LocalArtifactStore(dataDir);
    await restarted.start();
    expect(new TextDecoder().decode(await restarted.get(run, ref))).toBe('retained');
  });

  it('keeps runs apart', async () => {
    const { store: artifacts } = await store();
    const ref = await artifacts.put(run, bytes('private'), 'text/plain');
    await expect(artifacts.get('wfr_another', ref)).rejects.toThrow(ArtifactIntegrityError);
  });

  it('reports a missing artifact as an integrity error', async () => {
    const { store: artifacts, dataDir } = await store();
    const ref = await artifacts.put(run, bytes('gone'), 'text/plain');
    await rm(join(dataDir, 'runs', run, 'artifacts', ref.sha256));
    await expect(artifacts.get(run, ref)).rejects.toThrow(ArtifactIntegrityError);
  });

  it('refuses damaged content and malformed run ids', async () => {
    const { store: artifacts, dataDir } = await store();
    const ref = await artifacts.put(run, bytes('original'), 'text/plain');
    await writeFile(join(dataDir, 'runs', run, 'artifacts', ref.sha256), 'tampered');
    await expect(artifacts.get(run, ref)).rejects.toThrow(ArtifactIntegrityError);
    await expect(artifacts.put(run, bytes('original'), 'text/plain')).rejects.toThrow(
      ArtifactIntegrityError,
    );
    await expect(artifacts.put('../escape', bytes('x'), 'text/plain')).rejects.toThrow(
      'Invalid workflowRunId',
    );
  });

  it('rejects a malformed reference before attempting to read its path', async () => {
    const { store: artifacts } = await store();
    const ref = await artifacts.put(run, bytes('private'), 'text/plain');
    await expect(artifacts.get(run, { ...ref, sha256: '../workflow/record' })).rejects.toThrow(
      ArtifactIntegrityError,
    );
    await expect(artifacts.get(run, { ...ref, artifactId: 'art_wrong' })).rejects.toThrow(
      ArtifactIntegrityError,
    );
  });

  it('does not publish a reference when the temporary directory is unavailable', async () => {
    const { store: artifacts, dataDir } = await store();
    await rm(join(dataDir, 'tmp'), { recursive: true });
    await writeFile(join(dataDir, 'tmp'), 'blocked');
    await expect(artifacts.put(run, bytes('unpublished'), 'text/plain')).rejects.toThrow();
    const directory = join(dataDir, 'runs', run, 'artifacts');
    expect(await readdir(directory)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects run directories redirected by symlinks',
    async () => {
      const { store: artifacts, dataDir } = await store();
      const outside = await mkdtemp(join(tmpdir(), 'artifact-outside-'));
      roots.push(outside);
      await symlink(outside, join(dataDir, 'runs'), 'dir');
      await expect(artifacts.put(run, bytes('private'), 'text/plain')).rejects.toThrow(
        ArtifactIntegrityError,
      );
      expect(await readdir(outside)).toEqual([]);
    },
  );
});
