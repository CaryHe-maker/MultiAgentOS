import {
  InteractionInboxEventSchema,
  MEDIA_TYPES,
  RunSummarySchema,
  WorkflowInboxEventSchema,
  assertValid,
  newId,
  pathDerivedId,
  type ArtifactRef,
  type EndAgentRunRequest,
  type RunSummary,
  type RegisterAgentRunRequest,
  type SubmitUnitRequest,
  type UnitDefinition,
} from '@multiagentos/contracts';
import {
  testArtifactRef,
  testFileReadOutput,
  testUnitDefinition,
} from '@multiagentos/contracts/test-support';
import { describe, expect, it, vi } from 'vitest';
import { TestExecution, testPinnedAgent, testRunWork } from '../test-support/run-work.js';
import { SessionActor } from './session-actor.js';
import { KernelOutbox, type ToInteraction, type ToWorkflow } from './session-outbox.js';
import type { PinnedAgent } from './run-attempts.js';
import type { CommandSupport, ProjectFileRead, RunWorkDeps } from './run-work.js';
import { RunLedgers, minShare } from '../monitor/index.js';
import { testAgentBudget } from '../test-support/run-work.js';

const sessionId = newId('ses');
const fileRead = testUnitDefinition('FILE_READ');
const publish = testUnitDefinition('MESSAGE_PUBLISH');
const refOf = (unit: UnitDefinition) =>
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
  options: {
    preset?: 'standard' | 'readonly';
    file?: ProjectFileRead;
    trusted?: string[];
    command?: CommandSupport;
    interrupted?: () => void;
    memoryLevel?: () => 'WARNING' | 'DANGER' | undefined;
    /** Which Agent a registration pins; by default the one given. */
    pin?: (request: RegisterAgentRunRequest) => PinnedAgent;
    /** More of RunWork's own wiring, for the delegation cases. */
    runWork?: Partial<RunWorkDeps>;
    /** The actor's own limits, for the pause and Turn timeouts. */
    actor?: Partial<ConstructorParameters<typeof SessionActor>[0]>;
  } = {},
) {
  const trusted = new Set<string>(options.trusted ?? []);
  const toWorkflow: ToWorkflow[] = [];
  const toInteraction: ToInteraction[] = [];
  const faults: unknown[] = [];
  const summaries: RunSummary[] = [];
  const execution = new TestExecution();
  let now = 0;
  const timers: { delayMs: number; due: () => void }[] = [];
  /** What the actor itself armed: the Turn clock and the pause limit. */
  const actorTimers: { delayMs: number; due: () => void }[] = [];
  const outbox = new KernelOutbox(
    {
      toWorkflow: (event) => {
        toWorkflow.push(
          'workflowRunId' in event ? assertValid(WorkflowInboxEventSchema, event) : event,
        );
        return Promise.resolve();
      },
      toInteraction: (event) => {
        toInteraction.push(
          'workflowRunId' in event ? assertValid(InteractionInboxEventSchema, event) : event,
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
          pauseExecutions: execution.pauseExecutions,
          resumeExecutions: execution.resumeExecutions,
          abortExecutions: execution.abortExecutions,
          pinAgent: (request) =>
            Promise.resolve({ ok: true, agent: options.pin?.(request) ?? agent }),
          preset: options.preset ?? 'standard',
          ...(options.command === undefined ? {} : { command: options.command }),
          ...(options.memoryLevel === undefined ? {} : { memoryLevel: options.memoryLevel }),
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
          ...options.runWork,
        }),
      writeRunSummary: (summary) => {
        summaries.push(assertValid(RunSummarySchema, summary));
        return Promise.resolve(testArtifactRef(MEDIA_TYPES.runSummary, 'e'));
      },
      discardSession: () => Promise.resolve(),
    },
    onClosed: () => undefined,
    admission: () => undefined,
    onFatal: (error) => faults.push(error),
    now: () => now,
    schedule: (delayMs, due) => {
      const timer = { delayMs, due };
      actorTimers.push(timer);
      return () => {
        const index = actorTimers.indexOf(timer);
        if (index >= 0) actorTimers.splice(index, 1);
      };
    },
    ...options.actor,
    ...(options.interrupted === undefined ? {} : { onInterrupted: options.interrupted }),
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
  const register = async (
    id = agentRunId,
    requestedCapabilities: RegisterAgentRunRequest['requestedCapabilities'] = [
      'repo.read',
      'workspace.write',
    ],
  ) => {
    currentAgentRun = id;
    const request: RegisterAgentRunRequest = {
      ...inRun,
      requestId: newId('req'),
      agentRunId: id,
      nodeId: pathDerivedId('nod', 'main'),
      agentRef: { kind: 'AGENT', id: 'main', version: 'v1.0.0', digest: 'd'.repeat(64) },
      effort: 'high',
      workspaceViewId: 'main',
      requestedCapabilities,
      writeRoots: ['.'],
      display: { label: 'main' },
    };
    return actor.call(() => run().work.registerAgentRun(request));
  };
  let submissions = 0;
  const unitRequest = (unit: UnitDefinition, input: unknown): SubmitUnitRequest => {
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
    } as SubmitUnitRequest;
  };
  const submit = (unit: UnitDefinition = fileRead, input: unknown = { path: 'a.ts' }) => {
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
  const answer = (
    scope: 'ALLOW' | 'ONCE' | 'COMMAND' | 'PREFIX' | 'DENY',
    questionId = question(),
  ) =>
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
  const questions = () =>
    toInteraction.flatMap((entry) =>
      entry.event.type === 'AuthorizationRequest' ? [entry.event] : [],
    );
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
    questions,
    toWorkflow,
    summaries,
    settled,
    faults,
    timers,
    actorTimers,
    toInteraction,
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

describe('a write', () => {
  const fileWrite = testUnitDefinition('FILE_WRITE');
  const writer = testPinnedAgent({ units: [fileRead, fileWrite, publish] });
  const write = (path: string) => ({ path, content: 'new text', expectAbsent: true });
  const refusals = (kernel: Awaited<ReturnType<typeof setup>>) =>
    kernel.reports().flatMap((report) => (report.status === 'REJECTED' ? [report.reasonCode] : []));

  it('asks once for the write root, runs in a workspace scope, and does not ask again', async () => {
    const kernel = await setup(writer);
    await kernel.register();
    await kernel.submit(fileWrite, write('src/a.ts'));
    await kernel.settled();
    expect(kernel.questions()).toMatchObject([
      { capability: 'workspace.write', writeRoot: '.', critical: false },
    ]);
    expect(kernel.execution.started).toEqual([]);
    await kernel.submit(fileWrite, write('src/b.ts'));
    await kernel.settled();
    expect(kernel.questions()).toHaveLength(1);

    await kernel.answer('ALLOW');
    await kernel.settled();
    expect(kernel.execution.started).toHaveLength(2);
    expect(kernel.execution.started[0]?.spec.scope).toMatchObject({
      kind: 'WORKSPACE',
      repositoryRoot: '/repository',
      writableRoots: ['.'],
      exclusions: expect.arrayContaining(['**/.env*']) as string[],
    });
    await kernel.submit(fileWrite, write('src/c.ts'));
    await kernel.settled();
    expect(kernel.execution.started).toHaveLength(3);
    expect(kernel.questions()).toHaveLength(1);
  });

  it.each([
    ['../outside.txt', 'WRITE_OUT_OF_SCOPE'],
    ['.git/config', 'PROTECTED_PATH'],
    ['.env', 'PROTECTED_PATH'],
  ])('refuses %s without asking', async (path, reasonCode) => {
    const kernel = await setup(writer);
    await kernel.register();
    await kernel.submit(fileWrite, write(path));
    await kernel.settled();
    expect(kernel.questions()).toEqual([]);
    expect(refusals(kernel)).toEqual([reasonCode]);
    expect(kernel.faults).toEqual([]);
  });

  it('asks for each AGENTS.md alone with its content, whatever was granted', async () => {
    const kernel = await setup(writer);
    await kernel.register();
    await kernel.submit(fileWrite, write('src/a.ts'));
    await kernel.answer('ALLOW');
    await kernel.submit(fileWrite, write('AGENTS.md'));
    await kernel.submit(fileWrite, write('pkg/AGENTS.md'));
    await kernel.settled();
    const critical = kernel.questions().slice(1);
    expect(critical).toMatchObject([
      { path: 'AGENTS.md', critical: true },
      { path: 'pkg/AGENTS.md', critical: true },
    ]);
    expect(kernel.execution.started).toHaveLength(1);

    await kernel.answer('ONCE', critical[0]?.questionId);
    await kernel.settled();
    expect(kernel.execution.started).toHaveLength(2);
    await kernel.finish(1);
    await kernel.submit(fileWrite, write('AGENTS.md'));
    await kernel.settled();
    expect(kernel.questions()).toHaveLength(4);
  });

  it('a critical question takes only ONCE or DENY, and an ordinary one not ONCE', async () => {
    const kernel = await setup(writer);
    await kernel.register();
    await kernel.submit(fileWrite, write('AGENTS.md'));
    await kernel.settled();
    expect(await kernel.answer('ALLOW')).toMatchObject({ reasonCode: 'INVALID_INPUT' });
    expect(kernel.execution.started).toEqual([]);
    await kernel.answer('DENY');
    await kernel.settled();
    expect(refusals(kernel)).toEqual(['USER_DECLINED']);

    await kernel.submit(fileWrite, write('src/a.ts'));
    await kernel.settled();
    expect(await kernel.answer('ONCE')).toMatchObject({ reasonCode: 'INVALID_INPUT' });
  });

  it('a refused AGENTS.md leaves ordinary writes to their own question', async () => {
    const kernel = await setup(writer);
    await kernel.register();
    await kernel.submit(fileWrite, write('AGENTS.md'));
    await kernel.answer('DENY');
    await kernel.submit(fileWrite, write('src/a.ts'));
    await kernel.settled();
    expect(kernel.questions().at(-1)).toMatchObject({ writeRoot: '.' });
  });

  it('a refused write binds this AgentRun, and the next may ask again', async () => {
    const kernel = await setup(writer);
    await kernel.register();
    await kernel.submit(fileWrite, write('src/a.ts'));
    await kernel.answer('DENY');
    await kernel.submit(fileWrite, write('src/b.ts'));
    await kernel.settled();
    expect(kernel.questions()).toHaveLength(1);
    expect(refusals(kernel)).toEqual(['USER_DECLINED', 'USER_DECLINED']);

    await kernel.actor.call(() =>
      kernel.run().work.endAgentRun({
        ...kernel.inRun,
        requestId: newId('req'),
        agentRunId: kernel.agentRunId,
      }),
    );
    await kernel.register(newId('agr'));
    await kernel.submit(fileWrite, write('src/c.ts'));
    await kernel.settled();
    expect(kernel.questions()).toHaveLength(2);
  });

  it('readonly refuses to register a run that wants to write', async () => {
    const kernel = await setup(writer, { preset: 'readonly' });
    expect(await kernel.register()).toMatchObject({ reasonCode: 'CAPABILITY_NOT_SUBSET' });
  });

  it('refuses a capability the Agent does not have', async () => {
    const kernel = await setup(testPinnedAgent({ capabilities: ['repo.read'] }));
    expect(await kernel.register()).toMatchObject({ reasonCode: 'CAPABILITY_NOT_SUBSET' });
  });

  it('refuses a Unit beyond what the run asked for, without asking', async () => {
    const kernel = await setup(writer);
    await kernel.register(undefined, ['repo.read']);
    await kernel.submit(fileWrite, write('src/a.ts'));
    await kernel.settled();
    expect(kernel.questions()).toEqual([]);
    expect(refusals(kernel)).toEqual(['CAPABILITY_NOT_GRANTED']);
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
    const submit = (body: SubmitUnitRequest) =>
      kernel.actor.call(() => kernel.run().work.submitUnit(body));
    await submit(request);
    expect(await submit(request)).toMatchObject({ outcome: 'ACCEPTED' });
    expect(kernel.execution.started).toHaveLength(1);
    expect(
      await submit({
        ...request,
        input: { ...replyInput, agentLabel: 'other' },
      } as SubmitUnitRequest),
    ).toMatchObject({ reasonCode: 'REQUEST_CONFLICT' });
  });

  it('allows one active AgentRun, and ends it once', async () => {
    const kernel = await setup();
    await kernel.register();
    expect(await kernel.register()).toMatchObject({ reasonCode: 'AGENT_RUN_EXISTS' });
    const end: EndAgentRunRequest = {
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

  it('writes a RunSummary that counts every accepted Unit once', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit();
    await kernel.answer('ALLOW');
    await kernel.finish();
    await kernel.submit();
    await kernel.actor.call(() =>
      kernel.actor.closeRun(kernel.run(), { closeReason: 'CANCELLED' }),
    );
    // The open attempt settles without a report; only then does the run close.
    await kernel.finish();
    await kernel.settled();
    const [summary] = kernel.summaries;
    expect(summary).toMatchObject({
      closeReason: 'CANCELLED',
      turns: 1,
      units: { submitted: 2, ok: 1, rejected: 0, failed: 0, notDelivered: 1 },
      agentRuns: [{ agentRunId: kernel.agentRunId, rounds: 0, finalCallUsed: false }],
    });
    expect(summary?.agentRuns[0]?.endedAt).toBeUndefined();
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

describe('a command', () => {
  const commandUnit = testUnitDefinition('COMMAND');
  const caps = ['repo.read', 'workspace.write', 'command.exec', 'command.network'] as const;
  const runner = testPinnedAgent({
    units: [fileRead, commandUnit, publish],
    capabilities: [...caps],
  });
  const support = (over: Partial<CommandSupport> = {}): CommandSupport => ({
    analyze: (text) => ({
      text,
      subcommands: text.split(' && ').map((part) => ({
        text: part,
        words: part.split(' '),
        prefix: part.split(' ').slice(0, 2).join(' '),
      })),
      unreusable: [],
      ...(text.startsWith('git push') ? { critical: 'git push' } : {}),
      ...(text.startsWith('rm -rf') ? { denied: 'rm -rf' } : {}),
    }),
    sandbox: () => 'AVAILABLE',
    unavailablePolicy: 'deny',
    homeReadOnly: ['/home/me/.nvm'],
    homeMaskedFiles: [],
    scan: () =>
      Promise.resolve({ maskedFiles: ['.env'], maskedDirs: [], protectedExisting: ['.git'] }),
    ...over,
  });
  const input = (command: string) => ({ command, workdir: '', timeoutMs: 1000, network: false });
  const commandQuestions = (kernel: Awaited<ReturnType<typeof setup>>) =>
    kernel.questions().filter((q) => q.capability === 'command.exec');

  it('asks, shows exactly what runs, and starts in a sandbox scope after the answer', async () => {
    const kernel = await setup(runner, { command: support() });
    await kernel.register(undefined, [...caps]);
    await kernel.submit(commandUnit, input('npm test'));
    await kernel.settled();
    expect(commandQuestions(kernel)).toMatchObject([
      {
        command: 'npm test',
        writableRoots: ['.'],
        network: false,
        critical: false,
        options: ['ONCE', 'COMMAND', 'PREFIX', 'DENY'],
      },
    ]);
    await kernel.answer('ONCE');
    await kernel.settled();
    const scope = kernel.execution.started.at(-1)?.spec.scope;
    expect(scope).toMatchObject({
      kind: 'SANDBOX',
      backend: 'BWRAP',
      profile: {
        repositoryRoot: '/repository',
        writableRoots: ['.'],
        network: false,
        maskedFiles: ['.env'],
        protectedExisting: ['.git'],
      },
    });
    expect(scope?.kind === 'SANDBOX' && scope.approvalDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('lets a prefix answer cover the next command without asking', async () => {
    const kernel = await setup(runner, { command: support() });
    await kernel.register(undefined, [...caps]);
    await kernel.submit(commandUnit, input('npm run build'));
    await kernel.settled();
    await kernel.answer('PREFIX');
    await kernel.settled();
    await kernel.submit(commandUnit, input('npm run lint'));
    await kernel.settled();
    expect(commandQuestions(kernel)).toHaveLength(1);
    expect(kernel.execution.started).toHaveLength(2);
  });

  it('refuses a denied command without asking', async () => {
    const kernel = await setup(runner, { command: support() });
    await kernel.register(undefined, [...caps]);
    await kernel.submit(commandUnit, input('rm -rf /'));
    await kernel.settled();
    expect(kernel.questions()).toEqual([]);
    expect(kernel.reports()).toMatchObject([{ status: 'REJECTED', reasonCode: 'COMMAND_DENIED' }]);
  });

  it('asks a critical command every time and takes only ONCE or DENY', async () => {
    const kernel = await setup(runner, { command: support() });
    await kernel.register(undefined, [...caps]);
    await kernel.submit(commandUnit, input('git push'));
    await kernel.settled();
    expect(commandQuestions(kernel).at(-1)).toMatchObject({
      critical: true,
      options: ['ONCE', 'DENY'],
    });
    expect(await kernel.answer('PREFIX')).toMatchObject({
      outcome: 'REJECTED',
      reasonCode: 'INVALID_INPUT',
    });
    await kernel.answer('ONCE');
    await kernel.settled();
    await kernel.submit(commandUnit, input('git push'));
    await kernel.settled();
    expect(commandQuestions(kernel)).toHaveLength(2);
  });

  it('refuses without a sandbox when the policy is deny, and asks about it when it is not', async () => {
    const none = await setup(runner, { command: support({ sandbox: () => 'UNAVAILABLE' }) });
    await none.register(undefined, [...caps]);
    await none.submit(commandUnit, input('ls'));
    await none.settled();
    expect(none.reports()).toMatchObject([
      { status: 'REJECTED', reasonCode: 'SANDBOX_UNAVAILABLE' },
    ]);
    const asking = await setup(runner, {
      command: support({ sandbox: () => 'UNAVAILABLE', unavailablePolicy: 'ask-unisolated' }),
    });
    await asking.register(undefined, [...caps]);
    await asking.submit(commandUnit, input('ls'));
    await asking.settled();
    expect(commandQuestions(asking).at(-1)).toMatchObject({ unisolated: true, critical: true });
    await asking.answer('ONCE');
    await asking.settled();
    expect(asking.execution.started.at(-1)?.spec.scope).toMatchObject({ backend: 'UNISOLATED' });
  });

  it('refuses a command when the agent has no command capability', async () => {
    const kernel = await setup(runner, { command: support() });
    await kernel.register(undefined, ['repo.read']);
    await kernel.submit(commandUnit, input('ls'));
    await kernel.settled();
    expect(kernel.reports()).toMatchObject([
      { status: 'REJECTED', reasonCode: 'CAPABILITY_NOT_GRANTED' },
    ]);
  });
});

describe('the web tools (Kernel/Core 5f)', () => {
  const searchUnit = testUnitDefinition('WEB_SEARCH', { protectedCapabilities: ['web.search'] });
  const fetchUnit = testUnitDefinition('WEB_FETCH', { protectedCapabilities: ['web.fetch'] });
  const caps = ['repo.read', 'web.search', 'web.fetch'] as const;
  const agent = testPinnedAgent({
    units: [fileRead, searchUnit, fetchUnit, publish],
    capabilities: [...caps],
  });
  const options = {
    runWork: { web: { deniedDomains: ['blocked.example'], searchProvider: 'deepseek' } },
  };
  const webQuestions = (kernel: Awaited<ReturnType<typeof setup>>) =>
    kernel.questions().filter((q) => q.capability === 'web.search' || q.capability === 'web.fetch');

  it('asks a search once per run, names the queries and who receives them, and runs without a scope', async () => {
    const kernel = await setup(agent, options);
    await kernel.register(undefined, [...caps]);
    await kernel.submit(searchUnit, { queries: ['vitest mock timers'] });
    await kernel.settled();
    expect(webQuestions(kernel)).toMatchObject([
      { capability: 'web.search', queries: ['vitest mock timers'], provider: 'deepseek' },
    ]);
    await kernel.answer('ALLOW');
    await kernel.settled();
    expect(kernel.execution.started.at(-1)?.spec.scope).toEqual({ kind: 'NONE' });
    await kernel.submit(searchUnit, { queries: ['another'] });
    await kernel.settled();
    expect(webQuestions(kernel)).toHaveLength(1);
    expect(kernel.execution.started).toHaveLength(2);
  });

  it('asks a fetch once for each host', async () => {
    const kernel = await setup(agent, options);
    await kernel.register(undefined, [...caps]);
    await kernel.submit(fetchUnit, { url: 'https://Docs.Example.com/a' });
    await kernel.settled();
    expect(webQuestions(kernel)).toMatchObject([
      { capability: 'web.fetch', host: 'docs.example.com', url: 'https://Docs.Example.com/a' },
    ]);
    await kernel.answer('ALLOW');
    await kernel.settled();
    await kernel.submit(fetchUnit, { url: 'https://docs.example.com/b' });
    await kernel.settled();
    expect(webQuestions(kernel)).toHaveLength(1);
    await kernel.submit(fetchUnit, { url: 'https://other.example.org/' });
    await kernel.settled();
    expect(webQuestions(kernel)).toHaveLength(2);
  });

  it('refuses an address into a private network and a denied domain, without asking and without a run', async () => {
    const kernel = await setup(agent, options);
    await kernel.register(undefined, [...caps]);
    for (const url of [
      'http://127.0.0.1:8080/',
      'http://169.254.169.254/',
      'https://a.blocked.example/x',
    ])
      await kernel.submit(fetchUnit, { url });
    await kernel.settled();
    expect(kernel.questions()).toEqual([]);
    expect(kernel.execution.started).toHaveLength(0);
    expect(kernel.reports()).toMatchObject([
      { status: 'REJECTED', reasonCode: 'ADDRESS_FORBIDDEN' },
      { status: 'REJECTED', reasonCode: 'ADDRESS_FORBIDDEN' },
      { status: 'REJECTED', reasonCode: 'DOMAIN_DENIED' },
    ]);
  });

  it('binds a refusal to the host: it is not asked again, other hosts are', async () => {
    const kernel = await setup(agent, options);
    await kernel.register(undefined, [...caps]);
    await kernel.submit(fetchUnit, { url: 'https://bad.example.net/' });
    await kernel.settled();
    await kernel.answer('DENY');
    await kernel.settled();
    await kernel.submit(fetchUnit, { url: 'https://bad.example.net/other' });
    await kernel.settled();
    expect(webQuestions(kernel)).toHaveLength(1);
    await kernel.submit(fetchUnit, { url: 'https://fine.example.net/' });
    await kernel.settled();
    expect(webQuestions(kernel)).toHaveLength(2);
    expect(kernel.reports()).toMatchObject([
      { status: 'REJECTED', reasonCode: 'USER_DECLINED' },
      { status: 'REJECTED', reasonCode: 'USER_DECLINED' },
    ]);
  });

  it('refuses a web tool the Agent has no capability for', async () => {
    const kernel = await setup(agent, options);
    await kernel.register(undefined, ['repo.read']);
    await kernel.submit(searchUnit, { queries: ['q'] });
    await kernel.settled();
    expect(kernel.reports()).toMatchObject([
      { status: 'REJECTED', reasonCode: 'CAPABILITY_NOT_GRANTED' },
    ]);
  });
});

describe('memory pressure', () => {
  it('WARNING refuses the next AgentRun and the tools of the running one', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.actor.memoryPressure('WARNING');
    await kernel.submit();
    await kernel.settled();
    expect(kernel.reports()).toMatchObject([
      { status: 'REJECTED', reasonCode: 'QUOTA_EXHAUSTED', quota: 'MEMORY' },
    ]);
    expect(await kernel.register(newId('agr'))).toMatchObject({
      outcome: 'REJECTED',
      reasonCode: 'MEMORY_PRESSURE',
    });
  });

  it('lets work in again once the live level says the pressure is gone', async () => {
    let level: 'WARNING' | undefined;
    const kernel = await setup(undefined, { memoryLevel: () => level });
    await kernel.register();
    level = 'WARNING';
    await kernel.actor.memoryPressure('WARNING');
    await kernel.submit();
    await kernel.settled();
    expect(kernel.reports()).toMatchObject([
      { status: 'REJECTED', reasonCode: 'QUOTA_EXHAUSTED', quota: 'MEMORY' },
    ]);
    level = undefined;
    await kernel.submit();
    await kernel.settled();
    // Not refused for memory again: the unit went on to ask the user.
    expect(kernel.reports()).toHaveLength(1);
    expect(kernel.interactionTypes()).toContain('AuthorizationRequest');
  });

  it('refuses a new AgentRun while this process is short, and takes it once the level has fallen', async () => {
    let level: 'DANGER' | undefined = 'DANGER';
    const kernel = await setup(undefined, { memoryLevel: () => level });
    expect(await kernel.register()).toMatchObject({
      outcome: 'REJECTED',
      reasonCode: 'MEMORY_PRESSURE',
    });
    level = undefined;
    expect(await kernel.register(newId('agr'))).toMatchObject({ outcome: 'ACCEPTED' });
  });

  describe('DANGER', () => {
    const interrupt = async (interrupted = vi.fn()) => {
      const kernel = await setup(
        testPinnedAgent({ units: [fileRead, publish], maxToolUnits: 10 }),
        { interrupted },
      );
      await kernel.register();
      // A question is open and nothing runs, so the run can drain once it is told to close.
      await kernel.submit();
      await kernel.settled();
      await kernel.actor.memoryPressure('DANGER');
      await kernel.settled();
      return { kernel, interrupted };
    };
    const types = (kernel: Awaited<ReturnType<typeof setup>>) =>
      kernel.toWorkflow.map((entry) => entry.event.type);

    it('tells Workflow first and keeps the run open for the one reply that says why', async () => {
      const { kernel } = await interrupt();
      expect(types(kernel)).toContain('RunInterrupted');
      expect(types(kernel)).not.toContain('RunClosed');
      expect(kernel.summaries).toEqual([]);
      expect(kernel.execution.aborts).toBeGreaterThan(0);
    });

    it('lets nothing but the closing reply in, whatever the AgentRun asks', async () => {
      const { kernel } = await interrupt();
      const before = kernel.execution.started.length;
      expect(await kernel.submit()).toMatchObject({
        outcome: 'REJECTED',
        reasonCode: 'MEMORY_PRESSURE',
      });
      // The reply that says why is the one thing that still goes in.
      await kernel.submit(publish, replyInput);
      await kernel.settled();
      expect(kernel.execution.started.length).toBe(before + 1);
      expect(await kernel.register(newId('agr'))).toMatchObject({ reasonCode: 'MEMORY_PRESSURE' });
    });

    it('closes as INTERRUPTED when Workflow says so, and only then asks the system to leave', async () => {
      const { kernel, interrupted } = await interrupt();
      expect(interrupted).not.toHaveBeenCalled();
      await kernel.actor.call(() =>
        kernel.actor.closeRun(kernel.run(), { closeReason: 'INTERRUPTED' }),
      );
      await kernel.settled();
      expect(kernel.summaries.at(-1)?.closeReason).toBe('INTERRUPTED');
      expect(types(kernel).indexOf('RunInterrupted')).toBeLessThan(
        types(kernel).indexOf('RunClosed'),
      );
      expect(interrupted).toHaveBeenCalledTimes(1);
    });

    it('closes the run itself when Workflow does not, after the backstop', async () => {
      const { kernel, interrupted } = await interrupt();
      const backstop = kernel.timers.find((timer) => timer.delayMs === 30_000);
      expect(backstop).toBeDefined();
      backstop?.due();
      await kernel.settled();
      expect(kernel.summaries.at(-1)?.closeReason).toBe('INTERRUPTED');
      expect(interrupted).toHaveBeenCalledTimes(1);
    });
  });
});

describe('SubAgents (M2Design 3.6, 6.4, 7.3)', () => {
  const fileWrite = testUnitDefinition('FILE_WRITE');
  const childBudget = {
    perCallInputLimit: 40,
    maxOutputTokens: 20,
    finalInputBudget: 30,
    finalMaxOutputTokens: 10,
  };
  const defaultShare = minShare(childBudget) * 2;
  /** main may spawn and write; a worker writes; an explorer only reads. */
  const mainAgent = testPinnedAgent({
    id: 'main',
    capabilities: ['repo.read', 'workspace.write', 'agent.spawn'],
    units: [fileRead, fileWrite, publish],
  });
  const workerAgent = testPinnedAgent({
    id: 'worker',
    capabilities: ['repo.read', 'workspace.write'],
    units: [fileRead, fileWrite, publish],
    budget: childBudget,
  });
  const explorerAgent = testPinnedAgent({
    id: 'explorer',
    capabilities: ['repo.read'],
    units: [fileRead, publish],
    budget: childBudget,
  });
  const agents: Record<string, PinnedAgent> = {
    main: mainAgent,
    worker: workerAgent,
    explorer: explorerAgent,
  };
  const ref = (id: string) => ({
    kind: 'AGENT' as const,
    id,
    version: 'v1.0.0',
    digest: 'd'.repeat(64),
  });
  const runWork: Partial<RunWorkDeps> = {
    ledgers: new RunLedgers(
      {
        runTokenLimit: minShare(testAgentBudget) * 40,
        turnTokenLimit: minShare(testAgentBudget) * 20,
      },
      testAgentBudget,
    ),
    agentShare: (agentRef) => {
      const agent = agents[agentRef.id];
      return agent === undefined
        ? { ok: false, reasonCode: 'DEFINITION_UNAVAILABLE' }
        : {
            ok: true,
            defaultShare: agent.id === 'main' ? undefined : defaultShare,
            budget: agent.budget,
          };
    },
  };
  const open = async (over: { budgetTurns?: number } = {}) => {
    const kernel = await setup(mainAgent, {
      pin: (request) => agents[request.agentRef.id] ?? mainAgent,
      runWork:
        over.budgetTurns === undefined
          ? {
              ...runWork,
              ledgers: new RunLedgers(
                {
                  runTokenLimit: minShare(testAgentBudget) * 40,
                  turnTokenLimit: minShare(testAgentBudget) * 20,
                },
                testAgentBudget,
              ),
            }
          : runWork,
    });
    await kernel.register(kernel.agentRunId, ['repo.read', 'workspace.write', 'agent.spawn']);
    return kernel;
  };
  type Kernel = Awaited<ReturnType<typeof open>>;

  const reserve = (
    kernel: Kernel,
    tasks: { name: string; agent: string; roots?: string[]; tokens?: number }[],
    parent = kernel.agentRunId,
  ) =>
    kernel.actor.call(() =>
      kernel.run().work.reserveDelegation({
        ...kernel.inRun,
        requestId: newId('req'),
        parentAgentRunId: parent,
        tasks: tasks.map((task) => ({
          name: task.name,
          agentRef: ref(task.agent),
          writeRoots: task.roots ?? [],
          ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
        })),
      }),
    );
  const registerChild = (
    kernel: Kernel,
    over: {
      id: string;
      agent: string;
      delegationId: string;
      taskName: string;
      roots?: string[];
      capabilities?: RegisterAgentRunRequest['requestedCapabilities'];
      parent?: string;
    },
  ) =>
    kernel.actor.call(() =>
      kernel.run().work.registerAgentRun({
        ...kernel.inRun,
        requestId: newId('req'),
        agentRunId: over.id,
        nodeId: pathDerivedId('nod', over.id),
        agentRef: ref(over.agent),
        effort: 'high',
        workspaceViewId: 'main',
        requestedCapabilities:
          over.capabilities ??
          (over.agent === 'explorer' ? ['repo.read'] : ['repo.read', 'workspace.write']),
        writeRoots: over.roots ?? [],
        display: { label: over.id },
        parentAgentRunId: over.parent ?? kernel.agentRunId,
        delegationId: over.delegationId,
        taskName: over.taskName,
      }),
    );
  const reasonOf = (response: unknown) =>
    (response as { reasonCode?: string }).reasonCode ?? (response as { outcome: string }).outcome;
  const delegationIdOf = (response: unknown) => (response as { delegationId: string }).delegationId;

  it('reserves the shares of the tasks and says what each got, kept within the Agent limits (B2 in part)', async () => {
    const kernel = await open();
    const response = await reserve(kernel, [
      { name: 'a', agent: 'worker', roots: ['src/a'] },
      { name: 'b', agent: 'worker', roots: ['src/b'], tokens: 1 },
      { name: 'c', agent: 'explorer', tokens: 10_000_000 },
    ]);
    expect(response).toMatchObject({
      outcome: 'ACCEPTED',
      shares: [
        { name: 'a', tokens: defaultShare },
        { name: 'b', tokens: minShare(childBudget), clamped: 'MIN' },
        { name: 'c', tokens: 2 * defaultShare, clamped: 'MAX' },
      ],
    });
    expect(delegationIdOf(response)).toMatch(/^dlg_/u);
  });

  it('refuses all of it when the shares are more than the parent can lend, and says how much it can (B2)', async () => {
    const kernel = await open();
    const response = await reserve(kernel, [{ name: 'a', agent: 'explorer', tokens: 1 }]);
    expect(response).toMatchObject({ outcome: 'ACCEPTED' });
    // Far more than the Turn holds.
    const refused = await reserve(
      kernel,
      Array.from({ length: 12 }, (_, index) => ({
        name: `t${String(index)}`,
        agent: 'explorer',
        tokens: 2 * defaultShare,
      })),
    );
    expect(refused).toMatchObject({
      outcome: 'REJECTED',
      reasonCode: 'BUDGET_INSUFFICIENT',
      delegable: expect.any(Number) as number,
    });
  });

  it('is only for an AgentRun with agent.spawn, a known parent and tasks of known Agents', async () => {
    const kernel = await setup(mainAgent, {
      pin: (request) => agents[request.agentRef.id] ?? mainAgent,
      runWork,
    });
    // main registered without agent.spawn in its ceiling.
    await kernel.register(kernel.agentRunId, ['repo.read', 'workspace.write']);
    expect(reasonOf(await reserve(kernel, [{ name: 'a', agent: 'explorer' }]))).toBe('FORBIDDEN');
    const spawner = await open();
    expect(reasonOf(await reserve(spawner, [{ name: 'a', agent: 'explorer' }], newId('agr')))).toBe(
      'AGENT_RUN_NOT_FOUND',
    );
    expect(reasonOf(await reserve(spawner, [{ name: 'a', agent: 'nobody' }]))).toBe(
      'DEFINITION_UNAVAILABLE',
    );
    expect(reasonOf(await reserve(spawner, [{ name: 'a', agent: 'main' }]))).toBe('FORBIDDEN');
    expect(
      reasonOf(await reserve(spawner, [{ name: 'a', agent: 'worker', roots: ['../outside'] }])),
    ).toBe('INVALID_INPUT');
    expect(
      reasonOf(
        await reserve(spawner, [
          { name: 'a', agent: 'explorer' },
          { name: 'a', agent: 'explorer' },
        ]),
      ),
    ).toBe('INVALID_INPUT');
  });

  it('registers a SubAgent for its task, and only for its task', async () => {
    const kernel = await open();
    const dlg = delegationIdOf(
      await reserve(kernel, [
        { name: 'a', agent: 'worker', roots: ['src/a'] },
        { name: 'b', agent: 'explorer' },
      ]),
    );
    const worker = { id: newId('agr'), agent: 'worker', delegationId: dlg, taskName: 'a' };
    expect(reasonOf(await registerChild(kernel, { ...worker, roots: ['src/a'] }))).toBe('ACCEPTED');
    // A task is taken once.
    expect(
      reasonOf(await registerChild(kernel, { ...worker, id: newId('agr'), roots: ['src/a'] })),
    ).toBe('DELEGATION_NOT_FOUND');
    // Not named in the delegation.
    expect(
      reasonOf(await registerChild(kernel, { ...worker, id: newId('agr'), taskName: 'zzz' })),
    ).toBe('DELEGATION_NOT_FOUND');
    // Its parent must exist and be running.
    expect(
      reasonOf(await registerChild(kernel, { ...worker, id: newId('agr'), parent: newId('agr') })),
    ).toBe('AGENT_RUN_NOT_FOUND');
    // The three fields go together.
    const partial = await kernel.actor.call(() =>
      kernel.run().work.registerAgentRun({
        ...kernel.inRun,
        requestId: newId('req'),
        agentRunId: newId('agr'),
        nodeId: pathDerivedId('nod', 'x'),
        agentRef: ref('explorer'),
        effort: 'high',
        workspaceViewId: 'main',
        requestedCapabilities: ['repo.read'],
        writeRoots: [],
        display: { label: 'x' },
        parentAgentRunId: kernel.agentRunId,
      }),
    );
    expect(reasonOf(partial)).toBe('INVALID_INPUT');
  });

  it('gives a SubAgent no more than its parent has, no agent.spawn, and no roots beyond its task (P5)', async () => {
    const kernel = await open();
    const dlg = delegationIdOf(
      await reserve(kernel, [
        { name: 'w', agent: 'worker', roots: ['src/w'] },
        { name: 'e', agent: 'explorer' },
      ]),
    );
    const child = (name: string, agent: string) => ({
      id: newId('agr'),
      agent,
      delegationId: dlg,
      taskName: name,
    });
    expect(reasonOf(await registerChild(kernel, { ...child('w', 'worker'), roots: ['src'] }))).toBe(
      'CAPABILITY_NOT_SUBSET',
    );
    expect(
      reasonOf(
        await registerChild(kernel, {
          ...child('e', 'explorer'),
          capabilities: ['repo.read', 'agent.spawn'],
        }),
      ),
    ).toBe('CAPABILITY_NOT_SUBSET');
    expect(
      reasonOf(
        await registerChild(kernel, {
          ...child('e', 'explorer'),
          capabilities: ['repo.read', 'command.exec'],
        }),
      ),
    ).toBe('CAPABILITY_NOT_SUBSET');
  });

  it('refuses a second AgentRun whose write roots touch a running one (P5)', async () => {
    const kernel = await open();
    const dlg = delegationIdOf(
      await reserve(kernel, [
        { name: 'a', agent: 'worker', roots: ['src'] },
        { name: 'b', agent: 'worker', roots: ['src/b'] },
        { name: 'c', agent: 'worker', roots: ['docs'] },
      ]),
    );
    const first = { id: newId('agr'), agent: 'worker', delegationId: dlg };
    expect(reasonOf(await registerChild(kernel, { ...first, taskName: 'a', roots: ['src'] }))).toBe(
      'ACCEPTED',
    );
    expect(
      reasonOf(
        await registerChild(kernel, {
          ...first,
          id: newId('agr'),
          taskName: 'b',
          roots: ['src/b'],
        }),
      ),
    ).toBe('WRITE_SCOPE_CONFLICT');
    expect(
      reasonOf(
        await registerChild(kernel, { ...first, id: newId('agr'), taskName: 'c', roots: ['docs'] }),
      ),
    ).toBe('ACCEPTED');
  });

  it('refuses the parent a write while its children hold the roots, and lets it write again after (P6)', async () => {
    const kernel = await open();
    const dlg = delegationIdOf(
      await reserve(kernel, [{ name: 'a', agent: 'worker', roots: ['src'] }]),
    );
    const childId = newId('agr');
    await registerChild(kernel, {
      id: childId,
      agent: 'worker',
      delegationId: dlg,
      taskName: 'a',
      roots: ['src'],
    });
    await kernel.submit(fileWrite, { path: 'src/a.ts', content: 'x' });
    await kernel.settled();
    expect(kernel.reports().at(-1)).toMatchObject({
      status: 'REJECTED',
      reasonCode: 'WRITE_SCOPE_DELEGATED',
    });
    expect(kernel.execution.started).toHaveLength(0);
    // The child ends, the unused task is given up: the roots are the parent's again.
    await kernel.actor.call(() =>
      kernel
        .run()
        .work.endAgentRun({ ...kernel.inRun, requestId: newId('req'), agentRunId: childId }),
    );
    await kernel.actor.call(() =>
      kernel
        .run()
        .work.releaseDelegation({ ...kernel.inRun, requestId: newId('req'), delegationId: dlg }),
    );
    const before = kernel.reports().length;
    await kernel.submit(fileWrite, { path: 'src/a.ts', content: 'x' });
    await kernel.settled();
    // Not refused again: it went on to ask the user to allow the write.
    expect(kernel.reports()).toHaveLength(before);
    expect(kernel.interactionTypes()).toContain('AuthorizationRequest');
  });

  it('keeps the parent from registering a second top-level AgentRun while main is active', async () => {
    const kernel = await open();
    expect(reasonOf(await kernel.register(newId('agr')))).toBe('AGENT_RUN_ACTIVE');
  });

  it('answers a repeated or unknown release, and a repeated reservation, as the same request', async () => {
    const kernel = await open();
    const dlg = delegationIdOf(await reserve(kernel, [{ name: 'a', agent: 'explorer' }]));
    const release = {
      ...kernel.inRun,
      requestId: newId('req'),
      delegationId: dlg,
    };
    const first = await kernel.actor.call(() => kernel.run().work.releaseDelegation(release));
    const again = await kernel.actor.call(() => kernel.run().work.releaseDelegation(release));
    expect(again).toEqual(first);
    expect(
      reasonOf(
        await kernel.actor.call(() =>
          kernel.run().work.releaseDelegation({
            ...kernel.inRun,
            requestId: newId('req'),
            delegationId: 'dlg_unknown00000',
          }),
        ),
      ),
    ).toBe('DELEGATION_NOT_FOUND');
  });
});

describe('run control of Kernel/Core 5e', () => {
  type Kernel = Awaited<ReturnType<typeof setup>>;
  const toWorkflowTypes = (kernel: Kernel) => kernel.toWorkflow.map((entry) => entry.event.type);
  const states = (kernel: Kernel) =>
    kernel.toInteraction.flatMap((entry) =>
      entry.event.type === 'RunStateChanged' ? [entry.event.state] : [],
    );
  const eventsOf = <T extends string>(kernel: Kernel, type: T) =>
    kernel.toWorkflow.flatMap((entry) => (entry.event.type === type ? [entry.event] : []));
  const pause = async (kernel: Kernel) => {
    const decision = await kernel.actor.call(() => kernel.actor.pauseRun(kernel.run()));
    await kernel.settled();
    return decision;
  };
  const drain = async (kernel: Kernel) => {
    kernel.execution.onDrained?.();
    await kernel.settled();
  };
  const prompt = (kernel: Kernel, humanRequestId = 'hrq_prompt00000001') =>
    kernel.actor.call(() => kernel.actor.requestOpenInput(kernel.run(), humanRequestId));
  const asked = (kernel: Kernel, asker: string, humanRequestId = 'hrq_question00001') =>
    kernel.actor.call(() =>
      kernel.actor.requestLocalQuestion(kernel.run(), {
        ...kernel.inRun,
        humanRequestId,
        nodeId: 'nod_question00001',
        kind: 'ask',
        attachedAgentRunId: asker,
        question: 'which one?',
      }),
    );

  it('pauses: Execution is told, and the run is paused when it has drained', async () => {
    const kernel = await setup();
    await kernel.register();
    expect(await pause(kernel)).toMatchObject({ accepted: true });
    expect(kernel.execution.pauses).toBe(1);
    expect(kernel.run().control.phase).toBe('PAUSING');
    expect(states(kernel)).toContain('PAUSING');
    expect(toWorkflowTypes(kernel)).not.toContain('RunPaused');
    await drain(kernel);
    expect(kernel.run().control.phase).toBe('PAUSED');
    expect(toWorkflowTypes(kernel)).toContain('RunPaused');
    expect(states(kernel)).toContain('PAUSED');
    expect(await pause(kernel)).toMatchObject({ accepted: false, reasonCode: 'REQUEST_CONFLICT' });
  });

  it('resumes, with or without a note, and tells Workflow', async () => {
    const kernel = await setup();
    await kernel.register();
    await pause(kernel);
    await drain(kernel);
    const note = { inputId: newId('inp'), text: 'use the other way' };
    expect(
      await kernel.actor.call(() => kernel.actor.resumeRun(kernel.run(), { input: note })),
    ).toMatchObject({ accepted: true });
    await kernel.settled();
    expect(kernel.execution.resumes).toBe(1);
    expect(kernel.run().control.phase).toBe('RUNNING');
    expect(eventsOf(kernel, 'RunResumed')[0]).toMatchObject({
      steer: { inputId: note.inputId },
    });
    expect(await kernel.actor.call(() => kernel.actor.resumeRun(kernel.run()))).toMatchObject({
      accepted: false,
      reasonCode: 'REQUEST_CONFLICT',
    });
  });

  it('refuses a note for an AgentRun that is not there', async () => {
    const kernel = await setup();
    await kernel.register();
    await pause(kernel);
    await drain(kernel);
    expect(
      await kernel.actor.call(() =>
        kernel.actor.resumeRun(kernel.run(), {
          input: { inputId: newId('inp'), text: 'x' },
          targetAgentRunId: 'agr_nobody',
        }),
      ),
    ).toMatchObject({ accepted: false, reasonCode: 'AGENT_RUN_NOT_FOUND' });
    expect(kernel.run().control.phase).toBe('PAUSED');
  });

  it('takes a steer while running, and not once paused', async () => {
    const kernel = await setup();
    await kernel.register();
    const input = { inputId: newId('inp'), text: 'look at b.ts too' };
    expect(
      await kernel.actor.call(() => kernel.actor.steerRun(kernel.run(), input, kernel.agentRunId)),
    ).toMatchObject({ accepted: true });
    await kernel.settled();
    expect(eventsOf(kernel, 'HumanAnswered').at(-1)).toMatchObject({
      kind: 'steer',
      inputId: input.inputId,
      targetAgentRunId: kernel.agentRunId,
    });
    expect(
      await kernel.actor.call(() => kernel.actor.steerRun(kernel.run(), input, 'agr_nobody')),
    ).toMatchObject({ accepted: false, reasonCode: 'AGENT_RUN_NOT_FOUND' });
    await pause(kernel);
    expect(await kernel.actor.call(() => kernel.actor.steerRun(kernel.run(), input))).toMatchObject(
      { accepted: false, reasonCode: 'REQUEST_CONFLICT' },
    );
  });

  it('interrupts for the user: asks cancelled, work aborted, and the Turn ends ABORTED with the run open', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.submit();
    await kernel.settled();
    expect(kernel.interactionTypes()).toContain('AuthorizationRequest');
    expect(
      await kernel.actor.call(() => kernel.actor.interrupt(kernel.run(), 'USER_ABORT')),
    ).toMatchObject({ accepted: true });
    await kernel.settled();
    expect(kernel.run().control.phase).toBe('INTERRUPTING');
    expect(kernel.execution.aborts).toBe(1);
    expect(eventsOf(kernel, 'RunInterrupted')[0]).toMatchObject({ reason: 'USER_ABORT' });
    expect(states(kernel)).toContain('INTERRUPTING');
    expect(kernel.interactionTypes()).toContain('AuthorizationResolved');
    // Not a memory problem: the Units that are refused are blocked, nothing more is said.
    expect(await kernel.submit()).toMatchObject({ reasonCode: 'RUN_BLOCKED' });
    expect(await kernel.register(newId('agr'))).toMatchObject({ reasonCode: 'RUN_BLOCKED' });
    // Workflow ends the AgentRun and asks for the next input: the Turn ends ABORTED.
    await kernel.actor.call(() => kernel.actor.endAgentRun(kernel.run(), kernel.agentRunId));
    expect(await prompt(kernel)).toMatchObject({ accepted: true });
    await kernel.settled();
    expect(kernel.run().control.phase).toBe('AWAITING_INPUT');
    expect(eventsOf(kernel, 'TurnClosed')[0]).toMatchObject({ reason: 'ABORTED' });
    expect(eventsOf(kernel, 'RunClosed')).toEqual([]);
  });

  it('closes an interrupted run itself when Workflow does not answer in time', async () => {
    const kernel = await setup();
    await kernel.register();
    await kernel.actor.call(() => kernel.actor.interrupt(kernel.run(), 'USER_ABORT'));
    await kernel.settled();
    const backstop = kernel.timers.at(-1);
    expect(backstop).toBeDefined();
    backstop?.due();
    await kernel.settled();
    expect(kernel.summaries.at(-1)?.closeReason).toBe('INTERRUPTED');
  });

  it('interrupts a paused run, but not one that waits for input', async () => {
    const kernel = await setup();
    await kernel.register();
    await pause(kernel);
    await drain(kernel);
    expect(
      await kernel.actor.call(() => kernel.actor.interrupt(kernel.run(), 'USER_ABORT')),
    ).toMatchObject({ accepted: true });
    await kernel.settled();
    await kernel.actor.call(() => kernel.actor.endAgentRun(kernel.run(), kernel.agentRunId));
    await prompt(kernel);
    expect(
      await kernel.actor.call(() => kernel.actor.interrupt(kernel.run(), 'USER_ABORT')),
    ).toMatchObject({ accepted: false, reasonCode: 'REQUEST_CONFLICT' });
  });

  it('interrupts a paused run when the pause lasts too long', async () => {
    const kernel = await setup(undefined, {
      actor: { timeouts: { turnMs: 60_000, orchestrationMs: 60_000, pauseMs: 5_000 } },
    });
    await kernel.register();
    await pause(kernel);
    await drain(kernel);
    const limit = kernel.actorTimers.find((timer) => timer.delayMs === 5_000);
    expect(limit).toBeDefined();
    limit?.due();
    await kernel.settled();
    expect(eventsOf(kernel, 'RunInterrupted')[0]).toMatchObject({ reason: 'PAUSE_TIMEOUT' });
  });

  it('forgets the pause limit once the run is continued', async () => {
    const kernel = await setup(undefined, {
      actor: { timeouts: { turnMs: 60_000, orchestrationMs: 60_000, pauseMs: 5_000 } },
    });
    await kernel.register();
    await pause(kernel);
    await drain(kernel);
    await kernel.actor.call(() => kernel.actor.resumeRun(kernel.run()));
    await kernel.settled();
    expect(kernel.actorTimers.some((timer) => timer.delayMs === 5_000)).toBe(false);
  });

  it('times a Turn out, without counting a pause', async () => {
    const kernel = await setup(undefined, {
      actor: { timeouts: { turnMs: 10_000, orchestrationMs: 60_000, pauseMs: 60_000 } },
    });
    await kernel.register();
    // A model call is out, so the run is working: the clock runs.
    await kernel.submit();
    await kernel.answer('ALLOW');
    await kernel.settled();
    const clock = kernel.actorTimers.find((timer) => timer.delayMs <= 10_000);
    expect(clock).toBeDefined();
    kernel.advance(4_000);
    await pause(kernel);
    await drain(kernel);
    // Paused: the clock stopped, so no timer is armed for it.
    expect(kernel.actorTimers.some((timer) => timer.delayMs < 60_000)).toBe(false);
    kernel.advance(60_000);
    await kernel.actor.call(() => kernel.actor.resumeRun(kernel.run()));
    await kernel.settled();
    const rest = kernel.actorTimers.find((timer) => timer.delayMs <= 6_000);
    expect(rest).toBeDefined();
    kernel.advance(6_000);
    rest?.due();
    await kernel.settled();
    expect(eventsOf(kernel, 'RunInterrupted')[0]).toMatchObject({ reason: 'TURN_TIMEOUT' });
    // Execution answers what it was running with INTERRUPTED; here the stand-in does it.
    for (const { unitAttemptId } of kernel.execution.started)
      await kernel.actor.call(() =>
        kernel.run().work.attempts.interruptUnsent(unitAttemptId, 'ABORTED'),
      );
    await kernel.actor.call(() => kernel.actor.endAgentRun(kernel.run(), kernel.agentRunId));
    await prompt(kernel);
    await kernel.settled();
    expect(eventsOf(kernel, 'TurnClosed')[0]).toMatchObject({ reason: 'TIMEOUT' });
  });

  it('does not count the time the whole run waits for the user', async () => {
    const kernel = await setup(undefined, {
      actor: { timeouts: { turnMs: 10_000, orchestrationMs: 60_000, pauseMs: 60_000 } },
    });
    await kernel.register();
    // A question to the user is open and nothing runs.
    await kernel.submit();
    await kernel.settled();
    expect(kernel.interactionTypes()).toContain('AuthorizationRequest');
    expect(kernel.actorTimers.some((timer) => timer.delayMs <= 10_000)).toBe(false);
  });

  it('asks a local question without ending the Turn, and delivers the answer to Workflow', async () => {
    const kernel = await setup();
    await kernel.register();
    expect(await asked(kernel, kernel.agentRunId)).toMatchObject({ accepted: true });
    await kernel.settled();
    expect(kernel.run().control.phase).toBe('RUNNING');
    expect(kernel.toInteraction.at(-2)?.event).toMatchObject({
      type: 'ActivityEvent',
      phase: 'AWAITING_ANSWER',
    });
    const request = kernel.toInteraction.find((entry) => entry.event.type === 'HumanRequest');
    expect(request?.event).toMatchObject({
      kind: 'ask',
      attachedAgentRunId: kernel.agentRunId,
      question: 'which one?',
    });
    const answer = { inputId: newId('inp'), text: 'the first' };
    expect(
      await kernel.actor.call(() =>
        kernel.actor.answerHuman(kernel.run(), 'hrq_question00001', answer),
      ),
    ).toMatchObject({ accepted: true });
    await kernel.settled();
    expect(eventsOf(kernel, 'HumanAnswered').at(-1)).toMatchObject({
      kind: 'ask',
      origin: 'requested',
      humanRequestId: 'hrq_question00001',
      inputId: answer.inputId,
    });
    expect(kernel.interactionTypes()).toContain('HumanResolved');
    expect(
      await kernel.actor.call(() =>
        kernel.actor.answerHuman(kernel.run(), 'hrq_question00001', answer),
      ),
    ).toMatchObject({ accepted: false });
  });

  it('refuses a local question from an AgentRun that is not active', async () => {
    const kernel = await setup();
    await kernel.register();
    expect(await asked(kernel, 'agr_nobody0000001')).toMatchObject({
      accepted: false,
      reasonCode: 'AGENT_RUN_NOT_FOUND',
    });
  });

  it('cancels the local questions when the run is interrupted', async () => {
    const kernel = await setup();
    await kernel.register();
    await asked(kernel, kernel.agentRunId);
    await kernel.actor.call(() => kernel.actor.interrupt(kernel.run(), 'USER_ABORT'));
    await kernel.settled();
    expect(eventsOf(kernel, 'HumanCancelled')[0]).toMatchObject({
      humanRequestId: 'hrq_question00001',
      nodeId: 'nod_question00001',
      reason: 'USER_ABORT',
    });
    expect(
      kernel.toInteraction.some(
        (entry) => entry.event.type === 'HumanResolved' && entry.event.resolution === 'CANCELLED',
      ),
    ).toBe(true);
  });
});
