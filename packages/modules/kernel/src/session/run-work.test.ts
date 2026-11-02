import {
  InteractionInboxEventV1Schema,
  WorkflowInboxEventV1Schema,
  assertValid,
  newId,
  pathDerivedId,
  type ArtifactRef,
  type EndAgentRunRequestV1,
  type RegisterAgentRunRequestV1,
  type SubmitUnitRequestV1,
  type UnitDefinitionV1,
} from '@multiagentos/contracts';
import {
  testArtifactRef,
  testFileReadOutput,
  testUnitDefinition,
} from '@multiagentos/contracts/test-support';
import { describe, expect, it } from 'vitest';
import { TestExecution, testPinnedAgent, testRunWork } from '../test-support/run-work.js';
import { SessionActor } from './session-actor.js';
import { KernelOutbox, type ToInteraction, type ToWorkflow } from './session-outbox.js';
import type { PinnedAgent } from './run-attempts.js';
import type { ProjectFileRead } from './run-work.js';

const sessionId = newId('ses');
const fileRead = testUnitDefinition('FILE_READ');
const publish = testUnitDefinition('MESSAGE_PUBLISH');
const refOf = (unit: UnitDefinitionV1) =>
  ({ kind: 'UNIT', id: unit.id, version: unit.version, digest: unit.digest }) as const;
const replyInput = {
  kind: 'DEGRADED_REPLY',
  agentLabel: 'main',
  reason: { code: 'BUDGET_EXHAUSTED' },
};

/**
 * The whole Kernel side of one Unit through the real Session actor: admission, authorization,
 * attempt and report. Only Execution is a stand-in, and every event must pass its Schema.
 */
async function setup(
  agent: PinnedAgent = testPinnedAgent(),
  options: { preset?: 'standard' | 'readonly'; file?: ProjectFileRead; trusted?: string[] } = {},
) {
  const trusted = new Set<string>(options.trusted ?? []);
  const toWorkflow: ToWorkflow[] = [];
  const toInteraction: ToInteraction[] = [];
  const faults: unknown[] = [];
  const execution = new TestExecution();
  let now = 0;
  const timers: { delayMs: number; due: () => void }[] = [];
  const outbox = new KernelOutbox(
    {
      toWorkflow: (event) => {
        toWorkflow.push(
          'workflowRunId' in event ? assertValid(WorkflowInboxEventV1Schema, event) : event,
        );
        return Promise.resolve();
      },
      toInteraction: (event) => {
        toInteraction.push(
          'workflowRunId' in event ? assertValid(InteractionInboxEventV1Schema, event) : event,
        );
        return Promise.resolve();
      },
    },
    (error) => faults.push(error),
    () => new Date('2026-11-02T00:00:00.000Z'),
  );
  const contentRef: ArtifactRef = testArtifactRef();
  const actor = new SessionActor({
    sessionId,
    repositoryRoot: '/repository',
    outbox,
    duties: {
      storeUserInput: () => Promise.resolve(contentRef),
      openRunWork: (host) =>
        testRunWork(host, {
          createAttempt: execution.createAttempt,
          cancelExecutions: execution.cancelExecutions,
          pinAgent: () => Promise.resolve({ ok: true, agent }),
          preset: options.preset ?? 'standard',
          readProjectFile: () => Promise.resolve(options.file ?? { exists: false }),
          isTrusted: (_path, sha256) => trusted.has(sha256),
          trust: (_path, sha256) => {
            trusted.add(sha256);
            return Promise.resolve();
          },
          now: () => new Date(now),
          schedule: (delayMs, due) => {
            const timer = { delayMs, due };
            timers.push(timer);
            return () => {
              timers.splice(timers.indexOf(timer), 1);
            };
          },
        }),
      writeRunSummary: () => Promise.resolve(undefined),
      discardSession: () => Promise.resolve(),
    },
    onClosed: () => undefined,
    admission: () => undefined,
    onFatal: (error) => faults.push(error),
  });
  const settled = async () => {
    await actor.idle();
    await outbox.drained();
  };
  actor.start({
    kind: 'NEW',
    requestId: newId('req'),
    input: { inputId: newId('inp'), text: 'hello' },
  });
  await settled();
  const command = toWorkflow[0]?.event;
  if (command?.type !== 'SessionCommand') throw new Error('no command');
  actor.reportCommand({
    requestId: newId('req'),
    sessionId,
    commandId: command.commandId,
    result: { command: 'CREATE', outcome: 'READY' },
  });
  await settled();
  const start = toWorkflow.find((event) => event.event.type === 'RunStart');
  if (start === undefined || !('workflowRunId' in start)) throw new Error('no run');
  const { workflowRunId } = start;
  const run = () => {
    const current = actor.run(workflowRunId);
    if (current === undefined) throw new Error('not current');
    return current;
  };
  const inRun = { requestId: newId('req'), sessionId, workflowRunId };
  const agentRunId = newId('agr');
  let currentAgentRun = agentRunId;
  const register = async (id = agentRunId) => {
    currentAgentRun = id;
    const request: RegisterAgentRunRequestV1 = {
      ...inRun,
      requestId: newId('req'),
      agentRunId: id,
      nodeId: pathDerivedId('nod', 'main'),
      agentRef: { kind: 'AGENT', id: 'main', version: 'v1.0.0', digest: 'd'.repeat(64) },
      effort: 'high',
      workspaceViewId: 'main',
      display: { label: 'main' },
    };
    return actor.call(() => run().work.registerAgentRun(request));
  };
  let submissions = 0;
  const unitRequest = (unit: UnitDefinitionV1, input: unknown): SubmitUnitRequestV1 => {
    submissions += 1;
    const unitPath = `${currentAgentRun}/round-1/${submissions}`;
    return {
      ...inRun,
      requestId: pathDerivedId('req', `${unitPath}#1`),
      agentRunId: currentAgentRun,
      unitRunId: pathDerivedId('unr', unitPath),
      path: `${unitPath}#1`,
      unitRef: refOf(unit),
      input,
      display: { toolName: 'read_file', argsSummary: '' },
    } as SubmitUnitRequestV1;
  };
  const submit = (unit: UnitDefinitionV1 = fileRead, input: unknown = { path: 'a.ts' }) => {
    const request = unitRequest(unit, input);
    return actor.call(() => run().work.submitUnit(request));
  };
  const question = () => {
    const asked = [...toInteraction]
      .reverse()
      .find((entry) => entry.event.type === 'AuthorizationRequest');
    if (asked?.event.type !== 'AuthorizationRequest') throw new Error('no question');
    return asked.event.questionId;
  };
  const answer = (scope: 'ALLOW' | 'DENY', questionId = question()) =>
    actor.call(() =>
      run().work.answerAuthorization({
        ...inRun,
        requestId: newId('req'),
        questionId,
        answer: { scope },
      }),
    );
  const finish = (index = execution.started.length - 1) => {
    const attempt = execution.started[index];
    if (attempt === undefined) throw new Error('no attempt');
    return actor.call(() => {
      run().work.attempts.registerExecution(attempt.unitAttemptId, `exe_test${index}`);
      run().work.attempts.submitResultCheck({
        unitAttemptId: attempt.unitAttemptId,
        executionId: `exe_test${index}`,
        outcome: 'COMPLETED',
        output: testFileReadOutput(),
        outputRef: testArtifactRef(),
      });
    });
  };
  const readFile = (path = 'AGENTS.md') =>
    actor.call(() => run().work.readProjectFile({ ...inRun, requestId: newId('req'), path }));
  const reports = () =>
    toWorkflow.flatMap((entry) => (entry.event.type === 'UnitReport' ? [entry.event] : []));
  const interactionTypes = () => toInteraction.map((entry) => entry.event.type);
  return {
    actor,
    execution,
    run,
    register,
    submit,
    unitRequest,
    answer,
    finish,
    question,
    readFile,
    trusted,
    reports,
    interactionTypes,
    toWorkflow,
    settled,
    faults,
    timers,
    inRun,
    agentRunId,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('one Unit through the Kernel', () => {
  it('asks, waits for the answer, runs and reports', async () => {
    const kernel = await setup();
    await kernel.register();
    expect(await kernel.submit()).toMatchObject({ outcome: 'ACCEPTED' });
    await kernel.settled();
    expect(kernel.interactionTypes()).toContain('AuthorizationRequest');
    expect(kernel.execution.started).toEqual([]);
    expect(kernel.reports()).toEqual([]);

    await kernel.answer('ALLOW');
    await kernel.settled();
    expect(kernel.execution.started[0]?.spec.scope).toMatchObject({
      kind: 'REPOSITORY',
      repositoryRoot: '/repository',
    });
    await kernel.finish();
    await kernel.settled();
    expect(kernel.reports()).toMatchObject([{ status: 'OK' }]);
    expect(kernel.faults).toEqual([]);
  });

  it('asks once for the whole run', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit();
    await kernel.submit();
    await kernel.answer('ALLOW');
    await kernel.submit();
    await kernel.settled();
    expect(kernel.execution.started).toHaveLength(3);
    expect(
      kernel.interactionTypes().filter((type) => type === 'AuthorizationRequest'),
    ).toHaveLength(1);
  });

  it('runs a Unit that needs no authorization at once', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit(publish, replyInput);
    await kernel.settled();
    expect(kernel.execution.started).toHaveLength(1);
    expect(kernel.interactionTypes()).not.toContain('AuthorizationRequest');
  });
});

describe('a refusal', () => {
  it('is a tool result that keeps the Turn open, and the same AgentRun never asks again', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit();
    await kernel.answer('DENY');
    await kernel.submit();
    await kernel.settled();
    expect(kernel.reports()).toMatchObject([
      { status: 'REJECTED', reasonCode: 'USER_DECLINED' },
      { status: 'REJECTED', reasonCode: 'USER_DECLINED' },
    ]);
    expect(kernel.run().control).toMatchObject({ phase: 'RUNNING' });
    expect(kernel.run().control.turnId).toBeDefined();
    expect(kernel.toWorkflow.map((entry) => entry.event.type)).not.toContain('TurnClosed');
    expect(
      kernel.interactionTypes().filter((type) => type === 'AuthorizationRequest'),
    ).toHaveLength(1);
  });
});

describe('the next AgentRun', () => {
  it('may ask again, so the user can change their mind in the next message', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit();
    await kernel.answer('DENY');
    await kernel.actor.call(() =>
      kernel.run().work.endAgentRun({
        ...kernel.inRun,
        requestId: newId('req'),
        agentRunId: kernel.agentRunId,
      }),
    );
    await kernel.register(newId('agr'));
    await kernel.submit();
    await kernel.settled();
    expect(
      kernel.interactionTypes().filter((type) => type === 'AuthorizationRequest'),
    ).toHaveLength(2);
  });
});

describe('waiting for the user', () => {
  it('has no timer: the Unit stays suspended however long it takes', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit();
    await kernel.settled();
    kernel.advance(24 * 60 * 60 * 1000);
    await kernel.settled();
    expect(kernel.timers).toEqual([]);
    expect(kernel.reports()).toEqual([]);
    await kernel.answer('ALLOW');
    await kernel.settled();
    expect(kernel.execution.started).toHaveLength(1);
  });

  it('stops the wall clock, and the limit applies to working time only', async () => {
    const kernel = await setup(testPinnedAgent({ maxWallClockMs: 1000 }));
    await kernel.register();
    await kernel.settled();
    expect(kernel.timers.map((timer) => timer.delayMs)).toEqual([1000]);
    kernel.advance(400);
    await kernel.submit();
    await kernel.settled();
    expect(kernel.timers).toEqual([]);
    kernel.advance(60 * 60 * 1000);
    await kernel.answer('ALLOW');
    await kernel.settled();
    expect(kernel.timers.map((timer) => timer.delayMs)).toEqual([600]);
  });

  it('stops the wall clock while a project file waits for trust', async () => {
    const ref = testArtifactRef();
    const kernel = await setup(testPinnedAgent({ maxWallClockMs: 1000 }), {
      file: { exists: true, ref, sha256: ref.sha256, text: 'x', truncated: false },
    });
    await kernel.register();
    await kernel.readFile();
    await kernel.settled();
    expect(kernel.timers).toEqual([]);
  });

  it('refuses tool Units once the wall clock ran out, but not the closing ones', async () => {
    const kernel = await setup(testPinnedAgent({ maxWallClockMs: 1000 }));
    await kernel.register();
    await kernel.settled();
    kernel.advance(1000);
    kernel.timers[0]?.due();
    await kernel.settled();
    await kernel.submit();
    await kernel.submit(publish, replyInput);
    await kernel.settled();
    expect(kernel.reports()).toMatchObject([
      { status: 'REJECTED', reasonCode: 'QUOTA_EXHAUSTED', quota: 'WALL_CLOCK' },
    ]);
    expect(kernel.execution.started).toHaveLength(1);
  });
});

describe('quotas and requests', () => {
  it('refuses the tool Unit past the limit without asking', async () => {
    const kernel = await setup(testPinnedAgent({ maxToolUnits: 1 }));
    await kernel.register();
    await kernel.submit();
    await kernel.answer('ALLOW');
    await kernel.submit();
    await kernel.settled();
    expect(kernel.reports()).toMatchObject([
      { status: 'REJECTED', reasonCode: 'QUOTA_EXHAUSTED', quota: 'TOOL_UNITS' },
    ]);
  });

  it('answers a repeated request once and refuses a conflicting one', async () => {
    const kernel = await setup();
    await kernel.register();
    const request = kernel.unitRequest(publish, replyInput);
    const submit = (body: SubmitUnitRequestV1) =>
      kernel.actor.call(() => kernel.run().work.submitUnit(body));
    await submit(request);
    expect(await submit(request)).toMatchObject({ outcome: 'ACCEPTED' });
    expect(kernel.execution.started).toHaveLength(1);
    expect(
      await submit({
        ...request,
        input: { ...replyInput, agentLabel: 'other' },
      } as SubmitUnitRequestV1),
    ).toMatchObject({ reasonCode: 'REQUEST_CONFLICT' });
  });

  it('allows one active AgentRun, and ends it once', async () => {
    const kernel = await setup();
    await kernel.register();
    expect(await kernel.register()).toMatchObject({ reasonCode: 'AGENT_RUN_EXISTS' });
    const end: EndAgentRunRequestV1 = {
      ...kernel.inRun,
      requestId: newId('req'),
      agentRunId: kernel.agentRunId,
    };
    await kernel.actor.call(() => kernel.run().work.endAgentRun(end));
    expect(kernel.run().control.activeAgentRuns.size).toBe(0);
    expect(
      await kernel.actor.call(() =>
        kernel.run().work.endAgentRun({ ...end, requestId: newId('req') }),
      ),
    ).toMatchObject({ reasonCode: 'AGENT_RUN_ENDED' });
    expect(await kernel.submit()).toMatchObject({ reasonCode: 'AGENT_RUN_ENDED' });
  });
});

describe('project instructions', () => {
  const ref = testArtifactRef();
  const agents: ProjectFileRead = {
    exists: true,
    ref,
    sha256: ref.sha256,
    text: 'be careful',
    truncated: false,
  };
  const noAgentRun = testPinnedAgent();

  it('asks for the repository, then for this content, and remembers the trust', async () => {
    const kernel = await setup(noAgentRun, { file: agents });
    const pending = await kernel.readFile();
    await kernel.settled();
    await kernel.answer('ALLOW');
    await kernel.settled();
    expect(kernel.interactionTypes().filter((t) => t === 'AuthorizationRequest')).toHaveLength(2);
    await kernel.answer('ALLOW');
    expect(await pending.response).toMatchObject({ trusted: true, exists: true });
    expect(kernel.trusted.has(ref.sha256)).toBe(true);
  });

  it('answers without asking for content it already trusts', async () => {
    const kernel = await setup(noAgentRun, { file: agents, trusted: [ref.sha256] });
    const pending = await kernel.readFile();
    await kernel.settled();
    await kernel.answer('ALLOW');
    expect(await pending.response).toMatchObject({ trusted: true });
    expect(kernel.interactionTypes().filter((t) => t === 'AuthorizationRequest')).toHaveLength(1);
  });

  it('does not ask under the readonly preset', async () => {
    const kernel = await setup(noAgentRun, { file: agents, preset: 'readonly' });
    const pending = await kernel.readFile();
    await kernel.settled();
    await kernel.answer('ALLOW');
    expect(await pending.response).toMatchObject({ trusted: false });
  });

  it('remembers a refusal of this content for the run, and grants nothing', async () => {
    const kernel = await setup(noAgentRun, { file: agents });
    const first = await kernel.readFile();
    await kernel.settled();
    await kernel.answer('ALLOW');
    await kernel.settled();
    await kernel.answer('DENY');
    expect(await first.response).toMatchObject({ trusted: false });
    expect(await (await kernel.readFile()).response).toMatchObject({ trusted: false });
    expect(kernel.trusted.size).toBe(0);
  });

  it('refuses the file when the repository was refused', async () => {
    const kernel = await setup(noAgentRun, { file: agents });
    const pending = await kernel.readFile();
    await kernel.settled();
    await kernel.answer('DENY');
    expect(await pending.response).toMatchObject({ reasonCode: 'USER_DECLINED' });
  });

  it('ends the request with the run', async () => {
    const kernel = await setup(noAgentRun, { file: agents });
    const pending = await kernel.readFile();
    await kernel.settled();
    await kernel.actor.call(() =>
      kernel.actor.closeRun(kernel.run(), { closeReason: 'CANCELLED' }),
    );
    expect(await pending.response).toMatchObject({
      reasonCode: 'RUN_BLOCKED',
      closeReason: 'CANCELLED',
    });
  });
});

describe('convergence', () => {
  it('cancels the question, and the suspended Unit ends with the run', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit();
    const questionId = kernel.question();
    await kernel.actor.call(() =>
      kernel.actor.closeRun(kernel.run(), { closeReason: 'CANCELLED' }),
    );
    await kernel.settled();
    expect(kernel.reports()).toEqual([]);
    expect(kernel.interactionTypes()).toContain('AuthorizationResolved');
    expect(kernel.toWorkflow.at(-1)?.event.type).toBe('RunClosed');
    expect(await kernel.answer('ALLOW', questionId)).toMatchObject({
      reasonCode: 'QUESTION_NOT_PENDING',
    });
  });

  it('waits for the attempt, settles it without delivering, and closes the Turn last', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit();
    await kernel.answer('ALLOW');
    await kernel.actor.call(() =>
      kernel.actor.closeRun(kernel.run(), { closeReason: 'CANCELLED' }),
    );
    await kernel.settled();
    expect(kernel.execution.cancels).toBe(1);
    const types = () => kernel.toWorkflow.map((entry) => entry.event.type);
    expect(types()).not.toContain('RunClosed');
    expect(await kernel.submit()).toMatchObject({
      reasonCode: 'RUN_BLOCKED',
      closeReason: 'CANCELLED',
    });
    await kernel.finish();
    await kernel.settled();
    expect(kernel.reports()).toEqual([]);
    expect(types().slice(-2)).toEqual(['TurnClosed', 'RunClosed']);
  });

  it('converges with VIOLATION when an attempt breaks its scope', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit();
    await kernel.answer('ALLOW');
    const attempt = kernel.execution.started[0];
    if (attempt === undefined) throw new Error('no attempt');
    await kernel.actor.call(() => {
      kernel.run().work.attempts.registerExecution(attempt.unitAttemptId, 'exe_test0');
      kernel.run().work.attempts.submitResultCheck({
        unitAttemptId: attempt.unitAttemptId,
        executionId: 'exe_test0',
        outcome: 'VIOLATION',
        reasonCode: 'PATH_ESCAPE',
      });
    });
    await kernel.settled();
    expect(kernel.toWorkflow.at(-1)?.event).toMatchObject({
      type: 'RunClosed',
      closeReason: 'VIOLATION',
      failure: { code: 'PATH_ESCAPE', source: 'KERNEL' },
    });
  });
});

describe('activity of a run', () => {
  it('tells the activity area about a tool Unit from authorization to its folded line', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit();
    await kernel.answer('ALLOW');
    await kernel.finish();
    await kernel.settled();
    const types = kernel.interactionTypes();
    expect(types).toContain('ActivityEvent');
    expect(types.indexOf('AuthorizationRequest')).toBeLessThan(types.lastIndexOf('ActivityEvent'));
  });
});
