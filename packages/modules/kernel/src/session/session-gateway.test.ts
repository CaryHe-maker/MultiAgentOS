import {
  newId,
  type AppendLogPort,
  type BoundaryContext,
  type ReportSessionCommandRequest,
  type SessionRefLine,
  type WorkflowGatewayPort,
} from '@multiagentos/contracts';
import { testArtifactRef, testId } from '@multiagentos/contracts/test-support';
import { describe, expect, it } from 'vitest';
import { testRunWork } from '../test-support/run-work.js';
import { SessionActor } from './session-actor.js';
import { SessionCore } from './session-core.js';
import { SessionGateway } from './session-gateway.js';
import { SessionManager } from './session-manager.js';
import { KernelOutbox, type ToInteraction, type ToWorkflow } from './session-outbox.js';
import { SessionRefs } from './session-refs.js';

let humanRequests = 0;
const newHumanRequest = (): string => {
  humanRequests += 1;
  return testId('hrq', humanRequests);
};

const context: BoundaryContext = {
  correlationId: newId('cor'),
  tenantId: 'local',
  projectId: 'local',
};

function checks() {
  const forwarded: unknown[] = [];
  const sessionId = newId('ses');
  const gateway = new SessionGateway({
    handle: (forward) => {
      forwarded.push(forward);
      return Promise.resolve({ requestId: forward.request.requestId, outcome: 'ACCEPTED' });
    },
    isOpenSession: (id) => id === sessionId,
  });
  return { gateway, forwarded, sessionId };
}

describe('the door', () => {
  it('gives each caller only its own requests, and refuses what breaks the Schema', async () => {
    const { gateway, forwarded } = checks();
    expect('shutdown' in gateway.workflow).toBe(false);
    expect('submitUnit' in gateway.interaction).toBe(false);
    const reply = await gateway.interaction.listSessions({ requestId: 'bad' }, context);
    expect(reply).toMatchObject({ issuer: 'GATEWAY', reasonCode: 'INVALID_REQUEST' });
    expect(forwarded).toEqual([]);
  });

  it('refuses a Session that is not open, and a run it does not know', async () => {
    const { gateway, sessionId } = checks();
    const requestId = newId('req');
    const human = (session: string) =>
      ({
        requestId,
        sessionId: session,
        workflowRunId: newId('wfr'),
        humanRequestId: newHumanRequest(),
        nodeId: `nod_${'a'.repeat(32)}`,
        kind: 'prompt',
      }) as const;
    expect(await gateway.workflow.requestHuman(human(newId('ses')), context)).toMatchObject({
      reasonCode: 'SESSION_NOT_FOUND',
    });
    expect(await gateway.workflow.requestHuman(human(sessionId), context)).toMatchObject({
      reasonCode: 'RUN_NOT_FOUND',
    });
  });

  it('blocks new work once the run left RUNNING, and never lifts it', async () => {
    const { gateway, sessionId, forwarded } = checks();
    const workflowRunId = newId('wfr');
    gateway.admission(workflowRunId, sessionId, 'RUNNING');
    gateway.admission(workflowRunId, sessionId, 'CONVERGING', 'CANCELLED');
    gateway.admission(workflowRunId, sessionId, 'RUNNING');
    const request = { requestId: newId('req'), sessionId, workflowRunId };
    expect(
      await gateway.workflow.requestHuman(
        {
          ...request,
          humanRequestId: newHumanRequest(),
          nodeId: `nod_${'a'.repeat(32)}`,
          kind: 'prompt',
        },
        context,
      ),
    ).toMatchObject({ reasonCode: 'RUN_BLOCKED', closeReason: 'CANCELLED', issuer: 'GATEWAY' });
    expect(
      await gateway.workflow.closeRun({ ...request, outcome: 'CANCELLED' }, context),
    ).toMatchObject({
      outcome: 'ACCEPTED',
    });
    expect(forwarded).toHaveLength(1);
  });

  it('generates the sessionId of a new Session', async () => {
    const { gateway, forwarded } = checks();
    await gateway.interaction.startSession(
      {
        requestId: newId('req'),
        mode: 'NEW',
        prompt: { inputId: newId('inp'), text: 'hello' },
      },
      context,
    );
    expect(forwarded).toMatchObject([
      { requestType: 'startSession', sessionId: expect.any(String) as string },
    ]);
  });
});

/** Gateway, Core, Session management and the actor together; Workflow answers the commands. */
function stack() {
  const toWorkflow: ToWorkflow[] = [];
  const toInteraction: ToInteraction[] = [];
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
  const gatewayRef: { current?: SessionGateway } = {};
  const workflow = (): WorkflowGatewayPort => {
    if (gatewayRef.current === undefined) throw new Error('no gateway');
    return gatewayRef.current.workflow;
  };
  const outbox = new KernelOutbox(
    {
      toWorkflow: (event) => {
        toWorkflow.push(event);
        if (event.event.type === 'SessionCommand' && 'sessionId' in event) {
          const { command, commandId } = event.event;
          const result =
            command === 'CLOSE'
              ? ({ command, outcome: 'DONE' } as const)
              : command === 'FORK'
                ? ({
                    command,
                    outcome: 'READY',
                    inheritedArtifacts: [],
                    fromTurnCount: 0,
                  } as ReportSessionCommandRequest['result'])
                : ({ command, outcome: 'READY' } as ReportSessionCommandRequest['result']);
          const { sessionId } = event;
          queueMicrotask(() => {
            void workflow().reportSessionCommand(
              { requestId: newId('req'), sessionId, commandId, result },
              context,
            );
          });
        }
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
  const manager: SessionManager = new SessionManager({
    repositoryRoot: '/repository',
    refs: new SessionRefs(log, '/repository', () => new Date(0)),
    outbox,
    closeTimeoutMs: 100,
    startArtifactSweep: () => undefined,
    sweepIntervalMs: 60_000,
    schedule: () => () => undefined,
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
          admission: (workflowRunId, runState, closeReason) => {
            gatewayRef.current?.admission(workflowRunId, sessionId, runState, closeReason);
          },
          onFatal: (error) => {
            throw error;
          },
        }),
      ),
    removeSessionFiles: () => Promise.resolve(),
    titleOf: () => Promise.resolve(undefined),
  });
  const core = new SessionCore({ manager, artifactsOf: () => undefined });
  const gateway = new SessionGateway({
    handle: (forward, sessionId) => core.handle(forward, sessionId),
    isOpenSession: (sessionId) => manager.actor(sessionId) !== undefined,
  });
  gatewayRef.current = gateway;
  const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { gateway, toWorkflow, toInteraction, wait };
}

describe('a Turn through the whole Kernel', () => {
  async function started() {
    const kernel = stack();
    const accepted = await kernel.gateway.interaction.startSession(
      {
        requestId: newId('req'),
        mode: 'NEW',
        prompt: { inputId: newId('inp'), text: 'hello' },
      },
      context,
    );
    if (accepted.outcome !== 'ACCEPTED') throw new Error('not accepted');
    await kernel.wait();
    const start = kernel.toWorkflow.find((event) => event.event.type === 'RunStart');
    if (start === undefined || !('workflowRunId' in start)) throw new Error('no run');
    const ids = { sessionId: accepted.sessionId, workflowRunId: start.workflowRunId };
    return { ...kernel, ids };
  }
  const human = (ids: { sessionId: string; workflowRunId: string }, humanRequestId: string) => ({
    ...ids,
    requestId: newId('req'),
    humanRequestId,
    nodeId: `nod_${'a'.repeat(32)}`,
    kind: 'prompt' as const,
  });

  it('closes the Turn on a request, and opens the next on the answer', async () => {
    const { gateway, ids, toWorkflow, wait } = await started();
    const humanRequestId = newHumanRequest();
    expect(await gateway.workflow.requestHuman(human(ids, humanRequestId), context)).toMatchObject({
      outcome: 'ACCEPTED',
    });
    const input = { inputId: newId('inp'), text: 'more' };
    const answer = { ...ids, humanRequestId, input };
    await gateway.interaction.answerHuman({ ...answer, requestId: newId('req') }, context);
    await wait();
    const opened = () => toWorkflow.filter((event) => event.event.type === 'HumanAnswered');
    expect(opened()).toHaveLength(2);
    await gateway.interaction.answerHuman({ ...answer, requestId: newId('req') }, context);
    await wait();
    expect(opened()).toHaveLength(2);
  });

  it('closes the run, and the door then blocks it', async () => {
    const { gateway, ids, toWorkflow, wait } = await started();
    await gateway.workflow.closeRun(
      { ...ids, requestId: newId('req'), outcome: 'COMPLETED' },
      context,
    );
    await wait();
    expect(toWorkflow.at(-1)?.event.type).toBe('RunClosed');
    expect(
      await gateway.workflow.requestHuman(human(ids, newHumanRequest()), context),
    ).toMatchObject({
      reasonCode: 'RUN_BLOCKED',
      closeReason: 'COMPLETED',
    });
  });

  it('refuses a result that is not an artifact of this Session', async () => {
    const { gateway, ids } = await started();
    expect(
      await gateway.workflow.closeRun(
        { ...ids, requestId: newId('req'), outcome: 'COMPLETED', resultRef: testArtifactRef() },
        context,
      ),
    ).toMatchObject({ reasonCode: 'INVALID_ARTIFACT_REF' });
  });
});
