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
  /** What the Session list says of it: the inputs of the user it has, and the reference of its name. */
  readonly inputCount: number;
  readonly titleRef?: NonNullable<SessionIndexLine['titleRef']>;
}

export interface ForkedSession {
  readonly records: readonly SessionLogRecord[];
  readonly inheritedArtifacts: readonly ArtifactRef[];
  readonly fromInputCount: number;
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
    readonly sandbox?: Extract<SessionLogRecord, { type: 'SESSION_STARTED' }>['sandbox'];
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
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    });
    const at = this.#now().toISOString();
    await this.#storage(() =>
      this.#index.append({
        sessionId: input.sessionId,
        repositoryRoot: input.repositoryRoot,
        createdAt: at,
        lastActiveAt: at,
        inputCount: 0,
        status: 'ACTIVE',
      }),
    );
    return started;
  }

  /**
   * A fork begins as a copy of the whole log. What the original left open is settled as in any
   * open, or a call without an answer would stop the history; a run left open ends as FORKED.
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
    for (const record of settleStaleRecords(records))
      appended.push(
        await this.append(
          record.type === 'WORKFLOW_RUN_ENDED' ? { ...record, closeReason: 'FORKED' } : record,
        ),
      );
    appended.push(
      await this.append({
        type: 'SESSION_FORKED',
        fromSessionId: input.fromSessionId,
        fromSeq: records.length,
      }),
    );
    const fromInputCount = inputsIn(records);
    const at = this.#now().toISOString();
    await this.#storage(() =>
      this.#index.append({
        sessionId: input.sessionId,
        repositoryRoot: input.repositoryRoot,
        createdAt: at,
        lastActiveAt: at,
        inputCount: fromInputCount,
        fork: { fromSessionId: input.fromSessionId, fromInputCount },
        status: 'ACTIVE',
      }),
    );
    return {
      records: [...records, ...appended],
      inheritedArtifacts: artifactRefsIn(records),
      fromInputCount,
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
      const listed = (await this.#latest()).get(sessionId);
      return {
        inputCount: listed === undefined ? 0 : inputCountOf(listed),
        ...(listed?.titleRef === undefined ? {} : { titleRef: listed.titleRef }),
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

  /** The work of one more input of the user came to rest: the list counts it. */
  recordInputSettled(): Promise<void> {
    if (this.#sessionId === undefined) throw new Error('no Session is open');
    // An older line counted Turns: from now on it counts inputs, which are the same thing.
    return this.#updateIndex(this.#sessionId, ({ turnCount, ...line }) => ({
      ...line,
      inputCount: inputCountOf({ ...line, ...(turnCount === undefined ? {} : { turnCount }) }) + 1,
      lastActiveAt: this.#now().toISOString(),
    }));
  }

  /** For a Session that is not open; Kernel removes its own namespaces itself. */
  async remove(sessionId: string): Promise<void> {
    await this.#storage(() => this.#persistence.sessionDirectory('workflow', sessionId).remove());
    await this.#updateIndex(sessionId, (line) => ({ ...line, status: 'DELETED' }));
  }

  /**
   * The Session is worked on in another folder from now on: the record says so, and the list
   * shows the folder it was last worked on in (M2Design 2.3).
   */
  async bindWorkspace(input: {
    readonly repositoryRoot: string;
    readonly previousRoot: string;
  }): Promise<SessionLogRecord> {
    if (this.#sessionId === undefined) throw new Error('no Session is open');
    const bound = await this.append({
      type: 'WORKSPACE_BOUND',
      repositoryRoot: input.repositoryRoot,
      previousRoot: input.previousRoot,
    });
    await this.#updateIndex(this.#sessionId, (line) => ({
      ...line,
      repositoryRoot: input.repositoryRoot,
    }));
    return bound;
  }

  /** Every Session that exists, newest first, each with the folder it was last worked on in; needs no open Session. */
  async list(): Promise<SessionListEntry[]> {
    const lines = [...(await this.#latest()).values()];
    return lines
      .filter((line) => line.status === 'ACTIVE')
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))
      .slice(0, 1000)
      .map((line) => ({
        sessionId: line.sessionId,
        repositoryRoot: line.repositoryRoot,
        createdAt: line.createdAt,
        lastActiveAt: line.lastActiveAt,
        inputCount: inputCountOf(line),
        status: line.status,
        ...(line.titleRef === undefined ? {} : { titleRef: line.titleRef }),
        ...(line.fork === undefined ? {} : { fork: line.fork }),
      }));
  }
}

/** How many inputs of the user a list line counts; older lines counted Turns, the same thing. */
function inputCountOf(line: Pick<SessionIndexLine, 'inputCount' | 'turnCount'>): number {
  return line.inputCount ?? line.turnCount ?? 0;
}

/** The inputs of the user in a log: each opened a Turn in older logs, a checkpoint in newer ones. */
function inputsIn(records: readonly SessionLogRecord[]): number {
  return records.filter((record) => record.type === 'HUMAN_ANSWERED' && record.kind === 'prompt')
    .length;
}
