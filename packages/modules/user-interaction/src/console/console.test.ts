import type {
  ArtifactRef,
  InteractionGatewayPort,
  KernelToInteractionEvent,
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
    pauseRun: record('pauseRun'),
    resumeRun: record('resumeRun'),
    interruptRun: record('interruptRun'),
    steerRun: record('steerRun'),
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
  } as unknown as InteractionGatewayPort;
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
  const event = (body: KernelToInteractionEvent) =>
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

  it('does not undo on an argument it does not know', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.console.submit('/undo 2');
    expect(t.printed).toContainEqual({ kind: 'NOTICE', text: '当前不能使用这条指令。' });
  });

  it('says so when a reply came from a Turn that ended early', async () => {
    const reply = testArtifactRef('text/markdown', 'c');
    const t = setup({ artifacts: new Map([[reply.artifactId, '做完了一半']]) });
    await t.console.submit('hi');
    await t.event({
      type: 'MessagePublished',
      kind: 'REPLY',
      agentLabel: 'main',
      messageRef: reply,
      wrapUpReason: 'CONTEXT_LIMIT',
    });
    expect(t.printed).toContainEqual({ kind: 'REPLY', agentLabel: 'main', text: '做完了一半' });
    expect(t.printed).toContainEqual({
      kind: 'NOTICE',
      text: '上下文已满，这一轮提前结束了；可以用 /new 开始新对话继续。',
    });
  });

  it('notes a truncated result and shows its full output on /output', async () => {
    const full = testArtifactRef('text/plain', 'e');
    const expired = testArtifactRef('text/plain', 'f');
    const t = setup({ artifacts: new Map([[full.artifactId, '全部输出']]) });
    await t.console.submit('hi');
    for (const [id, fullRef] of [
      ['uat_1', full],
      ['uat_2', expired],
    ] as const)
      await t.event({
        type: 'ActivityEvent',
        agentRunId: 'arn_1',
        label: 'main',
        phase: 'CALLING_TOOL',
        at: new Date(0).toISOString(),
        unit: { unitAttemptId: id, toolName: 'grep', argsSummary: 'x', state: 'DONE', fullRef },
      });
    expect(t.printed).toContainEqual({
      kind: 'STEP',
      text: '✓ grep x · 输出已截断（/output 1 查看完整输出）',
    });
    await t.console.submit('/output 1');
    expect(t.printed).toContainEqual({ kind: 'REPORT', text: '全部输出' });
    await t.console.submit('/output 2');
    expect(t.printed.at(-1)?.kind).toBe('ERROR');
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

  it('draws SubAgents under the AgentRun that started them, and lists the run on /timeline', async () => {
    const t = setup({ clock: { ms: 60_000 } });
    await t.console.submit('hi');
    const at = (ms: number) => new Date(ms).toISOString();
    const activity = (
      agentRunId: string,
      label: string,
      phase: 'THINKING' | 'WAITING_SUBTASKS' | 'ENDED',
      ms: number,
      parentAgentRunId?: string,
    ) =>
      t.event({
        type: 'ActivityEvent',
        agentRunId,
        ...(parentAgentRunId === undefined ? {} : { parentAgentRunId }),
        label,
        phase,
        at: at(ms),
      });
    await activity('arn_main', 'main', 'THINKING', 0);
    await activity('arn_main', 'main', 'WAITING_SUBTASKS', 1000);
    await activity('arn_a', 'explorer survey', 'THINKING', 2000, 'arn_main');
    await activity('arn_b', 'worker fix', 'THINKING', 2500, 'arn_main');
    await activity('arn_a', 'explorer survey', 'ENDED', 9000, 'arn_main');
    expect(t.live()?.activity.map((line) => [line.branch, line.label, line.phase])).toEqual([
      ['', 'main', '等待子任务'],
      ['  └─ ', 'worker fix', '思考中'],
    ]);
    await activity('arn_c', 'worker test', 'THINKING', 9500, 'arn_main');
    expect(t.live()?.activity.map((line) => line.branch)).toEqual(['', '  ├─ ', '  └─ ']);

    await t.console.submit('/timeline');
    expect(t.printed.at(-1)).toEqual({
      kind: 'NOTICE',
      text: [
        'main  00:00:00 → 进行中（60.0s）',
        '  explorer survey  00:00:02 → 00:00:09（7.0s）',
        '  worker fix  00:00:02 → 进行中（57.5s）',
        '  worker test  00:00:09 → 进行中（50.5s）',
      ].join('\n'),
    });
  });

  it('gives queued messages back when the run ends and offers to continue after BUDGET', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event({ type: 'RunStateChanged', state: 'RUNNING' });
    await t.console.submit('排队的');
    await t.event({ type: 'RunFinished', closeReason: 'BUDGET' } as KernelToInteractionEvent);
    expect(t.restored).toEqual([['排队的']]);
    expect(t.live()?.pending?.kind).toBe('CONTINUE');
    await t.console.submit('y');
    expect(t.named('openSession')).toHaveLength(1);
  });

  it('resolves `mas run` with the exit code of its outcome', async () => {
    const t = setup();
    const exit = t.console.run({ id: 'analyze', version: 'v0.1.0' }, '分析');
    await Promise.resolve();
    await t.event({ type: 'RunFinished', closeReason: 'VIOLATION' } as KernelToInteractionEvent);
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

describe('pause, continue, steer and questions (Module/UserInteraction 5.4)', () => {
  const running = async (t: ReturnType<typeof setup>) => {
    await t.console.submit('hi');
    await t.event({ type: 'RunStateChanged', state: 'RUNNING' });
  };
  const worker = (t: ReturnType<typeof setup>, label: string, agentRunId: string) =>
    t.event({
      type: 'ActivityEvent',
      agentRunId,
      label,
      phase: 'THINKING',
      at: new Date(0).toISOString(),
    });

  it('pauses a running run with Ctrl+C, aborts a paused one, and then leaves it alone', async () => {
    const t = setup();
    await running(t);
    await t.console.interrupt();
    expect(t.named('pauseRun')).toHaveLength(1);
    expect(t.named('interruptRun')).toHaveLength(0);
    await t.event({ type: 'RunStateChanged', state: 'PAUSING' });
    await t.console.interrupt();
    expect(t.named('interruptRun')).toHaveLength(1);
    await t.event({ type: 'RunStateChanged', state: 'INTERRUPTING' });
    await t.console.interrupt();
    expect(t.named('interruptRun')).toHaveLength(1);
    expect(t.named('shutdown')).toHaveLength(0);
  });

  it('says how to go on once paused, and goes on with /continue and a note for a named task', async () => {
    const t = setup();
    await running(t);
    await worker(t, 'worker fix-api', 'arn_w');
    await t.event({ type: 'RunStateChanged', state: 'PAUSED' });
    expect(t.live()?.hint).toContain('/continue');
    await t.console.submit('/continue @fix-api 用另一种实现');
    expect(t.named('resumeRun')[0]?.request).toMatchObject({
      steer: { input: { text: '用另一种实现' }, targetAgentRunId: 'arn_w' },
    });
    await t.event({ type: 'RunStateChanged', state: 'RUNNING' });
    expect(t.live()?.hint).toBeUndefined();
  });

  it('continues with a plain message while paused, and without a note when there is none', async () => {
    const t = setup();
    await running(t);
    await t.event({ type: 'RunStateChanged', state: 'PAUSED' });
    await t.console.submit('改用第二种');
    expect(t.named('resumeRun')[0]?.request).toMatchObject({
      steer: { input: { text: '改用第二种' } },
    });
    await t.event({ type: 'RunStateChanged', state: 'PAUSED' });
    await t.console.submit('/continue');
    expect(t.named('resumeRun')[1]?.request).not.toHaveProperty('steer');
    expect(t.named('steerRun')).toHaveLength(0);
  });

  it('refuses /continue unless paused, and /steer unless running', async () => {
    const t = setup();
    await running(t);
    await t.console.submit('/continue');
    expect(t.named('resumeRun')).toHaveLength(0);
    await t.event({ type: 'RunStateChanged', state: 'PAUSED' });
    await t.console.submit('/steer 看看 b');
    expect(t.named('steerRun')).toHaveLength(0);
  });

  it('slips a note into a running run without pausing, for main or for a named task', async () => {
    const t = setup();
    await running(t);
    await worker(t, 'worker fix-api', 'arn_w');
    await t.console.submit('/steer 也看 b.ts');
    await t.console.submit('/steer @fix-api 只改接口');
    expect(t.named('steerRun').map((call) => call.request)).toMatchObject([
      { input: { text: '也看 b.ts' } },
      { input: { text: '只改接口' }, targetAgentRunId: 'arn_w' },
    ]);
    expect(t.named('pauseRun')).toHaveLength(0);
    await t.console.steer('@nobody x');
    expect(t.named('steerRun')).toHaveLength(2);
    expect(t.printed.at(-1)).toMatchObject({
      kind: 'NOTICE',
    });
    expect((t.printed.at(-1) as { text: string }).text).toContain('@nobody');
  });

  it('does not guess when a name fits two tasks', async () => {
    const t = setup();
    await running(t);
    await worker(t, 'worker fix', 'arn_1');
    await worker(t, 'explorer fix', 'arn_2');
    await t.console.steer('@fix 小心');
    expect(t.named('steerRun')).toHaveLength(0);
  });

  it('keeps the activity tree while the run is held, so a note can still name its task', async () => {
    const t = setup();
    await running(t);
    await worker(t, 'worker fix', 'arn_1');
    await t.event({ type: 'RunStateChanged', state: 'PAUSING' });
    await t.event({ type: 'RunStateChanged', state: 'PAUSED' });
    expect(t.live()?.activity).toHaveLength(1);
    expect(t.live()?.status).toBe('已暂停');
  });

  it('gives queued messages back after an abort instead of sending them', async () => {
    const t = setup();
    await running(t);
    await t.console.submit('下一件事');
    await t.event({ type: 'RunStateChanged', state: 'INTERRUPTING' });
    await t.event({ type: 'RunStateChanged', state: 'AWAITING_INPUT' });
    await t.event({ type: 'HumanRequest', humanRequestId: 'hrq_1', kind: 'prompt' });
    expect(t.named('answerHuman')).toHaveLength(0);
    expect(t.restored).toEqual([['下一件事']]);
    expect(t.live()?.queued).toEqual([]);
  });

  it('asks a question with fields one after another, and answers with them as JSON', async () => {
    const t = setup();
    await running(t);
    await worker(t, 'main', 'arn_main');
    await t.event({
      type: 'HumanRequest',
      humanRequestId: 'hrq_q',
      kind: 'ask',
      attachedAgentRunId: 'arn_main',
      question: '用哪个库？',
      fields: [
        { name: 'lib', type: 'select', label: '库', options: ['a', 'b'], required: true },
        { name: 'why', type: 'text', label: '原因' },
        { name: 'both', type: 'multiselect', label: '同时', options: ['x', 'y', 'z'] },
        { name: 'sure', type: 'confirm', label: '确定' },
      ],
    });
    expect(t.live()?.pending).toMatchObject({ kind: 'QUESTION', humanRequestId: 'hrq_q' });
    expect(t.live()?.pending?.text).toContain('main 想问你');
    expect(t.live()?.pending?.text).toContain('用哪个库？');
    await t.console.submit('9');
    expect(t.named('answerHuman')).toHaveLength(0);
    expect(t.live()?.hint).toContain('不符合');
    await t.console.submit('2');
    await t.console.submit('-');
    await t.console.submit('1,3');
    expect(t.live()?.pending?.text).toContain('确定');
    await t.console.submit('y');
    expect(t.named('answerHuman')[0]?.request).toMatchObject({
      humanRequestId: 'hrq_q',
      input: { text: JSON.stringify({ lib: 'b', both: ['x', 'z'], sure: true }) },
    });
    expect(t.live()?.pending).toBeUndefined();
  });

  it('answers a confirmation with yes or no, and a review after showing the artifact', async () => {
    const ref = testArtifactRef();
    const t = setup({ artifacts: new Map([[ref.artifactId, '这是要审阅的内容']]) });
    await running(t);
    await t.event({
      type: 'HumanRequest',
      humanRequestId: 'hrq_c',
      kind: 'confirm',
      attachedAgentRunId: 'arn_main',
      question: '删除这个目录？',
    });
    await t.console.submit('也许');
    expect(t.named('answerHuman')).toHaveLength(0);
    await t.console.submit('n');
    expect(t.named('answerHuman')[0]?.request).toMatchObject({ input: { text: 'no' } });
    await t.event({
      type: 'HumanRequest',
      humanRequestId: 'hrq_r',
      kind: 'review',
      attachedAgentRunId: 'arn_main',
      question: '看看这个',
      reviewRef: ref,
    });
    expect(t.live()?.pending?.text).toContain('这是要审阅的内容');
    await t.console.submit('改一下标题');
    expect(t.named('answerHuman')[1]?.request).toMatchObject({
      humanRequestId: 'hrq_r',
      input: { text: '改一下标题' },
    });
  });

  it('drops a question the run was interrupted on, and says so', async () => {
    const t = setup();
    await running(t);
    await t.event({
      type: 'HumanRequest',
      humanRequestId: 'hrq_q',
      kind: 'ask',
      attachedAgentRunId: 'arn_main',
      question: '？',
    });
    expect(t.live()?.pending).toBeDefined();
    await t.event({ type: 'HumanResolved', humanRequestId: 'hrq_q', resolution: 'CANCELLED' });
    expect(t.live()?.pending).toBeUndefined();
    expect(t.printed.at(-1)).toMatchObject({ kind: 'NOTICE', text: '问题已取消。' });
  });

  it('maps the reasons of an interrupted reply', async () => {
    const t = setup();
    const ref = testArtifactRef();
    const t2 = setup({
      artifacts: new Map([[ref.artifactId, JSON.stringify({ reason: 'USER_ABORT' })]]),
    });
    await t2.console.submit('hi');
    await t2.event({
      type: 'MessagePublished',
      messageRef: ref,
      agentLabel: 'main',
      kind: 'DEGRADED_REPLY',
    });
    expect(t2.printed.at(-1)?.kind).toBe('ERROR');
    expect((t2.printed.at(-1) as { text: string }).text).toContain('已中止');
    expect(t.printed).toEqual([]);
  });
});
