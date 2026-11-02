import {
  newId,
  type AppendLogPort,
  type SessionListEntry,
  type SessionRefLine,
} from '@multiagentos/contracts';
import { testArtifactRef } from '@multiagentos/contracts/test-support';
import { describe, expect, it } from 'vitest';
import { testRunWork } from '../test-support/run-work.js';
import { SessionActor } from './session-actor.js';
import { SessionManager } from './session-manager.js';
import { KernelOutbox, type ToInteraction, type ToWorkflow } from './session-outbox.js';
import { SessionRefs } from './session-refs.js';

function setup(options: { removeFails?: boolean } = {}) {
  const toWorkflow: ToWorkflow[] = [];
  const toInteraction: ToInteraction[] = [];
  const removed: string[] = [];
  let answering = true;
  const lines: SessionRefLine[] = [];
  const log: AppendLogPort<SessionRefLine> = {
    append: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    async *readAll() {
      await Promise.resolve();
      yield* lines;
    },
    repairTail: () => Promise.resolve({ truncatedBytes: 0 }),
  };
  const refs = new SessionRefs(log, '/repository', () => new Date(0));
  let manager: SessionManager | undefined = undefined;
  const reply = (event: ToWorkflow) => {
    if (!answering) return;
    const body = event.event;
    if (body.type === 'SessionCommand') {
      const result =
        body.command === 'CLOSE'
          ? ({ command: 'CLOSE', outcome: 'DONE' } as const)
          : ({ command: body.command, outcome: 'READY' } as const);
      queueMicrotask(() => {
        (manager as unknown as SessionManager).reportSessionCommand({
          requestId: newId('req'),
          sessionId: (event as { sessionId: string }).sessionId,
          commandId: body.commandId,
          result,
        });
      });
    }
  };
  const outbox = new KernelOutbox(
    {
      toWorkflow: (event) => {
        toWorkflow.push(event);
        reply(event);
        return Promise.resolve();
      },
      toInteraction: (event) => {
        toInteraction.push(event);
        return Promise.resolve();
      },
    },
    () => undefined,
    () => new Date(0),
  );
  const instance = new SessionManager({
    repositoryRoot: '/repository',
    refs,
    outbox,
    openActor: (sessionId, { onClosed, discard }) =>
      Promise.resolve(
        new SessionActor({
          sessionId,
          repositoryRoot: '/repository',
          outbox,
          duties: {
            storeUserInput: () => Promise.resolve(testArtifactRef()),
            openRunWork: (host) => testRunWork(host),
            writeRunSummary: () => Promise.resolve(undefined),
            discardSession: discard,
          },
          onClosed,
          admission: () => undefined,
          onFatal: (error) => {
            throw error;
          },
        }),
      ),
    removeSessionFiles: (sessionId) => {
      removed.push(sessionId);
      return options.removeFails === true ? Promise.reject(new Error('disk')) : Promise.resolve();
    },
    closeTimeoutMs: 20,
    titleOf: (entry) => Promise.resolve(entry.sessionId === 'x' ? undefined : 'a'.repeat(100)),
  });
  manager = instance;
  const start = (sessionId = newId('ses')) =>
    instance.startSession(
      {
        requestId: newId('req'),
        mode: 'NEW',
        prompt: { inputId: newId('inp'), text: 'hello' },
      },
      sessionId,
    );
  const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    manager: instance,
    refs,
    outbox,
    toWorkflow,
    toInteraction,
    removed,
    start,
    wait,
    silence: () => {
      answering = false;
    },
  };
}

const types = (events: readonly { event: { type: string } }[]) => events.map((e) => e.event.type);

describe('at most one open Session', () => {
  it('closes the open Session before a new one starts', async () => {
    const { start, wait, toInteraction, manager } = setup();
    const first = newId('ses');
    const second = newId('ses');
    await start(first);
    await wait();
    await start(second);
    await wait();
    expect(types(toInteraction)).toContain('SessionClosed');
    expect(manager.actor(first)).toBeUndefined();
    expect(manager.actor(second)).toBeDefined();
  });

  it('opens a known Session and refuses an unknown one', async () => {
    const { start, wait, manager } = setup();
    const sessionId = newId('ses');
    await start(sessionId);
    await wait();
    await start();
    await wait();
    expect(await manager.openSession({ requestId: newId('req'), sessionId })).toMatchObject({
      outcome: 'ACCEPTED',
      sessionId,
    });
    expect(
      await manager.openSession({ requestId: newId('req'), sessionId: newId('ses') }),
    ).toMatchObject({ reasonCode: 'SESSION_NOT_FOUND' });
  });

  it('refuses to continue a Session whose run is still live', async () => {
    const { start, wait, manager } = setup();
    const sessionId = newId('ses');
    await start(sessionId);
    await wait();
    expect(await manager.openSession({ requestId: newId('req'), sessionId })).toMatchObject({
      reasonCode: 'SESSION_IN_USE',
    });
  });

  it('refuses Session requests once shutting down, and closes with SHUTDOWN', async () => {
    const { start, wait, manager, toInteraction } = setup();
    await start();
    await wait();
    await manager.shutdown();
    expect(toInteraction.at(-1)?.event).toMatchObject({
      type: 'SessionClosed',
      reason: 'SHUTDOWN',
    });
    expect(await start()).toMatchObject({ reasonCode: 'RUN_LIMIT' });
  });
});

describe('listing', () => {
  const entry = (sessionId: string): SessionListEntry => ({
    sessionId,
    createdAt: '2026-11-02T00:00:00.000Z',
    lastActiveAt: '2026-11-02T00:00:00.000Z',
    turnCount: 1,
    status: 'ACTIVE',
  });

  it('keeps only Sessions it knows, with short titles', async () => {
    const { manager, refs, toWorkflow, toInteraction, outbox } = setup();
    const known = newId('ses');
    await refs.add(known);
    const requestId = newId('req');
    const listing = manager.listSessions({ requestId });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await outbox.drained();
    const query = toWorkflow.at(-1)?.event;
    if (query?.type !== 'SessionListQuery') throw new Error('no query');
    expect(
      manager.reportSessionList({
        requestId: newId('req'),
        queryId: query.queryId,
        sessions: [entry(known), entry(newId('ses'))],
      }),
    ).toMatchObject({ outcome: 'ACCEPTED' });
    await listing;
    await outbox.drained();
    const list = toInteraction.at(-1)?.event;
    if (list?.type !== 'SessionList') throw new Error('no list');
    expect(list.sessions.map((session) => session.sessionId)).toEqual([known]);
    expect(list.sessions[0]?.title).toHaveLength(80);
  });

  it('refuses a reply nobody asked for', () => {
    const { manager } = setup();
    expect(
      manager.reportSessionList({ requestId: newId('req'), queryId: newId('slq'), sessions: [] }),
    ).toMatchObject({ reasonCode: 'SESSION_QUERY_UNKNOWN' });
  });
});

describe('deleting', () => {
  async function deleted(options?: { removeFails?: boolean }) {
    const context = setup(options);
    const sessionId = newId('ses');
    await context.refs.add(sessionId);
    const pending = context.manager.deleteSession({ requestId: newId('req'), sessionId });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await context.outbox.drained();
    const command = context.toWorkflow.at(-1)?.event;
    if (command?.type !== 'SessionDelete') throw new Error('no command');
    context.manager.reportSessionCommand({
      requestId: newId('req'),
      sessionId,
      commandId: command.commandId,
      result: { command: 'DELETE', outcome: 'DONE' },
    });
    await pending;
    await context.outbox.drained();
    return { ...context, sessionId };
  }

  it('deletes the reference first, then the files, then reports', async () => {
    const { refs, removed, toInteraction, sessionId } = await deleted();
    expect(refs.isOpenable(sessionId)).toBe(false);
    expect(removed).toEqual([sessionId]);
    expect(toInteraction.at(-1)?.event).toMatchObject({
      type: 'SessionDeleted',
      outcome: 'DELETED',
    });
  });

  it('reports a failed removal, and the Session stays deleted', async () => {
    const { refs, toInteraction, sessionId } = await deleted({ removeFails: true });
    expect(refs.isOpenable(sessionId)).toBe(false);
    expect(toInteraction.at(-1)?.event).toMatchObject({ outcome: 'FAILED' });
  });

  it('refuses the open Session', async () => {
    const { start, wait, manager } = setup();
    const sessionId = newId('ses');
    await start(sessionId);
    await wait();
    expect(await manager.deleteSession({ requestId: newId('req'), sessionId })).toMatchObject({
      reasonCode: 'SESSION_IN_USE',
    });
  });
});

describe('failure', () => {
  it('gives up a Session that never closes, and later requests go on', async () => {
    const { start, wait, manager, silence } = setup();
    const first = newId('ses');
    await start(first);
    await wait();
    silence();
    expect(await start()).toMatchObject({ outcome: 'ACCEPTED' });
    expect(manager.actor(first)).toBeUndefined();
  });

  it('deletes the reference of a Session Workflow could not create', async () => {
    const { manager, refs, removed, silence, start, wait, toWorkflow } = setup();
    silence();
    const sessionId = newId('ses');
    await start(sessionId);
    await wait();
    const command = toWorkflow[0]?.event;
    if (command?.type !== 'SessionCommand') throw new Error('no command');
    manager.reportSessionCommand({
      requestId: newId('req'),
      sessionId,
      commandId: command.commandId,
      result: { command: 'CREATE', outcome: 'FAILED', failure: { code: 'SESSION_STORAGE_FAILED' } },
    });
    await wait();
    expect(refs.isOpenable(sessionId)).toBe(false);
    expect(removed).toEqual([sessionId]);
  });
});

describe('command replies', () => {
  it('refuses a commandId nobody waits for', () => {
    const { manager } = setup();
    expect(
      manager.reportSessionCommand({
        requestId: newId('req'),
        sessionId: newId('ses'),
        commandId: newId('scm'),
        result: { command: 'CLOSE', outcome: 'DONE' },
      }),
    ).toMatchObject({ reasonCode: 'SESSION_COMMAND_UNKNOWN' });
  });
});
