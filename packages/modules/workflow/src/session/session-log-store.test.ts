import { SessionLogRecordSchema, newId, validate } from '@multiagentos/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemorySessionPersistence } from '../test-support/memory-session-persistence.js';
import { SessionLogStore, SessionStoreFailure } from './session-log-store.js';
import { settleStaleRecords } from './settle-stale.js';

const root = '/repository';
const digest = 'a'.repeat(64);
const createInput = (sessionId: string) => ({
  sessionId,
  repositoryRoot: root,
  definitionsDigest: digest,
  definitionVersions: ['main@v1.0.0'],
});
const logKey = (sessionId: string) => `log:${sessionId}`;
const run = newId('wfr');
const turn = newId('trn');
const budget = { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' } as const;
const unit = (requestId: string) =>
  ({
    type: 'UNIT_SUBMITTED',
    workflowRunId: run,
    turnId: turn,
    requestId,
    path: 'agr_abcdef/round-1/1#1',
    agentRunId: newId('agr'),
    unitRunId: `unr_${'b'.repeat(32)}`,
    unitRef: { kind: 'UNIT', id: 'file-read', version: 'v1.0.0', digest },
    inputSource: { kind: 'STRUCTURED', input: {} },
  }) as const;

async function failureOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionStoreFailure) return error.code;
    throw error;
  }
  return 'NO_FAILURE';
}

describe('creating and appending', () => {
  it('starts the log, numbers records and lists the Session', async () => {
    const persistence = new MemorySessionPersistence();
    const store = new SessionLogStore(persistence);
    const sessionId = newId('ses');
    await store.create(createInput(sessionId));
    const started = await store.append({
      type: 'WORKFLOW_RUN_STARTED',
      workflowRunId: run,
      mode: 'CHAT',
      preset: 'standard',
      initialInput: true,
    });
    expect(started.seq).toBe(2);
    const lines = persistence.linesOf(logKey(sessionId));
    expect(lines.every((line) => validate(SessionLogRecordSchema, line).ok)).toBe(true);
    expect(await store.list(root)).toMatchObject([{ sessionId, turnCount: 0, status: 'ACTIVE' }]);
  });

  it('leaves seq unchanged when a write fails', async () => {
    const persistence = new MemorySessionPersistence();
    const store = new SessionLogStore(persistence);
    await store.create(createInput(newId('ses')));
    persistence.failAppends = true;
    expect(await failureOf(store.append({ type: 'LOG_TAIL_REPAIRED', truncatedBytes: 1 }))).toBe(
      'SESSION_STORAGE_FAILED',
    );
    persistence.failAppends = false;
    expect((await store.append({ type: 'LOG_TAIL_REPAIRED', truncatedBytes: 1 })).seq).toBe(2);
  });

  it('refuses a second holder of the Session lock', async () => {
    const persistence = new MemorySessionPersistence();
    const sessionId = newId('ses');
    await new SessionLogStore(persistence).create(createInput(sessionId));
    expect(await failureOf(new SessionLogStore(persistence).open(sessionId, digest))).toBe(
      'SESSION_LOCKED',
    );
  });
});

describe('opening', () => {
  async function closedSession() {
    const persistence = new MemorySessionPersistence();
    const store = new SessionLogStore(persistence);
    const sessionId = newId('ses');
    await store.create(createInput(sessionId));
    return { persistence, store, sessionId };
  }

  it('rebuilds a cleanly closed log without adding anything', async () => {
    const { store, sessionId, persistence } = await closedSession();
    await store.close();
    const opened = await store.open(sessionId, digest);
    expect(opened.records).toHaveLength(1);
    expect(opened.definitionsChanged).toBe(false);
    expect(persistence.linesOf(logKey(sessionId))).toHaveLength(1);
  });

  it('records a repaired tail', async () => {
    const { store, sessionId, persistence } = await closedSession();
    await store.close();
    persistence.torn.set(logKey(sessionId), 7);
    const opened = await store.open(sessionId, digest);
    expect(opened.records.at(-1)).toMatchObject({
      type: 'LOG_TAIL_REPAIRED',
      truncatedBytes: 7,
      seq: 2,
    });
  });

  it('notices changed definitions', async () => {
    const { store, sessionId } = await closedSession();
    await store.close();
    expect((await store.open(sessionId, 'b'.repeat(64))).definitionsChanged).toBe(true);
  });

  it.each([
    [
      'a gap in seq',
      (lines: unknown[]) =>
        lines.push({
          type: 'LOG_TAIL_REPAIRED',
          seq: 5,
          at: '2026-10-31T00:00:00.000Z',
          truncatedBytes: 1,
        }),
      'SESSION_LOG_CORRUPT',
    ],
    [
      'an unknown record',
      (lines: unknown[]) =>
        lines.push({ type: 'SOMETHING_NEW', seq: 2, at: '2026-10-31T00:00:00.000Z' }),
      'SESSION_LOG_CORRUPT',
    ],
    [
      'an unknown format',
      (lines: unknown[]) => {
        (lines[0] as { formatVersion: number }).formatVersion = 2;
      },
      'SESSION_FORMAT_UNSUPPORTED',
    ],
    [
      'an empty log',
      (lines: unknown[]) => {
        lines.length = 0;
      },
      'SESSION_LOG_CORRUPT',
    ],
  ])('refuses %s and releases the lock', async (_name, damage, code) => {
    const { store, sessionId, persistence } = await closedSession();
    await store.close();
    damage(persistence.linesOf(logKey(sessionId)));
    expect(await failureOf(store.open(sessionId, digest))).toBe(code);
    expect(persistence.locks.has(sessionId)).toBe(false);
  });

  it('settles what a crashed process left, once', async () => {
    const { store, sessionId, persistence } = await closedSession();
    const requestId = newId('req');
    await store.append({
      type: 'WORKFLOW_RUN_STARTED',
      workflowRunId: run,
      mode: 'CHAT',
      preset: 'standard',
      initialInput: true,
    });
    await store.append({
      type: 'TURN_STARTED',
      workflowRunId: run,
      turnId: turn,
      promptNodeId: `nod_${'c'.repeat(32)}`,
    });
    await store.append(unit(requestId));
    await store.close();
    const opened = await store.open(sessionId, digest);
    expect(opened.records.slice(-4).map((record) => record.type)).toEqual([
      'UNIT_INTERRUPTED',
      'TURN_ENDED',
      'WORKFLOW_RUN_ENDED',
      'STALE_UNITS_SETTLED',
    ]);
    expect(opened.records.at(-1)).toMatchObject({
      requestIds: [requestId],
      turnIds: [turn],
      workflowRunIds: [run],
    });
    await store.close();
    const before = persistence.linesOf(logKey(sessionId)).length;
    await store.open(sessionId, digest);
    expect(persistence.linesOf(logKey(sessionId))).toHaveLength(before);
  });
});

describe('Session list', () => {
  it('keeps the last line per Session, newest first, for this repository only', async () => {
    let clock = 0;
    const persistence = new MemorySessionPersistence();
    const store = new SessionLogStore(persistence, () => new Date(1_000_000 + (clock += 1000)));
    const [first, second, other] = [newId('ses'), newId('ses'), newId('ses')];
    await store.create(createInput(first));
    await store.close();
    await store.create(createInput(second));
    await store.close();
    await store.create({ ...createInput(other), repositoryRoot: '/elsewhere' });
    await store.close();
    await store.open(first, digest);
    await store.recordTurnClosed();
    await store.close();
    expect((await store.list(root)).map((entry) => [entry.sessionId, entry.turnCount])).toEqual([
      [first, 1],
      [second, 0],
    ]);
  });

  it('keeps the first title and drops deleted Sessions', async () => {
    const persistence = new MemorySessionPersistence();
    const store = new SessionLogStore(persistence);
    const sessionId = newId('ses');
    await store.create(createInput(sessionId));
    const sha256 = 'd'.repeat(64);
    const titleRef = { artifactId: `art_${sha256}`, sha256, size: 1, mediaType: 'text/plain' };
    await store.setTitle(titleRef);
    await store.setTitle({ ...titleRef, size: 2 });
    expect((await store.list(root))[0]?.titleRef?.size).toBe(1);
    await store.close();
    await store.remove(sessionId);
    expect(await store.list(root)).toEqual([]);
    expect(persistence.directories.has(sessionId)).toBe(false);
  });
});

describe('settling is a pure function of the log', () => {
  it('never settles anything twice, whatever was left open', () => {
    const requestIds = [newId('req'), newId('req'), newId('req')];
    fc.assert(
      fc.property(fc.subarray(requestIds), (completed) => {
        let seq = 0;
        const stamp = (record: object) => ({
          ...record,
          seq: (seq += 1),
          at: '2026-10-31T00:00:00.000Z',
        });
        const records = [
          stamp({
            type: 'WORKFLOW_RUN_STARTED',
            workflowRunId: run,
            mode: 'CHAT',
            preset: 'standard',
            initialInput: true,
          }),
          ...requestIds.map((requestId) => stamp(unit(requestId))),
          ...completed.map((requestId) =>
            stamp({ type: 'UNIT_COMPLETED', workflowRunId: run, requestId, status: 'OK', budget }),
          ),
        ] as unknown as Parameters<typeof settleStaleRecords>[0];
        const settled = settleStaleRecords(records);
        expect(settled.filter((record) => record.type === 'UNIT_INTERRUPTED')).toHaveLength(
          requestIds.length - completed.length,
        );
        const after = [...records, ...settled.map((record) => stamp(record))] as Parameters<
          typeof settleStaleRecords
        >[0];
        expect(settleStaleRecords(after)).toEqual([]);
      }),
    );
  });
});
