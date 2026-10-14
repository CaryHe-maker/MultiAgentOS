import type {
  AuditLogPort,
  PersistenceNamespace,
  PersistencePort,
  RepositoryPort,
} from '@multiagentos/contracts';

/** Module-local persistence fake; copies reads and writes to avoid shared references. */
export class MemoryPersistence implements PersistencePort {
  readonly records = new Map<string, unknown>();
  readonly entries: unknown[] = [];
  readonly writes: unknown[] = [];

  repository<T extends { readonly id: string }>(
    namespace: PersistenceNamespace,
    workflowRunId: string,
  ): RepositoryPort<T> {
    const prefix = `${namespace}/${workflowRunId}/`;
    return {
      get: (id) => Promise.resolve(structuredClone(this.records.get(prefix + id)) as T | undefined),
      put: (record) => {
        this.writes.push(structuredClone(record));
        this.records.set(prefix + record.id, structuredClone(record));
        return Promise.resolve();
      },
    };
  }

  auditLog<T>(): AuditLogPort<T> {
    return {
      append: (entry) => {
        this.entries.push(structuredClone(entry));
        return Promise.resolve();
      },
    };
  }

  capabilities(): ReturnType<PersistencePort['capabilities']> {
    return [];
  }
}
