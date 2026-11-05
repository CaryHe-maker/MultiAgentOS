import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
  copyFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  IdSchemas,
  PERSISTENCE_NAMESPACES,
  assertValid,
  validate,
  type AppendLogPort,
  type CapabilityDescriptor,
  type HealthStatus,
  type LifecyclePort,
  type InstanceLockInfo,
  type InstanceLockPort,
  type LockResult,
  type PersistenceNamespace,
  type SessionDirectoryPort,
  type SessionLockInfo,
  type SessionPersistencePort,
  type StoragePath,
} from '@multiagentos/contracts';

/** A registered Schema; this package does not depend on TypeBox directly. */
type Schema = Parameters<typeof validate>[0];

/**
 * M2 storage (Infrastructure/Persistence): append-only JSONL under
 *
 *   <dataDir>/<namespace>/<file>.jsonl                        system-level indexes
 *   <dataDir>/sessions/<sessionId>/<namespace>/<file>.jsonl   one Session
 *
 * A record reaches the caller's success only after fsync. The store never interprets records and
 * never decides when to repair or delete; those decisions belong to each Owner.
 */
const FILE_OWNER: Readonly<Record<StoragePath['file'], PersistenceNamespace>> = {
  'session-index': 'workflow',
  log: 'workflow',
  'session-refs': 'kernel-core',
  'trusted-instructions': 'kernel-core',
  'memory-events': 'kernel-core',
  audit: 'kernel-core',
  'artifact-owners': 'kernel-execution',
  'snapshot-index': 'kernel-execution',
};
const FILE_NAME: Readonly<Record<StoragePath['file'], string>> = {
  'session-index': 'session-index.jsonl',
  log: 'log.v1.jsonl',
  'session-refs': 'session-refs.jsonl',
  'trusted-instructions': 'trusted-instructions.jsonl',
  'memory-events': 'memory-events.jsonl',
  audit: 'audit.jsonl',
  'artifact-owners': 'artifact-owners.jsonl',
  'snapshot-index': 'snapshot-index.jsonl',
};

export class NamespaceViolationError extends Error {
  public constructor(namespace: string, file: string) {
    super(`${namespace} may not access ${file}`);
    this.name = 'NamespaceViolationError';
  }
}

async function assertNoSymlink(root: string, segments: readonly string[]): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`symlink refused: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function assertSessionId(sessionId: string): void {
  if (!validate(IdSchemas.sessionId, sessionId).ok) throw new Error('invalid sessionId');
}

export class FileSessionStore implements SessionPersistencePort, LifecyclePort {
  readonly manifest = { moduleId: 'persistence', version: '0.2.0', dependencies: [] } as const;
  readonly #dataDir: string;
  /** Appends to one file run in call order; a failed one does not poison the next. */
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #schemas: Readonly<Partial<Record<StoragePath['file'], Schema>>>;

  public constructor(
    dataDir: string,
    schemas: Readonly<Partial<Record<StoragePath['file'], Schema>>> = {},
  ) {
    if (!isAbsolute(dataDir)) throw new Error('dataDir must be an absolute path');
    this.#dataDir = dataDir;
    this.#schemas = schemas;
  }

  #segments(namespace: PersistenceNamespace, path: StoragePath): string[] {
    if (FILE_OWNER[path.file] !== namespace)
      throw new NamespaceViolationError(namespace, path.file);
    if (path.scope === 'SYSTEM') return [namespace, FILE_NAME[path.file]];
    assertSessionId(path.sessionId);
    return ['sessions', path.sessionId, namespace, FILE_NAME[path.file]];
  }

  appendLog<T>(namespace: PersistenceNamespace, path: StoragePath): AppendLogPort<T> {
    const segments = this.#segments(namespace, path);
    const file = join(this.#dataDir, ...segments);
    const schema = this.#schemas[path.file];
    const queue = <R>(work: () => Promise<R>): Promise<R> => {
      const previous = this.#tails.get(file) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(work);
      this.#tails.set(file, current);
      return current;
    };
    return {
      append: (record) =>
        queue(async () => {
          await assertNoSymlink(this.#dataDir, segments);
          await mkdir(dirname(file), { recursive: true });
          await assertNoSymlink(this.#dataDir, segments);
          const handle = await open(
            file,
            constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
            0o600,
          );
          try {
            await handle.appendFile(`${JSON.stringify(record)}\n`);
            await handle.sync();
          } finally {
            await handle.close();
          }
        }),
      readAll: () => this.#read<T>(segments, file, schema),
      repairTail: () =>
        queue(async () => {
          await assertNoSymlink(this.#dataDir, segments);
          const content = await readOrEmpty(file);
          const end = content.lastIndexOf(0x0a) + 1;
          const truncatedBytes = content.length - end;
          if (truncatedBytes > 0) {
            await truncate(file, end);
            const handle = await open(file, constants.O_WRONLY);
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          return { truncatedBytes };
        }),
    };
  }

  async *#read<T>(
    segments: readonly string[],
    file: string,
    schema: Schema | undefined,
  ): AsyncGenerator<T> {
    await assertNoSymlink(this.#dataDir, segments);
    const content = await readOrEmpty(file);
    const text = content.toString('utf8');
    if (text.length === 0) return;
    if (!text.endsWith('\n')) throw new Error(`incomplete last line in ${FILE_NAME_OF(file)}`);
    for (const line of text.slice(0, -1).split('\n')) {
      const value: unknown = JSON.parse(line);
      yield schema === undefined ? (value as T) : assertValid<T>(schema, value);
    }
  }

  sessionDirectory(namespace: PersistenceNamespace, sessionId: string): SessionDirectoryPort {
    assertSessionId(sessionId);
    const segments = ['sessions', sessionId, namespace];
    const directory = join(this.#dataDir, ...segments);
    return {
      create: async () => {
        await assertNoSymlink(this.#dataDir, segments);
        await mkdir(dirname(directory), { recursive: true });
        await mkdir(directory);
      },
      copyLogFrom: async (fromSessionId) => {
        assertSessionId(fromSessionId);
        const source = ['sessions', fromSessionId, namespace, 'log.v1.jsonl'];
        await assertNoSymlink(this.#dataDir, segments);
        await assertNoSymlink(this.#dataDir, source);
        await copyFile(join(this.#dataDir, ...source), join(directory, 'log.v1.jsonl'));
      },
      remove: async () => {
        await assertNoSymlink(this.#dataDir, segments);
        await rm(directory, { recursive: true, force: true });
      },
      lock: () => {
        if (namespace !== 'workflow') throw new NamespaceViolationError(namespace, 'session.lock');
        return acquireSessionLock(join(this.#dataDir, 'sessions', sessionId, 'session.lock'));
      },
    };
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  /** Completes every append that was started before it returns. */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.#tails.values()]);
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: [] });
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return PERSISTENCE_NAMESPACES.map((namespace) => ({
      capability: `persistence.${namespace}`,
      status: 'SUPPORTED',
      schemaNames: [],
    }));
  }
}

const FILE_NAME_OF = (file: string): string => basename(file);

async function readOrEmpty(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

/** Process facts the locks need; replaced in tests. */
export interface ProcessProbe {
  readonly pid: number;
  /** The start time of `pid`, undefined when no such process exists. */
  startedAt(pid: number): Promise<string | undefined>;
  now(): number;
}

/** Field 22 of `/proc/<pid>/stat`, read after the command name, which may contain spaces. */
export const linuxProcessProbe: ProcessProbe = {
  pid: process.pid,
  startedAt: async (pid) => {
    try {
      const stat_ = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
      return stat_.slice(stat_.lastIndexOf(')') + 2).split(' ')[19];
    } catch {
      return undefined;
    }
  },
  now: () => Date.now(),
};

async function ownerIsDead(info: { pid: number; processStartedAt: string }, probe: ProcessProbe) {
  const startedAt = await probe.startedAt(info.pid);
  return startedAt === undefined || startedAt !== info.processStartedAt;
}

async function readOwner<T>(directory: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Publishes the lock with its owner in one atomic rename, so a lock directory always says who
 * holds it. Renaming onto a lock that already exists fails, which is what makes one process win.
 */
async function tryAcquire(directory: string, owner: () => Promise<object>): Promise<boolean> {
  await mkdir(dirname(directory), { recursive: true });
  const draft = `${directory}.new-${randomUUID()}`;
  await mkdir(draft);
  try {
    await writeFile(join(draft, 'owner.json'), JSON.stringify(await owner()), { flag: 'wx' });
    await rename(draft, directory);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM') return false;
    throw error;
  } finally {
    await rm(draft, { recursive: true, force: true });
  }
}

const TAKEOVER_ATTEMPTS = 200;
const TAKEOVER_WAIT_MS = 10;
/** A takeover takes milliseconds; a marker this old was left by a process that died in one. */
const TAKEOVER_STALE_MS = 10_000;

async function enterTakeover(marker: string): Promise<void> {
  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(marker);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const age = await stat(marker).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    );
    if (age > TAKEOVER_STALE_MS) await rm(marker, { recursive: true, force: true });
    else await new Promise((resolve) => setTimeout(resolve, TAKEOVER_WAIT_MS));
  }
  throw new Error(`takeover of ${marker} did not finish`);
}

/**
 * Takeovers run one at a time, and each looks at the owner again once it is its turn: otherwise a
 * process that judged the lock stale earlier would move away the fresh lock of the winner.
 */
async function takeOver<T>(
  directory: string,
  isStale: (owner: T) => Promise<boolean>,
  attempt: () => Promise<boolean>,
): Promise<boolean> {
  const marker = `${directory}.takeover`;
  await enterTakeover(marker);
  try {
    const owner = await readOwner<T>(directory);
    if (owner !== undefined && !(await isStale(owner))) return false;
    const tombstone = `${directory}.stale-${randomUUID()}`;
    try {
      await rename(directory, tombstone);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return await attempt();
    }
    const acquired = await attempt();
    await rm(tombstone, { recursive: true, force: true });
    return acquired;
  } finally {
    await rm(marker, { recursive: true, force: true });
  }
}

export async function acquireSessionLock(
  directory: string,
  probe: ProcessProbe = linuxProcessProbe,
): Promise<LockResult> {
  const startedAt = (await probe.startedAt(probe.pid)) ?? 'unknown';
  const attempt = () =>
    tryAcquire(directory, () =>
      Promise.resolve({
        pid: probe.pid,
        processStartedAt: startedAt,
        acquiredAt: new Date(probe.now()).toISOString(),
      } satisfies SessionLockInfo),
    );
  const held = (owner: SessionLockInfo): LockResult => ({ outcome: 'HELD', owner });
  if (!(await attempt())) {
    const owner = await readOwner<SessionLockInfo>(directory);
    if (owner !== undefined && !(await ownerIsDead(owner, probe))) return held(owner);
    const stale = (candidate: SessionLockInfo) => ownerIsDead(candidate, probe);
    if (!(await takeOver(directory, stale, attempt))) {
      const winner = await readOwner<SessionLockInfo>(directory);
      if (winner !== undefined) return held(winner);
      throw new Error('session lock is held by an unknown owner');
    }
  }
  return {
    outcome: 'ACQUIRED',
    release: () => rm(directory, { recursive: true, force: true }),
  };
}

export interface InstanceLockOptions {
  readonly version: string;
  readonly heartbeatMs?: number;
  readonly staleAfterMs?: number;
  readonly probe?: ProcessProbe;
}

/** Infrastructure/Persistence 5.1; the composition root is its only user. */
export class FileInstanceLock implements InstanceLockPort {
  readonly #directory: string;
  readonly #version: string;
  readonly #heartbeatMs: number;
  readonly #staleAfterMs: number;
  readonly #probe: ProcessProbe;
  #heartbeat: NodeJS.Timeout | undefined;

  public constructor(dataDir: string, options: InstanceLockOptions) {
    if (!isAbsolute(dataDir)) throw new Error('dataDir must be an absolute path');
    this.#directory = join(dataDir, 'instance.lock');
    this.#version = options.version;
    this.#heartbeatMs = options.heartbeatMs ?? 10_000;
    this.#staleAfterMs = options.staleAfterMs ?? 60_000;
    this.#probe = options.probe ?? linuxProcessProbe;
  }

  async #isStale(owner: InstanceLockInfo): Promise<boolean> {
    if (await ownerIsDead(owner, this.#probe)) return true;
    const modified = (await stat(join(this.#directory, 'owner.json'))).mtimeMs;
    return this.#probe.now() - modified > this.#staleAfterMs;
  }

  async acquire(): Promise<LockResult> {
    const startedAt = (await this.#probe.startedAt(this.#probe.pid)) ?? 'unknown';
    const attempt = () =>
      tryAcquire(this.#directory, () =>
        Promise.resolve({
          pid: this.#probe.pid,
          processStartedAt: startedAt,
          hostname: hostname(),
          version: this.#version,
          acquiredAt: new Date(this.#probe.now()).toISOString(),
        } satisfies InstanceLockInfo),
      );
    if (!(await attempt())) {
      const owner = await readOwner<InstanceLockInfo>(this.#directory);
      if (owner !== undefined && !(await this.#isStale(owner))) return { outcome: 'HELD', owner };
      const stale = (candidate: InstanceLockInfo) => this.#isStale(candidate);
      if (!(await takeOver(this.#directory, stale, attempt))) {
        const winner = await readOwner<InstanceLockInfo>(this.#directory);
        if (winner !== undefined) return { outcome: 'HELD', owner: winner };
        throw new Error('instance lock is held by an unknown owner');
      }
    }
    this.#heartbeat = setInterval(() => {
      const moment = new Date(this.#probe.now());
      void utimes(join(this.#directory, 'owner.json'), moment, moment).catch(() => undefined);
    }, this.#heartbeatMs);
    this.#heartbeat.unref();
    return { outcome: 'ACQUIRED', release: () => this.release() };
  }

  async release(): Promise<void> {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    await rm(this.#directory, { recursive: true, force: true });
  }
}
