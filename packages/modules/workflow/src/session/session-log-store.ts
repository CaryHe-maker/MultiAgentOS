import {
  ArtifactRefSchema,
  SessionIndexLineSchema,
  SessionLogRecordSchema,
  validate,
  type AppendLogPort,
  type ArtifactRef,
  type SessionCommandFailure,
  type SessionIndexLine,
  type SessionListEntry,
  type SessionLogRecord,
  type SessionPersistencePort,
} from '@multiagentos/contracts';
import { settleStaleRecords } from './settle-stale.js';

/**
 * The owner of the session log and the Session list (Module/Workflow 5). A record is on disk
 * before anything else happens, so the caller updates its projection and calls Kernel afterwards
 * (M2Design 10.3). `seq` is assigned here and always rises by one.
 */
export class SessionStoreFailure extends Error {
  public constructor(
    public readonly code: SessionCommandFailure['code'],
    detail: string,
  ) {
    super(detail);
    this.name = 'SessionStoreFailure';
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewLogRecord = DistributiveOmit<SessionLogRecord, 'seq' | 'at'>;

const LOG = (sessionId: string) => ({ scope: 'SESSION', sessionId, file: 'log' }) as const;
const INDEX = { scope: 'SYSTEM', file: 'session-index' } as const;
const FORMAT_VERSION = 1;

export interface OpenedSession {
  readonly records: readonly SessionLogRecord[];
  /** Recorded digest and the current one differ, so rebuilt context is no longer exact. */
  readonly definitionsChanged: boolean;
}

export interface ForkedSession {
  readonly records: readonly SessionLogRecord[];
  readonly inheritedArtifacts: readonly ArtifactRef[];
  readonly fromTurnCount: number;
}

/** Every artifact reference anywhere in the records, each once. */
function artifactRefsIn(records: readonly SessionLogRecord[]): readonly ArtifactRef[] {
  const found = new Map<string, ArtifactRef>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'object' && value !== null) {
      const checked = validate<ArtifactRef>(ArtifactRefSchema, value);
      if (checked.ok) found.set(checked.value.artifactId, checked.value);
      else Object.values(value).forEach(visit);
    }
  };
  visit(records);
  return [...found.values()];
}

export class SessionLogStore {
  readonly #persistence: SessionPersistencePort;
  readonly #now: () => Date;
  #index: AppendLogPort<SessionIndexLine>;
  #log: AppendLogPort<unknown> | undefined;
  #sessionId: string | undefined;
  #seq = 0;
  #release: (() => Promise<void>) | undefined;

  public constructor(persistence: SessionPersistencePort, now: () => Date = () => new Date()) {
    this.#persistence = persistence;
    this.#now = now;
    this.#index = persistence.appendLog('workflow', INDEX);
  }

  async #lock(sessionId: string): Promise<void> {
    const lock = await this.#storage(() =>
      this.#persistence.sessionDirectory('workflow', sessionId).lock(),
    );
    if (lock.outcome === 'HELD') throw new SessionStoreFailure('SESSION_LOCKED', 'lock held');
    this.#release = () => lock.release();
    this.#sessionId = sessionId;
    this.#seq = 0;
    this.#log = this.#persistence.appendLog('workflow', LOG(sessionId));
  }

  async #storage<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SessionStoreFailure) throw error;
      throw new SessionStoreFailure('SESSION_STORAGE_FAILED', 'storage failed');
    }
  }

  async create(input: {
    readonly sessionId: string;
    readonly repositoryRoot: string;
    readonly definitionsDigest: string;
    readonly definitionVersions: readonly string[];
  }): Promise<SessionLogRecord> {
    await this.#storage(() =>
      this.#persistence.sessionDirectory('workflow', input.sessionId).create(),
    );
    await this.#lock(input.sessionId);
    const started = await this.append({
      type: 'SESSION_STARTED',
      formatVersion: FORMAT_VERSION,
      repositoryRoot: input.repositoryRoot,
      definitionsDigest: input.definitionsDigest,
      definitionVersions: [...input.definitionVersions],
    });
    const at = this.#now().toISOString();
    await this.#storage(() =>
      this.#index.append({
        sessionId: input.sessionId,
        repositoryRoot: input.repositoryRoot,
        createdAt: at,
        lastActiveAt: at,
        turnCount: 0,
        status: 'ACTIVE',
      }),
    );
    return started;
  }

  /**
   * A fork begins as a copy of the whole log. A run the original left open ends here as FORKED,
   * so replaying the copy never takes it for one that was interrupted.
   */
  async fork(input: {
    readonly sessionId: string;
    readonly fromSessionId: string;
    readonly repositoryRoot: string;
  }): Promise<ForkedSession> {
    const directory = this.#persistence.sessionDirectory('workflow', input.sessionId);
    await this.#storage(async () => {
      await directory.create();
      await directory.copyLogFrom(input.fromSessionId);
    });
    await this.#lock(input.sessionId);
    const log = this.#requireLog();
    await this.#storage(() => log.repairTail());
    const records = await this.#readChecked(log);
    this.#seq = records.length;
    const appended: SessionLogRecord[] = [];
    const ended = new Set(
      records.flatMap((r) => (r.type === 'WORKFLOW_RUN_ENDED' ? [r.workflowRunId] : [])),
    );
    for (const record of records)
      if (record.type === 'WORKFLOW_RUN_STARTED' && !ended.has(record.workflowRunId))
        appended.push(
          await this.append({
            type: 'WORKFLOW_RUN_ENDED',
            workflowRunId: record.workflowRunId,
            closeReason: 'FORKED',
          }),
        );
    appended.push(
      await this.append({
        type: 'SESSION_FORKED',
        fromSessionId: input.fromSessionId,
        fromSeq: records.length,
      }),
    );
    const fromTurnCount = records.filter((r) => r.type === 'TURN_STARTED').length;
    const at = this.#now().toISOString();
    await this.#storage(() =>
      this.#index.append({
        sessionId: input.sessionId,
        repositoryRoot: input.repositoryRoot,
        createdAt: at,
        lastActiveAt: at,
        turnCount: fromTurnCount,
        fork: { fromSessionId: input.fromSessionId, fromTurnCount },
        status: 'ACTIVE',
      }),
    );
    return {
      records: [...records, ...appended],
      inheritedArtifacts: artifactRefsIn(records),
      fromTurnCount,
    };
  }

  /** Steps 1-4 of M2Design 10.3: lock, repair the tail, check the log, settle what was left. */
  async open(sessionId: string, definitionsDigest: string): Promise<OpenedSession> {
    await this.#lock(sessionId);
    try {
      const log = this.#requireLog();
      const { truncatedBytes } = await this.#storage(() => log.repairTail());
      const records = await this.#readChecked(log);
      this.#seq = records.length;
      const appended: SessionLogRecord[] = [];
      if (truncatedBytes > 0)
        appended.push(await this.append({ type: 'LOG_TAIL_REPAIRED', truncatedBytes }));
      for (const record of settleStaleRecords(records)) appended.push(await this.append(record));
      const started = records[0];
      return {
        records: [...records, ...appended],
        definitionsChanged:
          started?.type === 'SESSION_STARTED' && started.definitionsDigest !== definitionsDigest,
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async #readChecked(log: AppendLogPort<unknown>): Promise<SessionLogRecord[]> {
    const records: SessionLogRecord[] = [];
    let lines: AsyncIterable<unknown>;
    try {
      lines = log.readAll();
      for await (const line of lines) {
        const value = line as { type?: unknown; formatVersion?: unknown; seq?: unknown };
        if (value.type === 'SESSION_STARTED' && value.formatVersion !== FORMAT_VERSION)
          throw new SessionStoreFailure('SESSION_FORMAT_UNSUPPORTED', 'unknown format');
        const checked = validate<SessionLogRecord>(SessionLogRecordSchema, line);
        if (!checked.ok) throw new SessionStoreFailure('SESSION_LOG_CORRUPT', 'invalid record');
        if (checked.value.seq !== records.length + 1)
          throw new SessionStoreFailure('SESSION_LOG_CORRUPT', 'seq is not continuous');
        records.push(checked.value);
      }
    } catch (error) {
      if (error instanceof SessionStoreFailure) throw error;
      throw new SessionStoreFailure('SESSION_LOG_CORRUPT', 'unreadable log');
    }
    if (records[0]?.type !== 'SESSION_STARTED')
      throw new SessionStoreFailure('SESSION_LOG_CORRUPT', 'no SESSION_STARTED');
    return records;
  }

  #requireLog(): AppendLogPort<unknown> {
    if (this.#log === undefined) throw new Error('no Session is open');
    return this.#log;
  }

  /** Returns only after the record is durable; a failure leaves `seq` where it was. */
  async append(record: NewLogRecord): Promise<SessionLogRecord> {
    const log = this.#requireLog();
    const complete = {
      ...record,
      seq: this.#seq + 1,
      at: this.#now().toISOString(),
    };
    await this.#storage(() => log.append(complete));
    this.#seq += 1;
    return complete;
  }

  async close(): Promise<void> {
    const release = this.#release;
    this.#release = undefined;
    this.#log = undefined;
    this.#sessionId = undefined;
    this.#seq = 0;
    await release?.();
  }

  async #latest(): Promise<Map<string, SessionIndexLine>> {
    const latest = new Map<string, SessionIndexLine>();
    await this.#storage(async () => {
      for await (const line of this.#index.readAll()) {
        const checked = validate<SessionIndexLine>(SessionIndexLineSchema, line);
        if (checked.ok) latest.set(checked.value.sessionId, checked.value);
      }
    });
    return latest;
  }

  async #updateIndex(
    sessionId: string,
    change: (line: SessionIndexLine) => SessionIndexLine,
  ): Promise<void> {
    const line = (await this.#latest()).get(sessionId);
    if (line === undefined) return;
    await this.#storage(() => this.#index.append(change(line)));
  }

  /** The first prompt names the Session in the list. */
  setTitle(titleRef: NonNullable<SessionIndexLine['titleRef']>): Promise<void> {
    if (this.#sessionId === undefined) throw new Error('no Session is open');
    return this.#updateIndex(this.#sessionId, (line) =>
      line.titleRef === undefined ? { ...line, titleRef } : line,
    );
  }

  recordTurnClosed(): Promise<void> {
    if (this.#sessionId === undefined) throw new Error('no Session is open');
    return this.#updateIndex(this.#sessionId, (line) => ({
      ...line,
      turnCount: line.turnCount + 1,
      lastActiveAt: this.#now().toISOString(),
    }));
  }

  /** For a Session that is not open; Kernel removes its own namespaces itself. */
  async remove(sessionId: string): Promise<void> {
    await this.#storage(() => this.#persistence.sessionDirectory('workflow', sessionId).remove());
    await this.#updateIndex(sessionId, (line) => ({ ...line, status: 'DELETED' }));
  }

  /** Newest first; needs no open Session. */
  async list(repositoryRoot: string): Promise<SessionListEntry[]> {
    const lines = [...(await this.#latest()).values()];
    return lines
      .filter((line) => line.repositoryRoot === repositoryRoot && line.status === 'ACTIVE')
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))
      .slice(0, 1000)
      .map((line) => ({
        sessionId: line.sessionId,
        createdAt: line.createdAt,
        lastActiveAt: line.lastActiveAt,
        turnCount: line.turnCount,
        status: line.status,
        ...(line.titleRef === undefined ? {} : { titleRef: line.titleRef }),
        ...(line.fork === undefined ? {} : { fork: line.fork }),
      }));
  }
}
