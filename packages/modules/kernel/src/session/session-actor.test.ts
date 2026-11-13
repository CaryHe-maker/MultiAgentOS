import {
  InteractionInboxEventSchema,
  InteractionSessionEventSchema,
  WorkflowInboxEventSchema,
  WorkflowSessionEventSchema,
  assertValid,
  newId,
  type ArtifactRef,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { testRunWork } from '../test-support/run-work.js';
import type { RollBackPlan } from './workspace-snapshots.js';
import { SessionActor, type SessionDuties, type SessionStart } from './session-actor.js';
import { KernelOutbox, type ToInteraction, type ToWorkflow } from './session-outbox.js';

const sha256 = 'a'.repeat(64);
const ref: ArtifactRef = { artifactId: `art_${sha256}`, sha256, size: 1, mediaType: 'text/plain' };
const summary: ArtifactRef = {
  ...ref,
  mediaType: 'application/vnd.multiagentos.run-summary+json',
};
const input = () => ({ inputId: newId('inp'), text: 'hello' });
const sessionId = newId('ses');

function setup(options: { summaryFails?: boolean; snapshots?: SessionDuties['snapshots'] } = {}) {
  const toWorkflow: ToWorkflow[] = [];
  const toInteraction: ToInteraction[] = [];
  const closed: string[] = [];
  const removed: string[] = [];
  const faults: unknown[] = [];
  const outbox = new KernelOutbox(
    {
      toWorkflow: (event) => {
        toWorkflow.push(
          'workflowRunId' in event
            ? assertValid(WorkflowInboxEventSchema, event)
            : assertValid(WorkflowSessionEventSchema, event),
        );
        return Promise.resolve();
      },
      toInteraction: (event) => {
        toInteraction.push(
          'workflowRunId' in event
            ? assertValid(InteractionInboxEventSchema, event)
            : assertValid(InteractionSessionEventSchema, event),
        );
        return Promise.resolve();
      },
    },
    (error) => faults.push(error),
    () => new Date('2026-10-31T00:00:00.000Z'),
  );
  const actor = new SessionActor({
    sessionId,
    repositoryRoot: '/repository',
    outbox,
    duties: {
      ...(options.snapshots === undefined ? {} : { snapshots: options.snapshots }),
      storeUserInput: () => Promise.resolve(ref),
      openRunWork: (host) => testRunWork(host),
      writeRunSummary: () => Promise.resolve(options.summaryFails === true ? undefined : summary),
      discardSession: () => {
        removed.push(sessionId);
        return Promise.resolve();
      },
    },
    onClosed: (id) => closed.push(id),
    admission: () => undefined,
    onFatal: (error) => faults.push(error),
  });
  const settled = async () => {
    await actor.idle();
    await outbox.drained();
  };
  const lastCommand = () => {
    const command = [...toWorkflow].reverse().find((e) => e.event.type === 'SessionCommand');
    if (command?.event.type !== 'SessionCommand') throw new Error('no command');
    return command.event;
  };
  const ready = async () => {
    const event = lastCommand();
    actor.reportCommand({
      requestId: newId('req'),
      sessionId,
      commandId: event.commandId,
      result:
        event.command === 'OPEN'
          ? { command: 'OPEN', outcome: 'READY', turnCount: 0 }
          : event.command === 'CREATE'
            ? { command: 'CREATE', outcome: 'READY' }
            : { command: 'CLOSE', outcome: 'DONE' },
    });
    await settled();
  };
  const begin = async (
    start: SessionStart = { kind: 'NEW', requestId: newId('req'), input: input() },
  ) => {
    actor.start(start);
    await settled();
    await ready();
  };
  const currentRun = () => {
    const start = [...toWorkflow].reverse().find((e) => e.event.type === 'RunStart');
    if (start === undefined || !('workflowRunId' in start)) throw new Error('no run');
    const run = actor.run(start.workflowRunId);
    if (run === undefined) throw new Error('not current');
    return run;
  };
  return {
    actor,
    toWorkflow,
    toInteraction,
    closed,
    removed,
    faults,
    settled,
    ready,
    begin,
    lastCommand,
    currentRun,
  };
}

const workflowTypes = (events: readonly ToWorkflow[]) =>
  events.map((e) => (e.event.type === 'SessionCommand' ? e.event.command : e.event.type));
const interactionTypes = (events: readonly ToInteraction[]) => events.map((e) => e.event.type);

describe('new Session', () => {
  it('announces the Session before the run, and the prompt opens a Turn', async () => {
    const { begin, toWorkflow, toInteraction } = setup();
    await begin();
    expect(workflowTypes(toWorkflow)).toEqual(['CREATE', 'RunStart', 'HumanAnswered']);
    expect(interactionTypes(toInteraction)).toEqual(['SessionOpened', 'RunStateChanged']);
    expect(toWorkflow[1]?.event).toMatchObject({ mode: 'CHAT', initialInput: true });
  });

  it('carries the prompt by reference only', async () => {
    const { begin, toWorkflow } = setup();
    await begin({
      kind: 'NEW',
      requestId: newId('req'),
      input: { inputId: newId('inp'), text: 'secret words' },
    });
    expect(JSON.stringify(toWorkflow)).not.toContain('secret words');
  });

  it('starts a template run', async () => {
    const { begin, toWorkflow } = setup();
    const template = { id: 'analyze', version: 'v1.0.0' };
    await begin({ kind: 'NEW', requestId: newId('req'), input: input(), template });
    expect(toWorkflow[1]?.event).toMatchObject({ mode: 'ORCHESTRATION', templateRef: template });
  });

  it('cleans up and ends the sequence when Workflow cannot create it', async () => {
    const { actor, settled, lastCommand, toInteraction, closed, removed } = setup();
    actor.start({ kind: 'NEW', requestId: newId('req'), input: input() });
    await settled();
    actor.reportCommand({
      requestId: newId('req'),
      sessionId,
      commandId: lastCommand().commandId,
      result: { command: 'CREATE', outcome: 'FAILED', failure: { code: 'SESSION_STORAGE_FAILED' } },
    });
    await settled();
    expect(interactionTypes(toInteraction)).toEqual(['SessionFailed']);
    expect(closed).toEqual([sessionId]);
    expect(removed).toEqual([sessionId]);
  });
});

describe('opening a Session', () => {
  it('starts a run without initial input and without a Turn', async () => {
    const { begin, toWorkflow, currentRun } = setup();
    await begin({ kind: 'OPEN', requestId: newId('req') });
    expect(workflowTypes(toWorkflow)).toEqual(['OPEN', 'RunStart']);
    expect(toWorkflow[1]?.event).toMatchObject({ initialInput: false });
    expect(currentRun().control.turnId).toBeUndefined();
  });

  it('keeps nothing of a Session that could not open', async () => {
    const { actor, settled, lastCommand, toInteraction, removed } = setup();
    actor.start({ kind: 'OPEN', requestId: newId('req') });
    await settled();
    actor.reportCommand({
      requestId: newId('req'),
      sessionId,
      commandId: lastCommand().commandId,
      result: { command: 'OPEN', outcome: 'FAILED', failure: { code: 'SESSION_LOCKED' } },
    });
    await settled();
    expect(toInteraction.at(-1)?.event).toMatchObject({
      type: 'SessionFailed',
      code: 'SESSION_LOCKED',
    });
    expect(removed).toEqual([]);
  });
});

describe('undo', () => {
  const planOf = (external: RollBackPlan['external']): RollBackPlan => ({
    checkpointId: 'ckp_01ABCDEFGHJKMNPQRSTVWXYZ00',
    label: 'user input',
    inclusive: true,
    files: [{ path: 'a.txt' }],
    currentTree: 't'.repeat(40),
    external,
  });
  const edited = [{ path: 'a.txt', change: 'MODIFIED' }] as const;
  const snapshots = (overrides: Partial<NonNullable<SessionDuties['snapshots']>> = {}) => ({
    checkpoint: () => Promise.resolve('t'.repeat(40)),
    settle: () => Promise.resolve({}),
    planUndo: () => Promise.resolve({ kind: 'PLAN', plan: planOf([]) } as const),
    planRewind: () => Promise.resolve({ kind: 'NOTHING_TO_UNDO' } as const),
    applyRollBack: () => Promise.resolve({ ok: true, files: ['a.txt'] } as const),
    diffLatest: () => Promise.resolve(undefined),
    divergedFiles: () => Promise.resolve([]),
    listCheckpoints: () => Promise.resolve([]),
    diffCheckpoint: () => Promise.resolve(undefined),
    ...overrides,
  });
  const awaiting = async (kernel: ReturnType<typeof setup>) => {
    await kernel.begin();
    const run = kernel.currentRun();
    await kernel.actor.call(() => kernel.actor.requestOpenInput(run, 'hrq_01ABCDEFGH'));
    await kernel.settled();
    return run;
  };
  const events = (kernel: ReturnType<typeof setup>, type: string) =>
    kernel.toInteraction.flatMap((e) => (e.event.type === type ? [e.event] : []));

  it('is only for a run that waits for input', async () => {
    const kernel = setup({ snapshots: snapshots() });
    await kernel.begin();
    const run = kernel.currentRun();
    expect(await kernel.actor.call(() => kernel.actor.undoTurns(run, 'LAST'))).toEqual({
      accepted: false,
      reasonCode: 'UNDO_NOT_AVAILABLE',
    });
  });

  it('without external changes goes straight on, and tells both sides', async () => {
    const kernel = setup({ snapshots: snapshots() });
    const run = await awaiting(kernel);
    await kernel.actor.call(() => kernel.actor.undoTurns(run, 'LAST'));
    await kernel.settled();
    expect(events(kernel, 'CheckpointRolledBack')).toMatchObject([
      { undo: true, files: ['a.txt'] },
    ]);
    expect(events(kernel, 'CheckpointRolledBack')[0]).not.toHaveProperty('forced');
    expect(kernel.toWorkflow.at(-1)?.event).toMatchObject({
      type: 'CheckpointRolledBack',
      undo: true,
    });
    expect(events(kernel, 'UndoConfirmationRequested')).toEqual([]);
  });

  it('H9: a file changed after the force stops it and asks again', async () => {
    const applied: boolean[] = [];
    const kernel = setup({
      snapshots: snapshots({
        planUndo: () => Promise.resolve({ kind: 'PLAN', plan: planOf(edited) }),
        applyRollBack: (_plan, forced) => {
          applied.push(forced);
          return Promise.resolve(
            applied.length === 1 ? ({ ok: false } as const) : ({ ok: true, files: [] } as const),
          );
        },
      }),
    });
    const run = await awaiting(kernel);
    await kernel.actor.call(() => kernel.actor.undoTurns(run, 'LAST'));
    await kernel.settled();
    const [first] = events(kernel, 'UndoConfirmationRequested') as { undoId: string }[];
    await kernel.actor.call(() => kernel.actor.confirmUndo(run, first?.undoId ?? '', 'FORCE'));
    await kernel.settled();
    expect(events(kernel, 'CheckpointRolledBack')).toEqual([]);
    const asked = events(kernel, 'UndoConfirmationRequested') as { undoId: string }[];
    expect(asked).toHaveLength(2);
    expect(asked[1]?.undoId).not.toBe(first?.undoId);

    // The old confirmation is spent; the new one finishes it.
    expect(
      await kernel.actor.call(() => kernel.actor.confirmUndo(run, first?.undoId ?? '', 'FORCE')),
    ).toEqual({ accepted: false, reasonCode: 'UNDO_UNKNOWN' });
    await kernel.actor.call(() => kernel.actor.confirmUndo(run, asked[1]?.undoId ?? '', 'FORCE'));
    await kernel.settled();
    expect(events(kernel, 'CheckpointRolledBack')).toMatchObject([{ forced: true }]);
    expect(applied).toEqual([true, true]);
  });

  it('says so when the failed undo has nothing left to ask about', async () => {
    const kernel = setup({
      snapshots: snapshots({
        applyRollBack: () => Promise.reject(new Error('a link on the way')),
      }),
    });
    const run = await awaiting(kernel);
    await kernel.actor.call(() => kernel.actor.undoTurns(run, 'LAST'));
    await kernel.settled();
    expect(events(kernel, 'UndoCancelled')).toMatchObject([{ reason: 'FILE_CHANGED' }]);
    expect(kernel.faults).toEqual([]);
  });

  it('the next message cancels a confirmation', async () => {
    const kernel = setup({
      snapshots: snapshots({
        planUndo: () => Promise.resolve({ kind: 'PLAN', plan: planOf(edited) }),
      }),
    });
    const run = await awaiting(kernel);
    await kernel.actor.call(() => kernel.actor.undoTurns(run, 'LAST'));
    await kernel.actor.call(() => kernel.actor.answerOpenInput(run, 'hrq_01ABCDEFGH', input()));
    await kernel.settled();
    expect(events(kernel, 'UndoCancelled')).toMatchObject([{ reason: 'NEW_INPUT' }]);
  });

  it('without snapshots there is nothing to undo with', async () => {
    const kernel = setup();
    const run = await awaiting(kernel);
    expect(await kernel.actor.call(() => kernel.actor.undoTurns(run, 'LAST'))).toEqual({
      accepted: false,
      reasonCode: 'UNDO_NOT_AVAILABLE',
    });
  });
});

describe('Turns', () => {
  it('closes the Turn on open input and opens the next on the answer', async () => {
    const { actor, begin, settled, toWorkflow, toInteraction, currentRun } = setup();
    await begin();
    const run = currentRun();
    await actor.call(() => actor.requestOpenInput(run, 'hrq_01ABCDEFGH'));
    await settled();
    expect(workflowTypes(toWorkflow).at(-1)).toBe('TurnClosed');
    expect(interactionTypes(toInteraction).slice(-2)).toEqual(['RunStateChanged', 'HumanRequest']);
    expect(run.control.phase).toBe('AWAITING_INPUT');

    const refused = await actor.call(() => actor.answerOpenInput(run, 'hrq_01WRONGONE', input()));
    expect(refused).toEqual({ accepted: false, reasonCode: 'HUMAN_REQUEST_NOT_PENDING' });
    await actor.call(() => actor.answerOpenInput(run, 'hrq_01ABCDEFGH', input()));
    await settled();
    expect(workflowTypes(toWorkflow).at(-1)).toBe('HumanAnswered');
    expect(toWorkflow.at(-1)?.event).toMatchObject({ origin: 'requested' });
    expect(run.control.phase).toBe('RUNNING');
  });

  it('refuses open input while work is active', async () => {
    const { actor, begin, currentRun } = setup();
    await begin();
    const run = currentRun();
    await actor.call(() => actor.registerAgentRun(run, 'agr_1'));
    const decision = await actor.call(() => actor.requestOpenInput(run, 'hrq_01ABCDEFGH'));
    expect(decision).toEqual({ accepted: false, reasonCode: 'AGENT_RUN_ACTIVE' });
  });
});

describe('closing a run', () => {
  it('ends the Turn first, then RunClosed, then RunFinished', async () => {
    const { actor, begin, settled, toWorkflow, toInteraction, currentRun } = setup();
    await begin();
    const run = currentRun();
    await actor.call(() => actor.closeRun(run, { closeReason: 'COMPLETED', resultRef: ref }));
    await settled();
    expect(workflowTypes(toWorkflow).slice(-2)).toEqual(['TurnClosed', 'RunClosed']);
    expect(toWorkflow.at(-2)?.event).toMatchObject({ reason: 'RUN_CLOSED' });
    expect(toInteraction.at(-1)?.event).toMatchObject({
      type: 'RunFinished',
      closeReason: 'COMPLETED',
      resultRef: ref,
      runSummaryRef: summary,
    });
  });

  it('waits for attempts in flight', async () => {
    const { actor, begin, settled, toWorkflow, currentRun } = setup();
    await begin();
    const run = currentRun();
    await actor.call(() => {
      actor.attemptStarted(run, 'una_1');
      return actor.closeRun(run, { closeReason: 'CANCELLED' });
    });
    await settled();
    expect(workflowTypes(toWorkflow)).not.toContain('RunClosed');
    await actor.call(() => actor.attemptEnded(run, 'una_1'));
    await settled();
    expect(workflowTypes(toWorkflow).at(-1)).toBe('RunClosed');
  });

  it('reports a RunSummary that could not be written', async () => {
    const { actor, begin, settled, toInteraction, currentRun } = setup({ summaryFails: true });
    await begin();
    const run = currentRun();
    await actor.call(() => actor.closeRun(run, { closeReason: 'COMPLETED' }));
    await settled();
    expect(toInteraction.at(-1)?.event).toMatchObject({
      finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
    });
  });

  it('continues in the same Session once the run is closed', async () => {
    const { actor, begin, settled, toWorkflow, currentRun } = setup();
    await begin();
    const run = currentRun();
    expect(await actor.continueIfClosed()).toBe(false);
    await settled();
    expect(workflowTypes(toWorkflow).filter((type) => type === 'RunStart')).toHaveLength(1);
    await actor.call(() => actor.closeRun(run, { closeReason: 'BUDGET' }));
    expect(await actor.continueIfClosed()).toBe(true);
    await settled();
    expect(workflowTypes(toWorkflow).filter((type) => type === 'RunStart')).toHaveLength(2);
    expect(toWorkflow.at(-1)?.event).toMatchObject({ initialInput: false });
  });
});

describe('closing a Session', () => {
  it('converges the run, closes the Session and then reports it', async () => {
    const { actor, begin, settled, ready, toWorkflow, toInteraction, closed } = setup();
    await begin();
    actor.close('SWITCHED');
    await settled();
    expect(toWorkflow.at(-2)?.event).toMatchObject({
      type: 'RunClosed',
      closeReason: 'ENDED_BY_USER',
    });
    expect(workflowTypes(toWorkflow).at(-1)).toBe('CLOSE');
    expect(closed).toEqual([]);
    await ready();
    expect(toInteraction.at(-1)?.event).toMatchObject({
      type: 'SessionClosed',
      reason: 'SWITCHED',
    });
    expect(closed).toEqual([sessionId]);
  });

  it('numbers each sequence from 1', async () => {
    const { begin, toWorkflow } = setup();
    await begin();
    const [command, start, answered] = toWorkflow;
    expect([command?.seq, start?.seq, answered?.seq]).toEqual([1, 1, 2]);
  });
});
