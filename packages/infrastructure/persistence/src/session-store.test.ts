import { mkdtemp, readFile, rm, symlink, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRefLineSchema, newId } from '@multiagentos/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileInstanceLock,
  FileSessionStore,
  NamespaceViolationError,
  acquireSessionLock,
  type ProcessProbe,
} from './session-store.js';

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mao-session-store-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const collect = async <T>(records: AsyncIterable<T>): Promise<T[]> => {
  const all: T[] = [];
  for await (const record of records) all.push(record);
  return all;
};
const sessionId = newId('ses');
const logPath = { scope: 'SESSION', sessionId, file: 'log' } as const;
const logFile = (): string => join(dataDir, 'sessions', sessionId, 'workflow', 'log.v1.jsonl');

describe('append-only log', () => {
  it('appends lines and reads them back in order', async () => {
    const log = new FileSessionStore(dataDir).appendLog<{ n: number }>('workflow', logPath);
    await Promise.all([1, 2, 3].map((n) => log.append({ n })));
    expect(await collect(log.readAll())).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('keeps the existing prefix byte for byte', async () => {
    const log = new FileSessionStore(dataDir).appendLog<{ n: number }>('workflow', logPath);
    await log.append({ n: 1 });
    const before = await readFile(logFile());
    await log.append({ n: 2 });
    expect((await readFile(logFile())).subarray(0, before.length).equals(before)).toBe(true);
  });

  it('reads nothing from a log that does not exist', async () => {
    const log = new FileSessionStore(dataDir).appendLog('workflow', logPath);
    expect(await collect(log.readAll())).toEqual([]);
    expect(await log.repairTail()).toEqual({ truncatedBytes: 0 });
  });

  it('cuts only an incomplete last line', async () => {
    const log = new FileSessionStore(dataDir).appendLog<{ n: number }>('workflow', logPath);
    await log.append({ n: 1 });
    await writeFile(logFile(), `${JSON.stringify({ n: 1 })}\n{"n":`);
    await expect(collect(log.readAll())).rejects.toThrow('incomplete last line');
    expect(await log.repairTail()).toEqual({ truncatedBytes: 5 });
    expect(await collect(log.readAll())).toEqual([{ n: 1 }]);
    expect(await log.repairTail()).toEqual({ truncatedBytes: 0 });
  });

  it('fails instead of skipping a line that breaks the Schema', async () => {
    const store = new FileSessionStore(dataDir, { 'session-refs': SessionRefLineSchema });
    const log = store.appendLog('kernel-core', { scope: 'SYSTEM', file: 'session-refs' });
    await log.append({ wrong: true });
    await expect(collect(log.readAll())).rejects.toThrow('Contract validation failed');
  });

  it('keeps going after a failed append', async () => {
    const store = new FileSessionStore(dataDir);
    const log = store.appendLog<{ n: number }>('workflow', logPath);
    const looped: { self?: unknown } = {};
    looped.self = looped;
    await expect(log.append(looped as never)).rejects.toThrow();
    await log.append({ n: 1 });
    expect(await collect(log.readAll())).toEqual([{ n: 1 }]);
  });
});

describe('namespaces and paths', () => {
  it.each([
    ['workflow', 'audit'],
    ['workflow', 'artifact-owners'],
    ['kernel-core', 'log'],
    ['kernel-execution', 'log'],
  ] as const)('refuses %s touching %s', (namespace, file) => {
    const store = new FileSessionStore(dataDir);
    expect(() => store.appendLog(namespace, { scope: 'SESSION', sessionId, file })).toThrow(
      NamespaceViolationError,
    );
  });

  it('refuses a malformed sessionId before building a path', () => {
    const store = new FileSessionStore(dataDir);
    expect(() =>
      store.appendLog('workflow', { scope: 'SESSION', sessionId: '../x', file: 'log' }),
    ).toThrow('invalid sessionId');
  });

  it('refuses a symbolic link in the path', async () => {
    const outside = join(dataDir, 'outside');
    await mkdir(outside);
    await mkdir(join(dataDir, 'sessions', sessionId), { recursive: true });
    await symlink(outside, join(dataDir, 'sessions', sessionId, 'workflow'));
    const log = new FileSessionStore(dataDir).appendLog('workflow', logPath);
    await expect(log.append({})).rejects.toThrow('symlink refused');
  });
});

describe('session directory', () => {
  it('creates once and removes only its own namespace', async () => {
    const store = new FileSessionStore(dataDir);
    const directory = store.sessionDirectory('workflow', sessionId);
    await directory.create();
    await expect(directory.create()).rejects.toThrow();
    const audit = store.appendLog('kernel-core', { scope: 'SESSION', sessionId, file: 'audit' });
    await audit.append({ a: 1 });
    await directory.remove();
    expect(await collect(audit.readAll())).toEqual([{ a: 1 }]);
  });

  it('offers the Session lock to Workflow only', () => {
    const store = new FileSessionStore(dataDir);
    expect(() => store.sessionDirectory('kernel-core', sessionId).lock()).toThrow(
      NamespaceViolationError,
    );
  });
});

const probe = (overrides: Partial<ProcessProbe> = {}): ProcessProbe => ({
  pid: 100,
  startedAt: (pid) => Promise.resolve(pid === 100 ? 'boot-1' : undefined),
  now: () => Date.now(),
  ...overrides,
});
const options = { version: 'test', heartbeatMs: 1_000_000 };

describe('instance lock', () => {
  it('refuses a second holder while the first is alive', async () => {
    const first = new FileInstanceLock(dataDir, { ...options, probe: probe() });
    expect((await first.acquire()).outcome).toBe('ACQUIRED');
    const second = await new FileInstanceLock(dataDir, { ...options, probe: probe() }).acquire();
    expect(second).toMatchObject({ outcome: 'HELD', owner: { pid: 100, version: 'test' } });
    await first.release();
  });

  it('can be released twice and acquired again', async () => {
    const lock = new FileInstanceLock(dataDir, { ...options, probe: probe() });
    await lock.acquire();
    await lock.release();
    await lock.release();
    expect((await lock.acquire()).outcome).toBe('ACQUIRED');
    await lock.release();
  });

  it('takes over when the owner is gone', async () => {
    await new FileInstanceLock(dataDir, {
      ...options,
      probe: probe({ pid: 200, startedAt: () => Promise.resolve('x') }),
    }).acquire();
    const next = new FileInstanceLock(dataDir, { ...options, probe: probe() });
    expect((await next.acquire()).outcome).toBe('ACQUIRED');
    await next.release();
  });

  it('takes over when the pid was reused', async () => {
    await new FileInstanceLock(dataDir, {
      ...options,
      probe: probe({ startedAt: () => Promise.resolve('boot-0') }),
    }).acquire();
    const next = new FileInstanceLock(dataDir, { ...options, probe: probe() });
    expect((await next.acquire()).outcome).toBe('ACQUIRED');
    await next.release();
  });

  it('takes over when the heartbeat stopped', async () => {
    await new FileInstanceLock(dataDir, { ...options, probe: probe() }).acquire();
    const old = new Date(Date.now() - 120_000);
    await utimes(join(dataDir, 'instance.lock', 'owner.json'), old, old);
    const next = new FileInstanceLock(dataDir, { ...options, probe: probe() });
    expect((await next.acquire()).outcome).toBe('ACQUIRED');
    await next.release();
  });

  it('never gives a stale lock to two of many simultaneous takeovers', async () => {
    for (let round = 0; round < 30; round += 1) {
      const dir = join(dataDir, `round-${String(round)}`);
      await new FileInstanceLock(dir, {
        ...options,
        probe: probe({ pid: 200, startedAt: () => Promise.resolve('x') }),
      }).acquire();
      const locks = [1, 2, 3, 4].map(
        () => new FileInstanceLock(dir, { ...options, probe: probe() }),
      );
      const results = await Promise.all(locks.map((lock) => lock.acquire()));
      expect(results.filter((result) => result.outcome === 'ACQUIRED')).toHaveLength(1);
      for (const result of results)
        if (result.outcome === 'HELD') expect(result.owner.pid).toBe(100);
      for (const [index, result] of results.entries())
        if (result.outcome === 'ACQUIRED') await locks[index]?.release();
    }
  });

  it('lets one of two simultaneous takeovers win', async () => {
    await new FileInstanceLock(dataDir, {
      ...options,
      probe: probe({ pid: 200, startedAt: () => Promise.resolve('x') }),
    }).acquire();
    const locks = [1, 2].map(() => new FileInstanceLock(dataDir, { ...options, probe: probe() }));
    const results = await Promise.all(locks.map((lock) => lock.acquire()));
    expect(results.filter((result) => result.outcome === 'ACQUIRED')).toHaveLength(1);
    await Promise.all(locks.map((lock) => lock.release()));
  });
});

describe('session lock', () => {
  const directory = (): string => join(dataDir, 'session.lock');

  it('is held by a living owner and taken from a dead one', async () => {
    const first = await acquireSessionLock(directory(), probe());
    expect(first.outcome).toBe('ACQUIRED');
    expect((await acquireSessionLock(directory(), probe())).outcome).toBe('HELD');
    const reader = probe({ startedAt: () => Promise.resolve(undefined) });
    expect((await acquireSessionLock(directory(), reader)).outcome).toBe('ACQUIRED');
  });

  it('is released by its result', async () => {
    const first = await acquireSessionLock(directory(), probe());
    if (first.outcome === 'ACQUIRED') await first.release();
    expect((await acquireSessionLock(directory(), probe())).outcome).toBe('ACQUIRED');
  });
});
