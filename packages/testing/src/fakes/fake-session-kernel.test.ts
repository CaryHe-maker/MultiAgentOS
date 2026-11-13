import { describe, expect, it } from 'vitest';
import {
  newId,
  pathDerivedId,
  type BoundaryContext,
  type SubmitUnitRequest,
} from '@multiagentos/contracts';
import { createFakeSessionKernel, type FakeUnitScript } from './fake-session-kernel.js';
import { createFakeSessionWorkflow } from './fake-session-workflow.js';

const context: BoundaryContext = {
  correlationId: newId('cor'),
  tenantId: 'local',
  projectId: 'local',
};
const prompt = () => ({ inputId: newId('inp'), text: 'hello' });

function setup(units?: FakeUnitScript) {
  const kernel = createFakeSessionKernel(units === undefined ? {} : { units });
  const workflow = createFakeSessionWorkflow(kernel.gateway);
  kernel.onWorkflow(async (event) => {
    if ('workflowRunId' in event) return;
    await workflow.handle(event);
  });
  return { kernel, workflow };
}

const runEvents = (kernel: ReturnType<typeof createFakeSessionKernel>): string[] =>
  kernel.workflowEvents.map((event) =>
    event.event.type === 'SessionCommand' ? event.event.command : event.event.type,
  );
const uiEvents = (kernel: ReturnType<typeof createFakeSessionKernel>): string[] =>
  kernel.interactionEvents.map((event) => event.event.type);
const runIds = (kernel: ReturnType<typeof createFakeSessionKernel>) => {
  const started = kernel.workflowEvents.find((event) => 'workflowRunId' in event);
  if (started === undefined || !('workflowRunId' in started)) throw new Error('no run');
  return { sessionId: started.sessionId, workflowRunId: started.workflowRunId };
};
const lastTurn = (kernel: ReturnType<typeof createFakeSessionKernel>): string => {
  const answer = [...kernel.workflowEvents]
    .reverse()
    .find((event) => event.event.type === 'HumanAnswered' && event.event.kind === 'prompt');
  if (answer?.event.type !== 'HumanAnswered' || answer.event.kind !== 'prompt')
    throw new Error('no turn');
  return answer.event.checkpointId;
};

describe('fake Session Kernel', () => {
  it('runs the new Session sequence in order', async () => {
    const { kernel } = setup();
    const accepted = await kernel.interaction.startSession(
      { requestId: newId('req'), mode: 'NEW', prompt: prompt() },
      context,
    );
    await kernel.idle();
    expect(accepted.outcome).toBe('ACCEPTED');
    expect(runEvents(kernel)).toEqual(['CREATE', 'RunStart', 'HumanAnswered']);
    expect(uiEvents(kernel)).toEqual(['SessionOpened', 'RunStateChanged']);
  });

  it('reports a failed Session command and opens no run', async () => {
    const { kernel, workflow } = setup();
    workflow.failNext('SESSION_LOCKED');
    await kernel.interaction.startSession(
      { requestId: newId('req'), mode: 'NEW', prompt: prompt() },
      context,
    );
    await kernel.idle();
    expect(runEvents(kernel)).toEqual(['CREATE']);
    expect(kernel.interactionEvents.at(-1)?.event).toMatchObject({
      type: 'SessionFailed',
      code: 'SESSION_LOCKED',
    });
  });

  it('goes through Turns: open input closes one and the answer opens the next', async () => {
    const { kernel } = setup();
    await kernel.interaction.startSession(
      { requestId: newId('req'), mode: 'NEW', prompt: prompt() },
      context,
    );
    await kernel.idle();
    const ids = runIds(kernel);
    const humanRequestId = `hrq_${'a'.repeat(32)}`;
    await kernel.gateway.requestHuman(
      {
        requestId: newId('req'),
        ...ids,
        humanRequestId,
        nodeId: `nod_${'a'.repeat(32)}`,
        kind: 'prompt',
      },
      context,
    );
    await kernel.idle();
    expect(runEvents(kernel).at(-1)).toBe('InputSettled');
    expect(uiEvents(kernel).slice(-2)).toEqual(['RunStateChanged', 'HumanRequest']);
    const first = lastTurn(kernel);
    await kernel.interaction.answerHuman(
      { requestId: newId('req'), ...ids, humanRequestId, input: prompt() },
      context,
    );
    await kernel.idle();
    expect(lastTurn(kernel)).not.toBe(first);
    expect(
      (
        await kernel.interaction.answerHuman(
          { requestId: newId('req'), ...ids, humanRequestId, input: prompt() },
          context,
        )
      ).outcome,
    ).toBe('REJECTED');
  });

  it('refuses open input while an AgentRun is active, and work outside a Turn', async () => {
    const { kernel } = setup();
    await kernel.interaction.startSession(
      { requestId: newId('req'), mode: 'NEW', prompt: prompt() },
      context,
    );
    await kernel.idle();
    const ids = runIds(kernel);
    const agentRunId = newId('agr');
    const register = () =>
      kernel.gateway.registerAgentRun(
        {
          requestId: newId('req'),
          ...ids,
          agentRunId,
          nodeId: `nod_${'a'.repeat(32)}`,
          agentRef: { kind: 'AGENT', id: 'main', version: 'v1.0.0', digest: 'a'.repeat(64) },
          effort: 'high',
          workspaceViewId: 'main',
          requestedCapabilities: ['repo.read'],
          writeRoots: [],
          display: { label: 'main' },
        },
        context,
      );
    expect((await register()).outcome).toBe('ACCEPTED');
    const humanRequestId = `hrq_${'a'.repeat(32)}`;
    const human = () =>
      kernel.gateway.requestHuman(
        {
          requestId: newId('req'),
          ...ids,
          humanRequestId,
          nodeId: `nod_${'a'.repeat(32)}`,
          kind: 'prompt',
        },
        context,
      );
    expect(await human()).toMatchObject({ reasonCode: 'AGENT_RUN_ACTIVE' });
    await kernel.gateway.endAgentRun({ requestId: newId('req'), ...ids, agentRunId }, context);
    expect((await human()).outcome).toBe('ACCEPTED');
    await kernel.idle();
    expect(await register()).toMatchObject({ reasonCode: 'NO_OPEN_INPUT' });
  });

  it('reports each accepted Unit as scripted', async () => {
    const script: FakeUnitScript = (_request, index) =>
      index === 0 ? { reject: 'NOT_FOUND' } : { fail: 'PROVIDER_ERROR' };
    const { kernel } = setup(script);
    await kernel.interaction.startSession(
      { requestId: newId('req'), mode: 'NEW', prompt: prompt() },
      context,
    );
    await kernel.idle();
    const ids = runIds(kernel);
    const submit = (n: number) => {
      const unitRun = `agr_abcdef/round-1/${String(n)}`;
      const path = `${unitRun}#1`;
      const request: SubmitUnitRequest = {
        requestId: pathDerivedId('req', path),
        ...ids,
        agentRunId: newId('agr'),
        unitRunId: pathDerivedId('unr', unitRun),
        path,
        unitRef: { kind: 'UNIT', id: 'file-read', version: 'v1.0.0', digest: 'a'.repeat(64) },
        input: { path: 'a.ts' },
        display: { toolName: 'read_file', argsSummary: 'a.ts' },
      };
      return kernel.gateway.submitUnit(request, context);
    };
    await submit(1);
    await submit(2);
    await kernel.idle();
    const reports = kernel.workflowEvents.flatMap((event) =>
      event.event.type === 'UnitReport' ? [event.event] : [],
    );
    expect(reports.map((report) => report.status)).toEqual(['REJECTED', 'FAILED']);
  });

  it('closes a run with RunClosed then RunFinished, after the open Turn', async () => {
    const { kernel } = setup();
    await kernel.interaction.startSession(
      { requestId: newId('req'), mode: 'NEW', prompt: prompt() },
      context,
    );
    await kernel.idle();
    await kernel.gateway.closeRun(
      { requestId: newId('req'), ...runIds(kernel), outcome: 'COMPLETED' },
      context,
    );
    await kernel.idle();
    expect(runEvents(kernel).slice(-2)).toEqual(['InputSettled', 'RunClosed']);
    expect(uiEvents(kernel).at(-1)).toBe('RunFinished');
  });

  it('accepts only analyze as a template', async () => {
    const { kernel } = setup();
    const goal = prompt();
    expect(
      await kernel.interaction.startRun(
        { requestId: newId('req'), template: { id: 'research', version: 'v1.0.0' }, goal },
        context,
      ),
    ).toMatchObject({ reasonCode: 'TEMPLATE_UNSUPPORTED' });
    await kernel.interaction.startRun(
      { requestId: newId('req'), template: { id: 'analyze', version: 'v1.0.0' }, goal },
      context,
    );
    await kernel.idle();
    expect(kernel.workflowEvents.some((e) => e.event.type === 'RunStart')).toBe(true);
  });
});

describe('fake Session Workflow through the system sequence', () => {
  it('lists active Sessions and deletes closed ones', async () => {
    const { kernel, workflow } = setup();
    await kernel.interaction.startSession(
      { requestId: newId('req'), mode: 'NEW', prompt: prompt() },
      context,
    );
    await kernel.idle();
    const { sessionId, workflowRunId } = runIds(kernel);
    const open = await kernel.interaction.deleteSession(
      { requestId: newId('req'), sessionId },
      context,
    );
    expect(open).toMatchObject({ reasonCode: 'SESSION_IN_USE' });
    await kernel.gateway.closeRun(
      { requestId: newId('req'), sessionId, workflowRunId, outcome: 'COMPLETED' },
      context,
    );
    await kernel.interaction.listSessions({ requestId: newId('req') }, context);
    await kernel.idle();
    expect(kernel.interactionEvents.at(-1)?.event).toMatchObject({
      type: 'SessionList',
      sessions: [{ sessionId }],
    });
    await kernel.interaction.deleteSession({ requestId: newId('req'), sessionId }, context);
    await kernel.idle();
    expect(workflow.sessions[0]?.status).toBe('DELETED');
    expect(kernel.interactionEvents.at(-1)?.event).toMatchObject({
      type: 'SessionDeleted',
      outcome: 'DELETED',
    });
  });

  it('opens a known Session without an initial input', async () => {
    const { kernel } = setup();
    await kernel.interaction.startSession(
      { requestId: newId('req'), mode: 'NEW', prompt: prompt() },
      context,
    );
    await kernel.idle();
    const { sessionId } = runIds(kernel);
    await kernel.interaction.openSession({ requestId: newId('req'), sessionId }, context);
    await kernel.idle();
    expect(kernel.workflowEvents.at(-1)?.event).toMatchObject({
      type: 'RunStart',
      initialInput: false,
    });
    expect(
      await kernel.interaction.openSession(
        { requestId: newId('req'), sessionId: newId('ses') },
        context,
      ),
    ).toMatchObject({ reasonCode: 'SESSION_NOT_FOUND' });
  });
});
