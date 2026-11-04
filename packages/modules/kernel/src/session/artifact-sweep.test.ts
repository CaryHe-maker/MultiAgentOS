import { createHash } from 'node:crypto';
import type {
  AppendLogPort,
  ArtifactOwnerLine,
  ArtifactRef,
  ArtifactStorePort,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { ArtifactSweep } from './artifact-sweep.js';
import { SessionArtifacts } from './session-artifacts.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-11-02T00:00:00.000Z');

function setup() {
  let now = START;
  const bodies = new Map<string, { content: Uint8Array; writtenAt: number }>();
  const store: ArtifactStorePort = {
    put: (content, mediaType) => {
      const sha256 = createHash('sha256').update(content).digest('hex');
      bodies.set(sha256, { content, writtenAt: now });
      return Promise.resolve({
        artifactId: `art_${sha256}`,
        sha256,
        size: content.byteLength,
        mediaType,
      });
    },
    get: (ref) => {
      const body = bodies.get(ref.sha256);
      return body === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(body.content);
    },
    sweep: ({ retained, olderThan }) => {
      let removed = 0;
      for (const [sha256, body] of bodies)
        if (!retained.has(`art_${sha256}`) && body.writtenAt < Date.parse(olderThan)) {
          bodies.delete(sha256);
          removed += 1;
        }
      return Promise.resolve({ removed });
    },
    capabilities: () => [],
  };
  const logs = new Map<string, ArtifactOwnerLine[]>();
  const ownersOf = (sessionId: string): AppendLogPort<ArtifactOwnerLine> => {
    const lines = logs.get(sessionId) ?? [];
    logs.set(sessionId, lines);
    return {
      append: (line) => {
        lines.push(line);
        return Promise.resolve();
      },
      async *readAll() {
        await Promise.resolve();
        yield* lines;
      },
      repairTail: () => Promise.resolve({ truncatedBytes: 0 }),
    };
  };
  const open = (sessionId: string) =>
    new SessionArtifacts({
      store,
      owners: ownersOf(sessionId),
      expiringRetentionDays: 7,
      now: () => new Date(now),
    });
  const active = new Set<string>();
  const reports: unknown[] = [];
  const sweep = new ArtifactSweep({
    store,
    activeSessionIds: () => [...active],
    ownersOf,
    expiringRetentionDays: 7,
    now: () => new Date(now),
    report: (error) => reports.push(error),
  });
  return {
    store,
    open,
    active,
    reports,
    sweep,
    has: (ref: ArtifactRef) => bodies.has(ref.sha256),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('artifact sweep (Kernel/Execution 6)', () => {
  it('keeps EXPIRING bodies for the retention period and removes them after it', async () => {
    const { open, active, sweep, has, advance } = setup();
    active.add('ses_a');
    const artifacts = open('ses_a');
    const ref = await artifacts.put('full', 'text/plain', 'EXPIRING');
    advance(7 * DAY_MS - 1);
    await sweep.run();
    expect(has(ref)).toBe(true);
    advance(1);
    await expect(artifacts.read(ref)).resolves.toEqual({
      ok: false,
      reasonCode: 'ARTIFACT_EXPIRED',
    });
    await sweep.run();
    expect(has(ref)).toBe(false);
    await expect(artifacts.read(ref)).resolves.toEqual({
      ok: false,
      reasonCode: 'ARTIFACT_EXPIRED',
    });
  });

  it('keeps SESSION bodies as long as an ACTIVE Session owns them', async () => {
    const { open, active, sweep, has, advance } = setup();
    active.add('ses_a');
    const ref = await open('ses_a').put('preview', 'text/plain', 'SESSION');
    advance(365 * DAY_MS);
    await sweep.run();
    expect(has(ref)).toBe(true);
  });

  it('lets a DELETED Session keep nothing, even with its index left behind', async () => {
    const { open, sweep, has, advance } = setup();
    const ref = await open('ses_deleted').put('preview', 'text/plain', 'SESSION');
    advance(1);
    await sweep.run();
    expect(has(ref)).toBe(false);
  });

  it('keeps a body when any Session still needs it', async () => {
    const { open, active, sweep, has, advance } = setup();
    active.add('ses_a').add('ses_b');
    const ref = await open('ses_a').put('shared', 'text/plain', 'EXPIRING');
    await open('ses_b').put('shared', 'text/plain', 'SESSION');
    advance(30 * DAY_MS);
    await sweep.run();
    expect(has(ref)).toBe(true);
  });

  it('uses the last registration of an artifact', async () => {
    const { open, active, sweep, has, advance } = setup();
    active.add('ses_a');
    const artifacts = open('ses_a');
    const ref = await artifacts.put('body', 'text/plain', 'EXPIRING');
    advance(6 * DAY_MS);
    await artifacts.put('body', 'text/plain', 'EXPIRING');
    advance(6 * DAY_MS);
    await sweep.run();
    expect(has(ref)).toBe(true);
  });

  it('never removes a body written after the sweep began', async () => {
    const { open, sweep, has } = setup();
    const ref = await open('ses_a').put('new', 'text/plain', 'EXPIRING');
    await sweep.run();
    expect(has(ref)).toBe(true);
  });

  it('removes nothing when an index cannot be read, and reports it', async () => {
    const { store, reports, has, open, advance } = setup();
    const ref = await open('ses_gone').put('body', 'text/plain', 'SESSION');
    advance(1);
    const failing = new ArtifactSweep({
      store,
      activeSessionIds: () => ['ses_a'],
      ownersOf: () => ({
        append: () => Promise.resolve(),
        // eslint-disable-next-line require-yield
        async *readAll() {
          await Promise.resolve();
          throw new Error('incomplete last line');
        },
        repairTail: () => Promise.resolve({ truncatedBytes: 0 }),
      }),
      expiringRetentionDays: 7,
      now: () => new Date(START + 1),
      report: (error) => reports.push(error),
    });
    await expect(failing.run()).resolves.toBeUndefined();
    expect(has(ref)).toBe(true);
    expect(reports).toHaveLength(1);
  });

  it('skips a sweep while the previous one is running', async () => {
    let sweeps = 0;
    let finish: () => void = () => undefined;
    const sweep = new ArtifactSweep({
      store: {
        sweep: () => {
          sweeps += 1;
          return new Promise((resolve) => {
            finish = () => resolve({ removed: 0 });
          });
        },
      },
      activeSessionIds: () => [],
      ownersOf: () => {
        throw new Error('unused');
      },
      expiringRetentionDays: 7,
      now: () => new Date(START),
      report: () => undefined,
    });
    const first = sweep.run();
    await Promise.resolve();
    await Promise.resolve();
    void sweep.run();
    await Promise.resolve();
    expect(sweeps).toBe(1);
    finish();
    await first;
    await sweep.finished();
    void sweep.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(sweeps).toBe(2);
    finish();
    await sweep.finished();
  });
});
