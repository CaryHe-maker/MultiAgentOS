import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactIntegrityError } from './index.js';
import { ArtifactMissingError, GlobalArtifactStore } from './global-store.js';

let dataDir: string;
let store: GlobalArtifactStore;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mao-artifacts-'));
  store = new GlobalArtifactStore(dataDir);
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const fileOf = (sha256: string): string => join(dataDir, 'artifacts', sha256);
const age = async (sha256: string, minutes: number): Promise<void> => {
  const when = new Date(Date.now() - minutes * 60_000);
  await utimes(fileOf(sha256), when, when);
};
const inAMinute = (): string => new Date(Date.now() + 60_000).toISOString();
const MEDIA = 'text/plain; charset=utf-8';

describe('content addressing', () => {
  it('stores globally and gives the same reference for the same content', async () => {
    const first = await store.put(bytes('hello'), MEDIA);
    const second = await store.put(bytes('hello'), MEDIA);
    expect(second).toEqual(first);
    expect(await readdir(join(dataDir, 'artifacts'))).toEqual([first.sha256]);
    expect(await store.get(first)).toEqual(Buffer.from('hello'));
  });

  it('refuses damaged content on read and on a repeated write', async () => {
    const ref = await store.put(bytes('hello'), MEDIA);
    await writeFile(fileOf(ref.sha256), 'jello');
    await expect(store.get(ref)).rejects.toThrow(ArtifactIntegrityError);
    await expect(store.put(bytes('hello'), MEDIA)).rejects.toThrow(ArtifactIntegrityError);
  });

  it('tells a missing body apart', async () => {
    const ref = await store.put(bytes('hello'), MEDIA);
    await rm(fileOf(ref.sha256));
    await expect(store.get(ref)).rejects.toThrow(ArtifactMissingError);
  });
});

describe('sweep', () => {
  it('removes only old bodies outside the retained set', async () => {
    const kept = await store.put(bytes('kept'), MEDIA);
    const stale = await store.put(bytes('stale'), MEDIA);
    await store.put(bytes('recent'), MEDIA);
    await age(kept.sha256, 10);
    await age(stale.sha256, 10);
    const olderThan = new Date(Date.now() - 60_000).toISOString();
    expect(await store.sweep({ retained: new Set([kept.artifactId]), olderThan })).toEqual({
      removed: 1,
    });
    await expect(store.get(stale)).rejects.toThrow(ArtifactMissingError);
    await expect(store.get(kept)).resolves.toBeDefined();
  });

  it('keeps a body written again after the sweep began', async () => {
    const ref = await store.put(bytes('again'), MEDIA);
    await age(ref.sha256, 10);
    const olderThan = new Date(Date.now() - 60_000).toISOString();
    await store.put(bytes('again'), MEDIA);
    expect(await store.sweep({ retained: new Set(), olderThan })).toEqual({ removed: 0 });
    await expect(store.get(ref)).resolves.toBeDefined();
  });

  it('ignores files that are not bodies and an empty store', async () => {
    expect(await store.sweep({ retained: new Set(), olderThan: inAMinute() })).toEqual({
      removed: 0,
    });
    await store.put(bytes('x'), MEDIA);
    await writeFile(join(dataDir, 'artifacts', 'notes.txt'), 'x');
    expect(await store.sweep({ retained: new Set(), olderThan: inAMinute() })).toEqual({
      removed: 1,
    });
    expect(await readdir(join(dataDir, 'artifacts'))).toEqual(['notes.txt']);
  });

  it('never leaves a returned reference without its body', async () => {
    const content = bytes('raced');
    for (let round = 0; round < 25; round += 1) {
      const ref = await store.put(content, MEDIA);
      await age(ref.sha256, 10);
      const olderThan = new Date(Date.now() - 60_000).toISOString();
      const [again] = await Promise.all([
        store.put(content, MEDIA),
        store.sweep({ retained: new Set(), olderThan }),
      ]);
      await expect(store.get(again)).resolves.toBeDefined();
    }
  });
});
