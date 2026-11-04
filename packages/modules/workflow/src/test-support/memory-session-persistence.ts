import type {
  AppendLogPort,
  LockResult,
  PersistenceNamespace,
  SessionDirectoryPort,
  SessionPersistencePort,
  StoragePath,
} from '@multiagentos/contracts';

/** In-memory SessionPersistencePort; `torn` holds the partial last line of a crashed write. */
export class MemorySessionPersistence implements SessionPersistencePort {
  readonly lines = new Map<string, unknown[]>();
  readonly torn = new Map<string, number>();
  readonly directories = new Set<string>();
  readonly locks = new Set<string>();
  failAppends = false;

  appendLog<T>(_namespace: PersistenceNamespace, path: StoragePath): AppendLogPort<T> {
    const key = MemorySessionPersistence.keyOf(path);
    return {
      append: (record) => {
        if (this.failAppends) return Promise.reject(new Error('disk full'));
        this.linesOf(key).push(structuredClone(record));
        return Promise.resolve();
      },
      readAll: () => {
        const lines = this.linesOf(key) as T[];
        return (async function* () {
          for (const line of lines) {
            await Promise.resolve();
            yield structuredClone(line);
          }
        })();
      },
      repairTail: () => {
        const truncatedBytes = this.torn.get(key) ?? 0;
        this.torn.delete(key);
        return Promise.resolve({ truncatedBytes });
      },
    };
  }

  sessionDirectory(_namespace: PersistenceNamespace, sessionId: string): SessionDirectoryPort {
    return {
      create: () => {
        if (this.directories.has(sessionId)) return Promise.reject(new Error('exists'));
        this.directories.add(sessionId);
        return Promise.resolve();
      },
      copyLogFrom: (fromSessionId) => {
        const source = this.lines.get(`log:${fromSessionId}`) ?? [];
        this.lines.set(`log:${sessionId}`, [...source]);
        return Promise.resolve();
      },
      remove: () => {
        this.directories.delete(sessionId);
        this.lines.delete(`log:${sessionId}`);
        return Promise.resolve();
      },
      lock: (): Promise<LockResult> => {
        if (this.locks.has(sessionId))
          return Promise.resolve({
            outcome: 'HELD',
            owner: { pid: 1, processStartedAt: 'x', acquiredAt: '2026-10-31T00:00:00.000Z' },
          });
        this.locks.add(sessionId);
        return Promise.resolve({
          outcome: 'ACQUIRED',
          release: () => {
            this.locks.delete(sessionId);
            return Promise.resolve();
          },
        });
      },
    };
  }

  capabilities(): readonly [] {
    return [];
  }

  linesOf(key: string): unknown[] {
    const lines = this.lines.get(key) ?? [];
    this.lines.set(key, lines);
    return lines;
  }

  static keyOf(path: StoragePath): string {
    return path.scope === 'SYSTEM' ? path.file : `${path.file}:${path.sessionId}`;
  }
}
