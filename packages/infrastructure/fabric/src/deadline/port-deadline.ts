import type {
  AuditLogPort,
  BoundaryContext,
  CatalogPort,
  DefinitionKind,
  DefinitionLookup,
  PersistenceNamespace,
  PersistencePort,
  RepositoryPort,
} from '@multiagentos/contracts';
import { FabricError } from '../in-process/fabric-error.js';

/**
 * Rejects with `FabricError(REQUEST_TIMEOUT)` once `timeoutMs` has passed (Fabric.md 3). The
 * deadline stops the wait only: a late result or rejection is received and discarded, and
 * nothing proves that the operation did not happen.
 */
export async function withinDeadline<T>(
  task: Promise<T>,
  timeoutMs: number | undefined,
  detail: string,
): Promise<T> {
  if (timeoutMs === undefined) return task;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Promise.race observes the task, so a late rejection is never left unhandled.
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FabricError('REQUEST_TIMEOUT', detail)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The Catalog with the port deadline the composition root gives Workflow (M1Interface 14.4). */
export function catalogWithDeadline(catalog: CatalogPort, timeoutMs: number): CatalogPort {
  return Object.freeze({
    getDefinition: <K extends DefinitionKind>(
      lookup: DefinitionLookup & { readonly kind: K },
      context: BoundaryContext,
    ) => withinDeadline(catalog.getDefinition(lookup, context), timeoutMs, 'catalog.getDefinition'),
    pinAgent: (...args: Parameters<CatalogPort['pinAgent']>) =>
      withinDeadline(catalog.pinAgent(...args), timeoutMs, 'catalog.pinAgent'),
    capabilities: () => catalog.capabilities(),
  });
}

/** Persistence with the port deadline the composition root gives Workflow (M1Interface 14.4). */
export function persistenceWithDeadline(
  persistence: PersistencePort,
  timeoutMs: number,
): PersistencePort {
  return Object.freeze({
    repository: <T extends { readonly id: string }>(
      namespace: PersistenceNamespace,
      workflowRunId: string,
    ): RepositoryPort<T> => {
      const repository = persistence.repository<T>(namespace, workflowRunId);
      return Object.freeze({
        get: (id: string) =>
          withinDeadline(repository.get(id), timeoutMs, 'persistence.repository.get'),
        put: (record: T) =>
          withinDeadline(repository.put(record), timeoutMs, 'persistence.repository.put'),
      });
    },
    auditLog: <T>(namespace: PersistenceNamespace, workflowRunId: string): AuditLogPort<T> => {
      const log = persistence.auditLog<T>(namespace, workflowRunId);
      return Object.freeze({
        append: (entry: T) =>
          withinDeadline(log.append(entry), timeoutMs, 'persistence.auditLog.append'),
      });
    },
    capabilities: () => persistence.capabilities(),
  });
}
