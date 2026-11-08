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
  const calls: {
    name: string;
    request: Record<string, unknown>;
    context?: Record<string, unknown>;
  }[] = [];
  const artifacts = options.artifacts ?? new Map<string, string>();
  const ack = { outcome: 'ACCEPTED' } as const;
  const record =
    (name: string, result: unknown = ack) =>
    (request: unknown, context?: unknown) => {
      calls.push({
        name,
        request: request as Record<string, unknown>,
        ...(context === undefined ? {} : { context: context as Record<string, unknown> }),
      });
      return Promise.resolve(result);
    };
  const accepted = { outcome: 'ACCEPTED', sessionId: SESSION };
  let compactResult: unknown = ack;
  const gateway = {
    startSession: record('startSession', accepted),
    openSession: record('openSession', accepted),
    startRun: record('startRun', accepted),
    listSessions: record('listSessions'),
    deleteSession: record('deleteSession'),
    answerAuthorization: record('answerAuthorization'),
    answerHuman: record('answerHuman'),
    compactContext: (request: unknown, context?: unknown) =>
      record('compactContext', compactResult)(request, context),
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
    setCompactResult: (result: unknown) => {
      compactResult = result;
    },
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

  it('welcomes by name, and lists the Sessions as a quiet list of their own below the notice', async () => {
    const t = setup();
    await t.console.start();
    expect(t.printed[0]).toMatchObject({ kind: 'NOTICE' });
    expect(t.printed[0]?.text).toBe(
      '欢迎使用 MultiAgentOS，输入问题后按 Enter 开始；/help 查看指令。',
    );
    await t.console.handleSystemEvent({
      event: {
        type: 'SessionList',
        sessions: [
          { sessionId: 'ses_1', title: 'one', turnCount: 8 },
          { sessionId: 'ses_2', turnCount: 22 },
        ],
      },
    } as never);
    const [header, list] = t.printed.slice(-2);
    expect(header).toMatchObject({ kind: 'NOTICE' });
    expect(header?.text).toBe('本仓库最近的对话（/resume <编号> 打开）：');
    expect(list).toMatchObject({ kind: 'LIST' });
    expect(list?.text.split('\n')).toHaveLength(2);
    expect(list?.text).toContain('1. one（8 轮）');
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
    expect(t.named('shutdown')[0]?.request).toMatchObject({ source: 'INTERRUPT_TWICE' });
    await exited;
  });

  it('says who asks for the system to stop: /exit, and the code of an exit from outside', async () => {
    const t = setup();
    await t.console.submit('/exit');
    expect(t.named('shutdown')[0]?.request).toMatchObject({ source: 'EXIT_COMMAND' });
    t.console.exitWith(75);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.named('shutdown')[1]?.request).toMatchObject({ source: 'EXIT_CODE' });
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

describe('a long command in a question (Phase1Console 2.1, UI-4)', () => {
  const askFor = (command: string) =>
    ({
      type: 'AuthorizationRequest',
      questionId: 'qst_cmd',
      capability: 'command.exec',
      command,
      workdir: '',
      writableRoots: ['.'],
      network: false,
      unisolated: false,
      options: ['ONCE', 'COMMAND', 'DENY'],
      prefixes: [],
      unreusable: [],
    }) as unknown as KernelToInteractionEvent;

  it('shows a short command as it is', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(askFor('ls -la src'));
    const asked = t.live()?.pending;
    expect(asked?.text).toContain('  ls -la src');
    expect(asked?.text).not.toContain('输入 v');
    expect(asked).not.toHaveProperty('detail');
  });

  it('shows the head of a long command, says how much was left out, and `v` prints all of it', async () => {
    const t = setup();
    await t.console.submit('hi');
    const body = Array.from({ length: 40 }, (_, index) => `line ${String(index)} of the file`);
    const command = `cat > notes.md <<'EOF'\n${body.join('\n')}\nEOF`;
    await t.event(askFor(command));
    const asked = t.live()?.pending;
    expect(asked?.text).toContain("cat > notes.md <<'EOF'");
    expect(asked?.text).toContain('line 1 of the file');
    expect(asked?.text).not.toContain('line 30 of the file');
    expect(asked?.text).toContain('共 42 行');
    expect(asked?.text).toContain('v      查看完整命令');

    // Looking is not answering: the question stays, and nothing was sent to the Kernel.
    await t.console.submit('v');
    expect(t.printed.at(-1)).toMatchObject({ kind: 'NOTICE' });
    expect(t.printed.at(-1)?.text).toContain('line 30 of the file');
    expect(t.printed.at(-1)?.text).toContain('\nEOF');
    expect(t.live()?.pending).toMatchObject({ questionId: 'qst_cmd' });
    expect(t.named('answerAuthorization')).toHaveLength(0);

    await t.console.submit('1');
    expect(t.named('answerAuthorization')[0]?.request).toMatchObject({
      answer: { scope: 'ONCE' },
    });
  });

  it('writes escape sequences in a command as text, so they cannot draw on the screen', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(askFor('echo \u001b[2Jgone'));
    expect(t.live()?.pending?.text).not.toContain('\u001b');
    expect(t.live()?.pending?.text).toContain('\\u001b');
  });
});

describe('thinking streamed beside the run (Phase1Console 4)', () => {
  const stream = (kind: 'REASONING' | 'END', callId: string, delta = '') =>
    ({
      sessionId: SESSION,
      workflowRunId: RUN,
      agentRunId: 'arn_1',
      callId,
      at: new Date(0).toISOString(),
      kind,
      ...(kind === 'REASONING' ? { delta } : {}),
    }) as Parameters<Console['handleModelStream']>[0];

  const running = (turnId: string) =>
    ({ type: 'RunStateChanged', state: 'RUNNING', turnId }) as KernelToInteractionEvent;

  /** One model call that thinks, as it comes. */
  const thought = (t: ReturnType<typeof setup>, callId: string, words: string) => {
    t.console.handleModelStream(stream('REASONING', callId, words));
    t.console.handleModelStream(stream('END', callId));
  };

  it('passes the thinking as it arrives, numbered, under the AgentRun that is thinking', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event({
      type: 'ActivityEvent',
      agentRunId: 'arn_1',
      label: 'planner',
      phase: 'THINKING',
      at: new Date(0).toISOString(),
    });
    await t.event(running('trn_1'));
    t.console.handleModelStream(stream('REASONING', 'exe_1', 'First, '));
    expect(t.live()?.thinking).toMatchObject([
      { id: 'exe_1', number: 1, label: 'planner', state: 'OPEN', text: 'First, ' },
    ]);
    t.console.handleModelStream(stream('REASONING', 'exe_1', 'then more.'));
    t.console.handleModelStream(stream('END', 'exe_1'));
    expect(t.live()?.thinking).toMatchObject([{ state: 'DONE', text: 'First, then more.' }]);
  });

  it('numbers every call, also several in one Turn, in the order they began', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(running('trn_1'));
    thought(t, 'exe_1', 'one');
    thought(t, 'exe_2', 'two');
    thought(t, 'exe_3', 'three');
    expect(t.live()?.thinking?.map((block) => [block.number, block.text])).toEqual([
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
    ]);
  });

  it('ignores what is not for the Session in view, and writes control characters as text', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(running('trn_1'));
    t.console.handleModelStream({
      ...stream('REASONING', 'exe_x', 'other'),
      sessionId: 'ses_01J00000000000000000000002',
    });
    expect(t.live()?.thinking).toEqual([]);
    t.console.handleModelStream(stream('REASONING', 'exe_1', 'ok\u001b[2J'));
    expect(t.live()?.thinking?.[0]?.text).toBe('ok\\u001b[2J');
  });

  it('closes a block that never got its end when the run waits for the user', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(running('trn_1'));
    t.console.handleModelStream(stream('REASONING', 'exe_1', 'cut off'));
    await t.event({ type: 'RunStateChanged', state: 'AWAITING_INPUT' });
    expect(t.live()?.thinking?.[0]?.state).toBe('DONE');
  });

  it('closes it as aborted when the run is interrupted', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(running('trn_1'));
    t.console.handleModelStream(stream('REASONING', 'exe_1', 'cut off'));
    await t.event({ type: 'RunStateChanged', state: 'INTERRUPTING' });
    expect(t.live()?.thinking?.[0]?.state).toBe('ABORTED');
  });

  it('lists the blocks with /think and prints the whole of one with /think <n>', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(running('trn_1'));
    thought(t, 'exe_1', 'the whole first thought');
    thought(t, 'exe_2', 'the second');
    await t.console.submit('/think');
    expect(t.printed.at(-1)?.text).toContain('第 1 段：main 思考');
    expect(t.printed.at(-1)?.text).toContain('第 2 段：main 思考');
    await t.console.submit('/think 1');
    expect(t.printed.at(-1)).toMatchObject({ kind: 'THINKING' });
    expect(t.printed.at(-1)?.text).toContain('the whole first thought');
    await t.console.submit('/think 7');
    expect(t.printed.at(-1)?.text).toContain('没有第 7 段思考');
  });

  it('says there is nothing to show before any thinking arrived', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.console.submit('/think');
    expect(t.printed.at(-1)?.text).toContain('还没有思考内容');
  });

  it('keeps no more blocks than it is allowed to, and the numbers go on', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(running('trn_1'));
    for (let index = 1; index <= 103; index += 1)
      thought(t, `exe_${String(index)}`, `thought ${String(index)}`);
    const numbers = t.live()?.thinking?.map((block) => block.number) ?? [];
    expect(numbers).toHaveLength(100);
    expect(numbers[0]).toBe(4);
    expect(numbers.at(-1)).toBe(103);
    await t.console.submit('/think 1');
    expect(t.printed.at(-1)?.text).toContain('没有第 1 段思考');
  });
});

describe('after the Session is closed', () => {
  it('starts the next message in a new Session, naming no run of the closed one', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event({ type: 'RunStateChanged', state: 'AWAITING_INPUT' });
    await t.console.handleSessionEvent({
      eventId: 'evt_x',
      sessionId: SESSION,
      seq: 1,
      occurredAt: new Date(0).toISOString(),
      event: { type: 'SessionClosed', reason: 'SHUTDOWN' },
    } as unknown as Parameters<Console['handleSessionEvent']>[0]);
    await t.console.submit('again');
    const starts = t.calls.filter((call) => call.name === 'startSession');
    expect(starts).toHaveLength(2);
    expect(starts.at(-1)?.context).toBeDefined();
    expect(starts.at(-1)?.context).not.toHaveProperty('workflowRunId');
  });
});

describe('a compaction the user asks for', () => {
  it('is told why it cannot be done now, not that a request conflicted', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event({ type: 'RunStateChanged', state: 'AWAITING_INPUT' });
    t.setCompactResult({ outcome: 'REJECTED', reasonCode: 'REQUEST_CONFLICT' });
    await t.console.submit('/compact');
    expect(t.printed.at(-1)?.text).toContain('暂时无法压缩');
    expect(t.live()?.activity).toEqual([]);
  });

  const running = () =>
    ({ type: 'RunStateChanged', state: 'AWAITING_INPUT' }) as KernelToInteractionEvent;

  it('shows the system at work, with the time, from the moment it is asked until it is done', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(running());
    await t.console.submit('/compact');
    expect(t.live()?.activity).toMatchObject([{ label: '系统', phase: '正在压缩上下文' }]);
    await t.event({
      type: 'ContextCompacted',
      trigger: 'USER',
      compactedTurns: 2,
      prunedResults: 0,
    } as unknown as KernelToInteractionEvent);
    expect(t.live()?.activity).toEqual([]);
  });

  it('says the context is too short, in plain words, when there is nothing worth compacting', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(running());
    await t.console.submit('/compact');
    await t.event({
      type: 'CompactionFailed',
      trigger: 'USER',
      reason: 'NOTHING_TO_COMPACT',
    } as unknown as KernelToInteractionEvent);
    expect(t.printed.at(-1)?.text).toBe('无法压缩：抱歉，目前的上下文记录仍较短，无法有效压缩');
    expect(t.live()?.activity).toEqual([]);
  });

  it('stops saying so when it did not happen, and says why', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(running());
    await t.console.submit('/compact');
    await t.event({
      type: 'CompactionFailed',
      trigger: 'USER',
      reason: 'SUMMARY_FAILED',
    } as unknown as KernelToInteractionEvent);
    expect(t.live()?.activity).toEqual([]);
    expect(t.printed.at(-1)?.text).toBe('摘要没有生成，没有压缩。');
  });
});

describe('a compaction in the history', () => {
  it('is one step line like a tool call, not a notice', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event({
      type: 'ContextCompacted',
      trigger: 'AUTO',
      compactedTurns: 0,
      prunedResults: 1,
    } as unknown as KernelToInteractionEvent);
    await t.event({
      type: 'ContextCompacted',
      trigger: 'AUTO',
      compactedTurns: 3,
      prunedResults: 2,
    } as unknown as KernelToInteractionEvent);
    const steps = t.printed.filter((entry) => entry.kind === 'STEP').map((entry) => entry.text);
    expect(steps).toEqual([
      '✓ 已修剪 1 个较大的工具结果',
      '✓ 已压缩较早的对话（3 个 Turn，修剪 2 个工具结果）',
    ]);
    expect(t.printed.some((entry) => entry.kind === 'NOTICE' && entry.text.includes('修剪'))).toBe(
      false,
    );
  });
});

describe('an answer being written for the user (Phase1Console 4)', () => {
  const stream = (
    callId: string,
    kind: 'REASONING' | 'ANSWER' | 'END',
    at = 0,
    agentRunId = 'arn_1',
  ) =>
    ({
      sessionId: SESSION,
      workflowRunId: RUN,
      agentRunId,
      callId,
      at: new Date(at).toISOString(),
      kind,
      ...(kind === 'REASONING' ? { delta: 'thinking' } : {}),
    }) as Parameters<Console['handleModelStream']>[0];
  const running = (turnId: string) =>
    ({ type: 'RunStateChanged', state: 'RUNNING', turnId }) as KernelToInteractionEvent;
  const thinkingPhase = {
    type: 'ActivityEvent',
    agentRunId: 'arn_1',
    label: 'planner',
    phase: 'THINKING',
    at: new Date(0).toISOString(),
  } as unknown as KernelToInteractionEvent;

  it('turns the line of the agent that writes it into one that says so, with its own time', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(thinkingPhase);
    await t.event(running('trn_1'));
    t.console.handleModelStream(stream('exe_1', 'REASONING', 100));
    t.console.handleModelStream(stream('exe_1', 'ANSWER', 1000));
    // One line for the agent, not a second one beside it: one clock, not two.
    expect(t.live()?.activity).toMatchObject([
      {
        label: 'planner',
        phase: '正在输出回答',
        since: new Date(1000).toISOString(),
      },
    ]);
    // The thinking is over when the answer begins: its clock stops there too.
    expect(t.live()?.thinking?.[0]).toMatchObject({
      state: 'DONE',
      endedAt: new Date(1000).toISOString(),
    });
  });

  it('keeps saying so until the message itself is published', async () => {
    const artifacts = new Map<string, string>();
    const u = setup({ artifacts });
    await u.console.submit('hi');
    await u.event(thinkingPhase);
    await u.event(running('trn_1'));
    u.console.handleModelStream(stream('exe_1', 'ANSWER'));
    u.console.handleModelStream(stream('exe_1', 'END'));
    expect(u.live()?.activity[0]?.phase).toBe('正在输出回答');
    const ref = testArtifactRef('Hello!');
    artifacts.set(ref.artifactId, 'Hello!');
    await u.event({
      type: 'MessagePublished',
      kind: 'REPLY',
      agentLabel: 'main',
      messageRef: ref,
    } as unknown as KernelToInteractionEvent);
    expect(u.live()?.activity[0]?.phase).toBe('思考中');
    expect(u.printed.some((entry) => entry.kind === 'REPLY')).toBe(true);
  });

  it('lets the next call of an agent replace the line of the one before', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(thinkingPhase);
    await t.event(running('trn_1'));
    t.console.handleModelStream(stream('exe_1', 'ANSWER', 1000));
    t.console.handleModelStream(stream('exe_1', 'END'));
    t.console.handleModelStream(stream('exe_2', 'ANSWER', 5000));
    expect(t.live()?.activity).toMatchObject([{ since: new Date(5000).toISOString() }]);
  });

  it('says which tool and which file an agent is writing a call for, with its own time', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(thinkingPhase);
    await t.event(running('trn_1'));
    t.console.handleModelStream(stream('exe_1', 'REASONING', 100));
    t.console.handleModelStream({
      ...stream('exe_1', 'REASONING', 2000),
      kind: 'TOOL',
      name: 'write_file',
    });
    expect(t.live()?.activity).toMatchObject([
      { phase: '正在生成 write_file', since: new Date(2000).toISOString() },
    ]);
    expect(t.live()?.thinking?.[0]).toMatchObject({ state: 'DONE' });
    // The file is known later; the clock goes on from where it began.
    t.console.handleModelStream({
      ...stream('exe_1', 'REASONING', 3000),
      kind: 'TOOL',
      name: 'write_file',
      target: 'docs/a.docx',
    });
    expect(t.live()?.activity).toMatchObject([
      { phase: '正在生成 write_file docs/a.docx', since: new Date(2000).toISOString() },
    ]);
    // Once the call is written, the line is the tool's own again.
    t.console.handleModelStream(stream('exe_1', 'END', 4000));
    expect(t.live()?.activity[0]?.phase).toBe('思考中');
  });

  it('does not say it of an agent that only thinks', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(thinkingPhase);
    await t.event(running('trn_1'));
    t.console.handleModelStream(stream('exe_1', 'REASONING', 100));
    expect(t.live()?.activity[0]?.phase).toBe('思考中');
  });

  it('is gone when the run waits for the user', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(thinkingPhase);
    await t.event(running('trn_1'));
    t.console.handleModelStream(stream('exe_1', 'ANSWER'));
    await t.event({ type: 'RunStateChanged', state: 'AWAITING_INPUT' });
    expect(t.live()?.activity).toEqual([]);
  });
});

describe('how full the context is', () => {
  const level = (used: number, limit = 1000, sessionId = SESSION) =>
    ({
      sessionId,
      workflowRunId: RUN,
      agentRunId: 'arn_1',
      callId: 'exe_1',
      at: new Date(0).toISOString(),
      kind: 'CONTEXT',
      used,
      limit,
    }) as Parameters<Console['handleModelStream']>[0];
  const awaitingInput = {
    type: 'RunStateChanged',
    state: 'AWAITING_INPUT',
  } as KernelToInteractionEvent;

  it('is not there before the first assembly, then is the share of the limit in whole percent', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(awaitingInput);
    expect(t.live()?.context).toBeUndefined();
    t.console.handleModelStream(level(304));
    expect(t.live()?.context).toBe(30);
    t.console.handleModelStream(level(5000));
    expect(t.live()?.context).toBe(100);
  });

  it('is not shown for another Session', async () => {
    const t = setup();
    await t.console.submit('hi');
    t.console.handleModelStream(level(300, 1000, 'ses_other'));
    expect(t.live()?.context).toBeUndefined();
  });

  it('goes when a compaction begins, whoever began it, and comes back with the next assembly', async () => {
    const t = setup();
    await t.console.submit('hi');
    await t.event(awaitingInput);
    t.console.handleModelStream(level(300));
    await t.console.submit('/compact');
    expect(t.live()?.context).toBeUndefined();
    t.console.handleModelStream(level(100));
    expect(t.live()?.context).toBe(10);
    // The run's own compaction, before a call.
    await t.event({
      type: 'ActivityEvent',
      agentRunId: 'arn_1',
      label: 'main',
      phase: 'COMPACTING',
      at: new Date(0).toISOString(),
    } as unknown as KernelToInteractionEvent);
    expect(t.live()?.context).toBeUndefined();
  });
});
