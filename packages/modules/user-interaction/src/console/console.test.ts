import type {
  ArtifactRef,
  InteractionGatewayPortV1,
  KernelToInteractionEventV1,
} from '@multiagentos/contracts';
import { testArtifactRef } from '@multiagentos/contracts/test-support';
import { describe, expect, it } from 'vitest';
import { Console } from './console.js';
import type { LiveState, TranscriptRecord } from './console-view.js';

const SESSION = 'ses_01J00000000000000000000001';
const RUN = 'wfr_01J00000000000000000000001';

function setup(options: { artifacts?: Map<string, string>; clock?: { ms: number } } = {}) {
  const calls: { name: string; request: Record<string, unknown> }[] = [];
  const artifacts = options.artifacts ?? new Map<string, string>();
  const ack = { outcome: 'ACCEPTED' } as const;
  const record =
    (name: string, result: unknown = ack) =>
    (request: unknown) => {
      calls.push({ name, request: request as Record<string, unknown> });
      return Promise.resolve(result);
    };
  const accepted = { outcome: 'ACCEPTED', sessionId: SESSION };
  const gateway = {
    startSession: record('startSession', accepted),
    openSession: record('openSession', accepted),
    startRun: record('startRun', accepted),
    listSessions: record('listSessions'),
    deleteSession: record('deleteSession'),
    answerAuthorization: record('answerAuthorization'),
    answerHuman: record('answerHuman'),
    shutdown: record('shutdown'),
    readArtifact: (request: { ref: ArtifactRef }) => {
      calls.push({ name: 'readArtifact', request });
      const body = artifacts.get(request.ref.artifactId);
      return Promise.resolve(
        body === undefined
          ? { outcome: 'REJECTED', reasonCode: 'INVALID_ARTIFACT_REF' }
          : { outcome: 'ACCEPTED', text: body },
      );
    },
  } as unknown as InteractionGatewayPortV1;
  const printed: TranscriptRecord[] = [];
  const restored: string[][] = [];
  let live: LiveState | undefined;
  const clock = options.clock ?? { ms: 0 };
  const console = new Console({
    gateway,
    view: {
      print: (entry) => printed.push(entry),
      update: (state) => {
        live = state;
      },
      restoreInput: (messages) => restored.push([...messages]),
    },
    now: () => new Date(clock.ms),
  });
  let seq = 0;
  const event = (body: KernelToInteractionEventV1) =>
    console.handleRunEvent({
      eventId: `evt_${String(++seq)}`,
      sessionId: SESSION,
      workflowRunId: RUN,
      seq,
      occurredAt: new Date(0).toISOString(),
      event: body,
    });
  return {
    console,
    calls,
    printed,
    restored,
    live: () => live,
    event,
    named: (name: string) => calls.filter((call) => call.name === name),
  };
}

describe('Console', () => {
  it('starts a Session with the first prompt and queues what it sends while nothing waits', async () => {
    const t = setup();
    await t.console.submit('解释这个仓库');
    expect(t.named('startSession')).toHaveLength(1);
    expect(t.console.sessionId).toBe(SESSION);

    await t.event({ type: 'RunStateChanged', state: 'RUNNING' });
    await t.console.submit('再看看测试');
    expect(t.live()?.queued).toEqual(['再看看测试']);
    expect(t.named('answerHuman')).toHaveLength(0);

    // The next HumanRequest takes the oldest queued message.
    await t.event({ type: 'HumanRequest', humanRequestId: 'hrq_1', kind: 'prompt' });
    expect(t.named('answerHuman')[0]?.request).toMatchObject({
      humanRequestId: 'hrq_1',
      workflowRunId: RUN,
      input: { text: '再看看测试' },
    });
    expect(t.live()?.queued).toEqual([]);
  });

  it('answers an open HumanRequest with the next line', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event({ type: 'HumanRequest', humanRequestId: 'hrq_1', kind: 'prompt' });
    await t.console.submit('继续');
    expect(t.named('answerHuman')).toHaveLength(1);
    await t.console.submit('又一条');
    expect(t.named('answerHuman')).toHaveLength(1);
    expect(t.live()?.queued).toEqual(['又一条']);
  });

  it('asks pending authorizations one at a time and drops the ones Kernel resolved', async () => {
    const t = setup();
    await t.console.submit('hi');
    for (const questionId of ['qst_1', 'qst_2'])
      await t.event({
        type: 'AuthorizationRequest',
        questionId,
        capability: 'repo.read',
        repositoryPath: '/repo',
        exclusions: [],
        provider: 'deepseek',
      });
    expect(t.live()?.pending).toMatchObject({ questionId: 'qst_1' });
    expect(t.live()?.waiting).toBe(1);

    await t.console.submit('maybe');
    expect(t.named('answerAuthorization')).toHaveLength(0);
    await t.console.submit('n');
    expect(t.named('answerAuthorization')[0]?.request).toMatchObject({
      questionId: 'qst_1',
      answer: { scope: 'DENY' },
    });
    expect(t.live()?.pending).toMatchObject({ questionId: 'qst_2' });

    await t.event({ type: 'AuthorizationResolved', questionId: 'qst_2', resolution: 'CANCELLED' });
    expect(t.live()?.pending).toBeUndefined();
  });

  it('shows the instructions file it asks to trust', async () => {
    const ref = testArtifactRef('text/markdown', 'b');
    const t = setup({ artifacts: new Map([[ref.artifactId, '# Rules\u001b[31m']]) });
    await t.console.submit('hi');
    await t.event({
      type: 'AuthorizationRequest',
      questionId: 'qst_1',
      capability: 'project.instructions',
      path: 'AGENTS.md',
      contentRef: ref,
      truncated: false,
    });
    expect(t.live()?.pending?.text).toContain('# Rules\\u001b[31m');
  });

  it('prints replies, maps degraded replies to their reason', async () => {
    const reply = testArtifactRef('text/markdown', 'c');
    const degraded = testArtifactRef('application/json', 'd');
    const t = setup({
      artifacts: new Map([
        [reply.artifactId, '答案'],
        [degraded.artifactId, '{"reason":"TOOL_UNIT_LIMIT"}'],
      ]),
    });
    await t.console.submit('hi');
    await t.event({
      type: 'MessagePublished',
      kind: 'REPLY',
      agentLabel: 'main',
      messageRef: reply,
    });
    await t.event({
      type: 'MessagePublished',
      kind: 'DEGRADED_REPLY',
      agentLabel: 'main',
      messageRef: degraded,
    });
    expect(t.printed).toContainEqual({ kind: 'REPLY', agentLabel: 'main', text: '答案' });
    expect(t.printed).toContainEqual({
      kind: 'ERROR',
      text: '工具调用次数已到上限，没能完成回复。',
    });
  });

  it('tracks activity per AgentRun and clears it when the run waits', async () => {
    const t = setup();
    await t.console.submit('hi');
    for (const [state, ms] of [
      ['RUNNING', 0],
      ['DONE', 300],
    ] as const)
      await t.event({
        type: 'ActivityEvent',
        agentRunId: 'arn_1',
        label: 'main',
        phase: 'CALLING_TOOL',
        at: new Date(ms).toISOString(),
        unit: { unitAttemptId: 'uat_1', toolName: 'read-file', argsSummary: 'a.ts', state },
      });
    expect(t.live()?.activity).toHaveLength(1);
    expect(t.printed).toContainEqual({ kind: 'STEP', text: '✓ read-file a.ts 0.3s' });
    await t.event({
      type: 'ActivityEvent',
      agentRunId: 'arn_1',
      label: 'main',
      phase: 'RETRYING',
      at: new Date(0).toISOString(),
      retry: { attempt: 1, retryAt: new Date(5000).toISOString() },
    });
    expect(t.live()?.activity[0]?.retry).toEqual({
      attempt: 1,
      retryAt: new Date(5000).toISOString(),
    });
    await t.event({ type: 'RunStateChanged', state: 'AWAITING_INPUT' });
    expect(t.live()?.activity).toEqual([]);
  });

  it('gives queued messages back when the run ends and offers to continue after BUDGET', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event({ type: 'RunStateChanged', state: 'RUNNING' });
    await t.console.submit('排队的');
    await t.event({ type: 'RunFinished', closeReason: 'BUDGET' } as KernelToInteractionEventV1);
    expect(t.restored).toEqual([['排队的']]);
    expect(t.live()?.pending?.kind).toBe('CONTINUE');
    await t.console.submit('y');
    expect(t.named('openSession')).toHaveLength(1);
  });

  it('resolves `mas run` with the exit code of its outcome', async () => {
    const t = setup();
    const exit = t.console.run({ id: 'analyze', version: 'v0.1.0' }, '分析');
    await Promise.resolve();
    await t.event({ type: 'RunFinished', closeReason: 'VIOLATION' } as KernelToInteractionEventV1);
    await expect(exit).resolves.toBe(3);
  });

  it('resumes a listed Session by its number and exits on a second Ctrl+C in time', async () => {
    const clock = { ms: 0 };
    const t = setup({ clock });
    await t.console.handleSystemEvent({
      event: {
        type: 'SessionList',
        sessions: [{ sessionId: 'ses_2', title: 'a', turnCount: 2 }],
      },
    } as never);
    await t.console.submit('/resume 1');
    expect(t.named('openSession')[0]?.request).toMatchObject({ sessionId: 'ses_2' });

    const exited = t.console.exited();
    await t.console.interrupt();
    expect(t.live()?.hint).toBe('再按一次 Ctrl+C 退出');
    clock.ms = 3000;
    await t.console.interrupt();
    expect(t.named('shutdown')).toHaveLength(0);
    clock.ms = 4000;
    await t.console.interrupt();
    expect(t.named('shutdown')).toHaveLength(1);
    await exited;
  });
});
