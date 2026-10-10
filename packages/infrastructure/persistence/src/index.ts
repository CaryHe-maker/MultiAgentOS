import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

  public constructor(dataDir: string) {
    if (!isAbsolute(dataDir)) throw new Error('dataDir must be an absolute path');
    this.#dataDir = dataDir;
  }

  async start(): Promise<void> {
    await mkdir(join(this.#dataDir, 'tmp'), { recursive: true });
  }

  /** Completes every write that was started before it returns. */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: [] });
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
          return JSON.parse(await readFile(fileOf(id), 'utf8')) as T;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      },
      put: (record) =>
        this.#track(async () => {
          await mkdir(directory, { recursive: true });
          await mkdir(join(this.#dataDir, 'tmp'), { recursive: true });
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
    // Appends are chained so that entries keep the order in which they were given.
    let last: Promise<void> = Promise.resolve();
    return {
      append: (entry) => {
        const line = `${JSON.stringify(entry)}\n`;
        last = last.then(() =>
          this.#track(async () => {
            await mkdir(directory, { recursive: true });
            await appendFile(join(directory, 'audit.jsonl'), line);
          }),
        );
        return last;
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
    const pending = write();
    this.#pending.add(pending);
    const done = () => this.#pending.delete(pending);
    pending.then(done, done);
    return pending;
  }
}

/** Empties `<dataDir>/tmp/`; `<dataDir>/runs/` is never touched. The Supervisor calls it once at start. */
export async function clearTemporaryFiles(dataDir: string): Promise<void> {
  if (!isAbsolute(dataDir)) throw new Error('dataDir must be an absolute path');
  await rm(join(dataDir, 'tmp'), { recursive: true, force: true });
  await mkdir(join(dataDir, 'tmp'), { recursive: true });
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
