import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GlobalArtifactStore } from '@multiagentos/artifacts';
import {
  createProtocolRegistry,
  newId,
  type ArtifactOwnerLine,
  type ArtifactRef,
  type SessionRefLine,
} from '@multiagentos/contracts';
import { InProcessFabric } from '@multiagentos/fabric';
import { DEFAULT_KERNEL_CONFIG, createSessionKernelCore } from '@multiagentos/kernel';
import { FileSessionStore } from '@multiagentos/persistence';
import { afterEach, describe, expect, it } from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

/** The real store and index files, and a Kernel core whose clock is eight days ahead of them. */
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-sweep-'));
  directories.push(dataDir);
  const store = new GlobalArtifactStore(dataDir);
  const persistence = new FileSessionStore(dataDir);
  const repositoryRoot = dataDir;
  const written = new Date();
  const refs = persistence.appendLog<SessionRefLine>('kernel-core', {
    scope: 'SYSTEM',
    file: 'session-refs',
  });
  const session = async (status: SessionRefLine['status']) => {
    const sessionId = newId('ses');
    await refs.append({ sessionId, repositoryRoot, status, at: written.toISOString() });
    return sessionId;
  };
  const own = async (sessionId: string, ref: ArtifactRef, retention: 'SESSION' | 'EXPIRING') => {
    const at = written.toISOString();
    const line: ArtifactOwnerLine = {
      artifactId: ref.artifactId,
      mediaType: ref.mediaType,
      sha256: ref.sha256,
      size: ref.size,
      retention,
      source: 'PRODUCED',
      retainedSince: at,
      at,
    };
    await persistence
      .appendLog<ArtifactOwnerLine>('kernel-execution', {
        scope: 'SESSION',
        sessionId,
        file: 'artifact-owners',
      })
      .append(line);
  };
  const put = (text: string) => store.put(Buffer.from(text), 'text/plain');
  const diagnostics: string[] = [];
  const core = createSessionKernelCore({
    fabric: new InProcessFabric(createProtocolRegistry()).client('kernel-core'),
    artifacts: store,
    persistence,
    registry: createProtocolRegistry(),
    pinAgent: () => Promise.reject(new Error('unused')),
    compactionAgent: () => undefined,
    mainBudget: {
      perCallInputLimit: 1_000,
      maxOutputTokens: 100,
      finalInputBudget: 1_000,
      finalMaxOutputTokens: 100,
    },
    config: DEFAULT_KERNEL_CONFIG,
    repositoryRoot,
    preset: 'readonly',
    readRepositoryFile: () => Promise.resolve(undefined),
    diagnostic: (line) => diagnostics.push(line),
    now: () => new Date(written.getTime() + 8 * DAY_MS),
  });
  const exists = async (ref: ArtifactRef) =>
    store.get(ref).then(
      () => true,
      () => false,
    );
  return { dataDir, core, session, own, put, exists, diagnostics };
}

describe('the sweep when the Kernel core starts (Kernel/Execution 6)', () => {
  it('removes what no ACTIVE Session keeps, before it serves', async () => {
    const { core, session, own, put, exists, diagnostics } = await setup();
    const active = await session('ACTIVE');
    const deleted = await session('DELETED');
    const kept = await put('kept by an active Session');
    const expired = await put('expired in an active Session');
    const orphan = await put('kept only by a deleted Session');
    const nobody = await put('owned by nobody');
    await own(active, kept, 'SESSION');
    await own(active, expired, 'EXPIRING');
    await own(deleted, orphan, 'SESSION');

    await core.start();
    await core.stop();

    expect(await exists(kept)).toBe(true);
    expect(await exists(expired)).toBe(false);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(nobody)).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  it('still starts when an index cannot be read, and removes nothing', async () => {
    const { dataDir, core, session, put, exists, diagnostics } = await setup();
    const active = await session('ACTIVE');
    const body = await put('owned by nobody');
    const index = join(dataDir, 'sessions', active, 'kernel-execution', 'artifact-owners.jsonl');
    await mkdir(dirname(index), { recursive: true });
    await appendFile(index, 'not json\n');

    await expect(core.start()).resolves.toBeUndefined();
    await core.stop();

    expect(await exists(body)).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('artifact sweep failed');
  });
});
