import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  IdSchemas,
  PERSISTENCE_NAMESPACES,
  validate,
  type AuditLogPort,
  type CapabilityDescriptor,
  type HealthStatus,
  type LifecyclePort,
  type PersistenceNamespace,
  type PersistencePort,
  type RepositoryPort,
} from '@multiagentos/contracts';

/**
 * File storage of the run directory (docs/M1/Infrastructure/Persistence.md):
 *
 *   <dataDir>/runs/<workflowRunId>/<namespace>/<id>.json    RepositoryPort
 *   <dataDir>/runs/<workflowRunId>/<namespace>/audit.jsonl  AuditLogPort
 *
 * Each Owner is given the ports of its own namespace only. Transactions, a journal and a
 * durable Outbox or Inbox are not supported.
 */
export class FilePersistence implements PersistencePort, LifecyclePort {
  readonly manifest = { moduleId: 'persistence', version: '0.1.0', dependencies: [] } as const;
  readonly #dataDir: string;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #auditTails = new Map<string, Promise<void>>();
  #acceptingWrites = false;

  public constructor(dataDir: string) {
    if (!isAbsolute(dataDir)) throw new Error('dataDir must be an absolute path');
    this.#dataDir = dataDir;
  }

  /**
   * Ensures the temporary directory exists. Clearing `<dataDir>/tmp/` is the Supervisor's
   * startup responsibility (docs/M1/Infrastructure/Persistence.md 2); Persistence does not
   * delete previously retained content here.
   */
  async start(): Promise<void> {
    await this.#assertNoSymlink('tmp');
    await mkdir(join(this.#dataDir, 'tmp'), { recursive: true });
    await this.#assertNoSymlink('tmp');
    this.#acceptingWrites = true;
  }

  /** Completes every write that was started before it returns. */
  async stop(): Promise<void> {
    this.#acceptingWrites = false;
    await Promise.allSettled([...this.#pending]);
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({
      status: this.#acceptingWrites ? 'UP' : 'DOWN',
      checkedAt: new Date().toISOString(),
      details: [],
    });
  }

  repository<T extends { readonly id: string }>(
    namespace: PersistenceNamespace,
    workflowRunId: string,
  ): RepositoryPort<T> {
    const directory = this.#directory(namespace, workflowRunId);
    const fileOf = (id: string) => join(directory, `${encodeURIComponent(id)}.json`);
    return {
      get: async (id) => {
        try {
          await this.#assertNoSymlink(
            'runs',
            workflowRunId,
            namespace,
            `${encodeURIComponent(id)}.json`,
          );
          return JSON.parse(await readFile(fileOf(id), 'utf8')) as T;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      },
      put: (record) =>
        this.#track(async () => {
          await this.#assertNoSymlink(
            'runs',
            workflowRunId,
            namespace,
            `${encodeURIComponent(record.id)}.json`,
          );
          await this.#assertNoSymlink('tmp');
          await mkdir(directory, { recursive: true });
          await mkdir(join(this.#dataDir, 'tmp'), { recursive: true });
          await this.#assertNoSymlink(
            'runs',
            workflowRunId,
            namespace,
            `${encodeURIComponent(record.id)}.json`,
          );
          await this.#assertNoSymlink('tmp');
          const temporary = join(this.#dataDir, 'tmp', randomUUID());
          try {
            await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx' });
            await rename(temporary, fileOf(record.id));
          } finally {
            await rm(temporary, { force: true });
          }
        }),
    };
  }

  auditLog<T>(namespace: PersistenceNamespace, workflowRunId: string): AuditLogPort<T> {
    const directory = this.#directory(namespace, workflowRunId);
    const path = join(directory, 'audit.jsonl');
    return {
      append: (entry) => {
        const line = `${JSON.stringify(entry)}\n`;
        const previous = this.#auditTails.get(path) ?? Promise.resolve();
        const current = this.#track(() =>
          previous
            .catch(() => undefined)
            .then(async () => {
              await this.#assertNoSymlink('runs', workflowRunId, namespace, 'audit.jsonl');
              await mkdir(directory, { recursive: true });
              await this.#assertNoSymlink('runs', workflowRunId, namespace, 'audit.jsonl');
              await appendFile(path, line);
            }),
        );
        if (this.#acceptingWrites) this.#auditTails.set(path, current);
        return current;
      },
    };
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return PERSISTENCE_CAPABILITIES;
  }

  #directory(namespace: PersistenceNamespace, workflowRunId: string): string {
    // Both values become path segments, so they must have their exact shapes.
    if (!PERSISTENCE_NAMESPACES.includes(namespace)) throw new Error('Invalid namespace');
    if (!validate(IdSchemas.workflowRunId, workflowRunId).ok)
      throw new Error('Invalid workflowRunId');
    return join(this.#dataDir, 'runs', workflowRunId, namespace);
  }

  #track<R>(write: () => Promise<R>): Promise<R> {
    if (!this.#acceptingWrites) return Promise.reject(new Error('Persistence is stopped'));
    const pending = write();
    this.#pending.add(pending);
    const done = () => this.#pending.delete(pending);
    pending.then(done, done);
    return pending;
  }

  async #assertNoSymlink(...segments: string[]): Promise<void> {
    let path = this.#dataDir;
    for (const segment of segments) {
      path = join(path, segment);
      try {
        if ((await lstat(path)).isSymbolicLink())
          throw new Error('Persistence path contains a symbolic link');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }
}

/** Limits an Owner to one namespace without changing the public PersistencePort signature. */
export function forPersistenceNamespace(
  persistence: PersistencePort,
  owner: PersistenceNamespace,
): PersistencePort {
  const assertOwner = (namespace: PersistenceNamespace): void => {
    if (namespace !== owner) throw new Error('Namespace is not owned by this module');
  };
  return Object.freeze({
    repository: <T extends { readonly id: string }>(
      namespace: PersistenceNamespace,
      workflowRunId: string,
    ): RepositoryPort<T> => {
      assertOwner(namespace);
      return persistence.repository<T>(namespace, workflowRunId);
    },
    auditLog: <T>(namespace: PersistenceNamespace, workflowRunId: string): AuditLogPort<T> => {
      assertOwner(namespace);
      return persistence.auditLog<T>(namespace, workflowRunId);
    },
    capabilities: () => persistence.capabilities(),
  });
}

const PERSISTENCE_CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze([
  { capability: 'persistence.run-directory', status: 'SUPPORTED', schemaNames: [] },
  {
    capability: 'persistence.transactions',
    status: 'UNSUPPORTED',
    schemaNames: [],
    reason: 'M1 does not persist run state per message',
  },
  {
    capability: 'persistence.journal',
    status: 'UNSUPPORTED',
    schemaNames: ['platform.persistence.JournalPositionRef.v0'],
    reason: 'the M1 Outbox and Inbox live in memory',
  },
]);
