import {
  newId,
  type AppendLogPort,
  type SessionListEntry,
  type SessionRefLine,
  type TrustedInstructionLine,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { SessionRefs, TrustRecords } from './session-refs.js';

function memoryLog<T>(initial: readonly T[] = []): AppendLogPort<T> & { lines: T[] } {
  const lines = [...initial];
  return {
    lines,
    append: (record) => {
      lines.push(record);
      return Promise.resolve();
    },
    readAll: () =>
      (async function* () {
        for (const line of lines) {
          await Promise.resolve();
          yield line;
        }
      })(),
    repairTail: () => Promise.resolve({ truncatedBytes: 0 }),
  };
}

const now = () => new Date('2026-10-31T00:00:00.000Z');
const root = '/repository';
const entry = (sessionId: string): SessionListEntry => ({
  sessionId,
  repositoryRoot: root,
  createdAt: '2026-10-31T00:00:00.000Z',
  lastActiveAt: '2026-10-31T00:00:00.000Z',
  turnCount: 0,
  status: 'ACTIVE',
});

describe('SessionRefs', () => {
  it('opens any active Session, and knows which folder it was last worked on in', async () => {
    const refs = new SessionRefs(memoryLog<SessionRefLine>(), root, now);
    const here = newId('ses');
    await refs.add(here);
    expect(refs.isOpenable(here)).toBe(true);
    expect(refs.isOpenable(newId('ses'))).toBe(false);
    await refs.markDeleted(here);
    expect(refs.isOpenable(here)).toBe(false);
  });

  it('says where a Session was last worked on, and rebinding makes this folder its own', async () => {
    const elsewhere = newId('ses');
    const log = memoryLog([
      {
        sessionId: elsewhere,
        repositoryRoot: '/other',
        status: 'ACTIVE' as const,
        at: now().toISOString(),
      },
    ]);
    const refs = new SessionRefs(log, root, now);
    await refs.load();
    expect(refs.isOpenable(elsewhere)).toBe(true);
    expect(refs.rootOf(elsewhere)).toBe('/other');
    expect(refs.isHere(elsewhere)).toBe(false);
    await refs.rebind(elsewhere);
    expect(refs.rootOf(elsewhere)).toBe(root);
    expect(refs.isHere(elsewhere)).toBe(true);
    // The new line is the last: after a restart it still is.
    const again = new SessionRefs(log, root, now);
    await again.load();
    expect(again.isHere(elsewhere)).toBe(true);
    expect(refs.rootOf(newId('ses'))).toBeUndefined();
  });

  it('takes the last line on load and keeps the Sessions of other folders in the list', async () => {
    const [kept, gone, elsewhere] = [newId('ses'), newId('ses'), newId('ses')];
    const at = now().toISOString();
    const log = memoryLog([
      { sessionId: kept, repositoryRoot: root, status: 'ACTIVE' as const, at },
      { sessionId: gone, repositoryRoot: root, status: 'ACTIVE' as const, at },
      { sessionId: gone, repositoryRoot: root, status: 'DELETED' as const, at },
      { sessionId: elsewhere, repositoryRoot: '/other', status: 'ACTIVE' as const, at },
    ]);
    const refs = new SessionRefs(log, root, now);
    await refs.load();
    expect(refs.filterList([entry(kept), entry(gone), entry(elsewhere)])).toEqual([
      entry(kept),
      entry(elsewhere),
    ]);
    expect(refs.activeSessionIds()).toEqual([kept, elsewhere]);
  });
});

describe('TrustRecords', () => {
  it('trusts exact content only, in one repository, across a restart', async () => {
    const log = memoryLog<TrustedInstructionLine>();
    const trust = new TrustRecords(log, now);
    await trust.record(root, 'AGENTS.md', 'a'.repeat(64), 'USER_CONFIRMED');
    expect(trust.isTrusted(root, 'AGENTS.md', 'a'.repeat(64))).toBe(true);
    expect(trust.isTrusted(root, 'AGENTS.md', 'b'.repeat(64))).toBe(false);
    expect(trust.isTrusted('/other', 'AGENTS.md', 'a'.repeat(64))).toBe(false);
    const reloaded = new TrustRecords(log, now);
    await reloaded.load();
    expect(reloaded.isTrusted(root, 'AGENTS.md', 'a'.repeat(64))).toBe(true);
  });
});
