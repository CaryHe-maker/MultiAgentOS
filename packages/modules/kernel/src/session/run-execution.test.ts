import { createHash } from 'node:crypto';
import {
  ExecutionFactSchema,
  ExecutionRequestSchema,
  MEDIA_TYPES,
  UnitReportSchema,
  assertValid,
  canonicalJson,
  type AppendLogPort,
  type ArtifactOwnerLine,
  type ArtifactStorePort,
  type ExecutionFact,
  type ExecutionKind,
  type ExecutionRequest,
  type UnitInput,
  type UnitReport,
} from '@multiagentos/contracts';
import {
  testFileReadOutput,
  testId,
  testUnitDefinition,
} from '@multiagentos/contracts/test-support';
import { describe, expect, it } from 'vitest';
import { RunLedgers, minShare } from '../monitor/index.js';
import { testAgentBudget, testPinnedAgent, testScheduler } from '../test-support/run-work.js';
import type { ExecutionConfig } from './attempt-request.js';
import { RunAttempts, type AttemptFault, type AttemptSpec } from './run-attempts.js';
import { RunExecution, type RetryingActivity } from './run-execution.js';
import { SessionArtifacts } from './session-artifacts.js';

const tool = {
  timeoutMs: 1000,
  maxOutputBytes: 1000,
  previewMaxBytes: 100,
  previewMaxLines: 10,
  maxFullOutputBytes: 1000,
};
const config: ExecutionConfig = {
  executionLimits: {
    REPOSITORY_ORIENT: tool,
    REPOSITORY_SEARCH: tool,
    REPOSITORY_LIST: tool,
    FILE_READ: tool,
    FILE_WRITE: tool,
    FILE_EDIT: tool,
    OUTPUT_READ: tool,
    COMMAND: tool,
    GIT_INSPECT: tool,
    CONTEXT_PRUNE: { timeoutMs: 1000, maxOutputBytes: 1000 },
    WEB_SEARCH: tool,
    WEB_FETCH: tool,
    CONTEXT_ASSEMBLE: { timeoutMs: 1000, maxOutputBytes: 1000 },
    MODEL: { timeoutMs: 1000, maxOutputBytes: 1000 },
  },
  retryBackoffBaseMs: 100,
  retryAfterMaxMs: 5000,
  maxReportBytes: 1000,
  maxSnapshotFiles: 100,
  orientBudget: 100,
  searchBudget: 100,
  cancelGraceMs: 10,
  pauseDrainMs: 50,
  convergenceMarginMs: 20,
};
const NOW = Date.parse('2026-11-02T00:00:00.000Z');
const repository: AttemptSpec['scope'] = {
  kind: 'REPOSITORY',
  repositoryRoot: '/repository',
  exclusions: [],
};
const modelScope = {
  kind: 'MODEL',
  provider: 'deepseek',
  apiModelId: 'deepseek-v4',
  apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
  baseUrl: 'https://api.deepseek.com',
  thinking: 'DISABLED',
} as const;

function setup(
  options: {
    converging?: boolean;
    maxConcurrentAttempts?: number;
    serialExecution?: boolean;
    /** Call slots; the test can change them. */
    slots?: { free: number };
  } = {},
) {
  const bodies = new Map<string, Uint8Array>();
  const lines: ArtifactOwnerLine[] = [];
  const store: ArtifactStorePort = {
    put: (content, mediaType) => {
      const sha256 = createHash('sha256').update(content).digest('hex');
      bodies.set(sha256, content);
      return Promise.resolve({
        artifactId: `art_${sha256}`,
        sha256,
        size: content.byteLength,
        mediaType,
      });
    },
    get: (ref) => {
      const body = bodies.get(ref.sha256);
      return body === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(body);
    },
    sweep: () => Promise.resolve({ removed: 0 }),
    capabilities: () => [],
  };
  const owners: AppendLogPort<ArtifactOwnerLine> = {
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
  const artifacts = new SessionArtifacts({
    store,
    owners,
    expiringRetentionDays: 7,
    now: () => new Date(NOW),
  });
  const ledgers = new RunLedgers(
    { runTokenLimit: minShare(testAgentBudget) * 4, turnTokenLimit: minShare(testAgentBudget) * 2 },
    testAgentBudget,
  );
  ledgers.openTurnLedger('trn_1');
  const dispatched: ExecutionRequest[] = [];
  const reports: UnitReport[] = [];
  const ended: string[] = [];
  const faults: AttemptFault[] = [];
  const retries: RetryingActivity[] = [];
  const cancelled: number[] = [];
  const cancelledExecutions: { executionId: string; reason: string }[] = [];
  const timers: { delayMs: number; due: () => void; cancelled: boolean }[] = [];
  let ids = 0;
  const nextId = (prefix: string) => {
    ids += 1;
    return testId(prefix, ids);
  };
  const execution = new RunExecution({
    sessionId: testId('ses'),
    workflowRunId: testId('wfr'),
    config,
    artifacts,
    dispatch: (request) => {
      dispatched.push(assertValid(ExecutionRequestSchema, request));
      return Promise.resolve();
    },
    cancelRun: (request) => {
      cancelled.push(request.runEpoch);
      return Promise.resolve();
    },
    cancelExecution: (request) => {
      cancelledExecutions.push({ executionId: request.executionId, reason: request.reason });
      return Promise.resolve();
    },
    written: () => Promise.resolve(),
    retrying: (activity) => retries.push(activity),
    readRepositoryFile: (path) => Promise.resolve(path === 'AGENTS.md' ? 'be careful' : undefined),
    enqueue: (work) => {
      void work();
    },
    schedule: (delayMs, due) => {
      const timer = { delayMs, due, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    now: () => new Date(NOW),
    newExecutionId: () => nextId('exe'),
    newAttemptId: () => nextId('una'),
    limits: {
      maxAttempts: options.maxConcurrentAttempts ?? 6,
      maxExec: 1,
      serial: options.serialExecution === true,
    },
  });
  const attempts: RunAttempts = new RunAttempts({
    provider: 'deepseek',
    technicalRetryLimit: 2,
    ledger: ledgers,
    scheduler:
      options.slots === undefined
        ? testScheduler()
        : {
            ...testScheduler(),
            acquire: () => {
              const slots = options.slots as { free: number };
              if (slots.free <= 0) return { ok: false, reason: 'CAPACITY' };
              slots.free -= 1;
              return { ok: true, grantId: `grt_${String(Math.random())}` };
            },
            release: () => {
              (options.slots as { free: number }).free += 1;
            },
          },
    createAttempt: (spec) => execution.createAttempt(spec, attempts),
    isDeliverable: () => options.converging !== true,
    isConverging: () => options.converging === true,
    leaseIsValid: () => true,
    deliver: (report) => reports.push(assertValid(UnitReportSchema, report)),
    attemptStarted: () => undefined,
    attemptRunning: () => undefined,
    attemptEnded: (_spec, id) => ended.push(id),
    onFault: (fault) => faults.push(fault),
    audit: () => undefined,
  });
  let requests = 0;
  const specOf = (
    kind: ExecutionKind,
    input: unknown,
    scope: AttemptSpec['scope'],
    agentRun = 1,
  ) => {
    requests += 1;
    return {
      requestId: testId('req', requests),
      agentRunId: testId('agr', agentRun),
      unitRunId: testId('unr', requests),
      turnId: testId('trn'),
      unit: testUnitDefinition(kind),
      input: input as UnitInput,
      scope,
      runEpoch: 1,
      agent: testPinnedAgent({ modelScope }),
      display: { toolName: 'tool', argsSummary: '' },
    };
  };
  const submit = (
    kind: ExecutionKind,
    input: unknown,
    scope: AttemptSpec['scope'] = repository,
    agentRun = 1,
  ) => attempts.start(specOf(kind, input, scope, agentRun));
  const started = { startedAt: '2026-11-02T00:00:00.000Z', endedAt: '2026-11-02T00:00:01.000Z' };
  const factFor = (request: ExecutionRequest, rest: object): ExecutionFact =>
    assertValid(ExecutionFactSchema, {
      sessionId: testId('ses'),
      workflowRunId: testId('wfr'),
      unitAttemptId: request.unitAttemptId,
      executionId: request.executionId,
      runEpoch: request.runEpoch,
      executionKind: request.executionKind,
      ...started,
      ...rest,
    });
  const fileResult = (text = 'preview', fullText?: string) => ({
    outcome: 'COMPLETED',
    result: {
      output: testFileReadOutput(),
      artifact: { mediaType: MEDIA_TYPES.fileText, text },
      ...(fullText === undefined ? {} : { fullOutput: { text: fullText } }),
    },
  });
  const last = () => {
    const request = dispatched.at(-1);
    if (request === undefined) throw new Error('nothing dispatched');
    return request;
  };
  return {
    execution,
    artifacts,
    lines,
    dispatched,
    reports,
    ended,
    faults,
    retries,
    cancelled,
    cancelledExecutions,
    timers,
    submit,
    factFor,
    fileResult,
    last,
  };
}

const fileInput = { path: 'a.ts' };
const failure = (extra: object = {}) => ({
  outcome: 'FAILED',
  reasonCode: 'PROVIDER_UNREACHABLE',
  retryable: true,
  requestState: 'NOT_SENT',
  ...extra,
});

describe('the queues (M2Design 7.1)', () => {
  it('runs neighbouring reads of one AgentRun together (P1)', async () => {
    const run = setup();
    for (const path of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await run.submit('FILE_READ', { path });
    expect(run.dispatched).toHaveLength(4);
  });

  it('runs the queues of different AgentRuns side by side, up to the global limit', async () => {
    const run = setup({ maxConcurrentAttempts: 3 });
    for (const agentRun of [1, 2, 3, 4])
      await run.submit('FILE_READ', fileInput, repository, agentRun);
    expect(run.dispatched).toHaveLength(3);
    // The oldest first: the fourth starts when one of the three has ended.
    await run.execution.handleFact(run.factFor(run.dispatched[0] as never, run.fileResult()));
    expect(run.dispatched).toHaveLength(4);
  });

  it('holds back what follows a barrier of the same AgentRun, and not another AgentRun', async () => {
    const run = setup();
    const contextPackRef = await run.artifacts.put(
      canonicalJson({
        contextPackId: testId('ctx'),
        tokenCount: 0,
        tokenBudget: testAgentBudget.perCallInputLimit,
        createdAt: '2026-11-02T00:00:00.000Z',
        operation: 'ASSEMBLE',
        prefixSha256: 'a'.repeat(64),
        projectionDigest: 'b'.repeat(64),
        headDigest: 'c'.repeat(64),
        elidedEntries: [],
        items: [],
      }),
      MEDIA_TYPES.contextPack,
      'EXPIRING',
    );
    await run.submit('MODEL', { contextPackRef, final: false }, { ...modelScope }, 1);
    await run.submit('FILE_READ', fileInput, repository, 1);
    await run.submit('FILE_READ', fileInput, repository, 2);
    // The model call of AgentRun 1 holds its read back; AgentRun 2 goes on.
    expect(run.dispatched.map((request) => request.executionKind)).toEqual(['MODEL', 'FILE_READ']);
  });

  it('starts one attempt at a time when serial', async () => {
    const run = setup({ serialExecution: true });
    await run.submit('FILE_READ', fileInput);
    await run.submit('FILE_READ', { path: 'b.ts' });
    await run.submit('FILE_READ', fileInput, repository, 2);
    expect(run.dispatched).toHaveLength(1);
    await run.execution.handleFact(run.factFor(run.last(), run.fileResult()));
    expect(run.dispatched).toHaveLength(2);
    expect(run.last().input).toMatchObject({ path: 'b.ts' });
  });

  it('drops a fact of another execution', async () => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    const stale = { ...run.factFor(run.last(), run.fileResult()), executionId: testId('exe', 99) };
    await run.execution.handleFact(stale);
    expect(run.reports).toEqual([]);
  });
});

describe('results', () => {
  it('keeps the preview for the Session and the full output for seven days', async () => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    await run.execution.handleFact(
      run.factFor(run.last(), run.fileResult('preview', 'the whole file')),
    );
    expect(run.reports[0]).toMatchObject({ status: 'OK' });
    expect(run.lines.map((line) => [line.retention, line.fullOutput])).toEqual([
      ['SESSION', undefined],
      ['EXPIRING', true],
    ]);
    const report = run.reports[0];
    if (report?.status !== 'OK' || report.fullRef === undefined) throw new Error('no full output');
    expect(await run.artifacts.read(report.fullRef)).toEqual({ ok: true, text: 'the whole file' });
  });

  it.each([
    ['a preview', 'x'.repeat(101), undefined],
    ['a full output', 'x', 'x'.repeat(1001)],
  ])('fails %s over its limit and stores nothing', async (_name, preview, full) => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    await run.execution.handleFact(run.factFor(run.last(), run.fileResult(preview, full)));
    expect(run.reports[0]).toMatchObject({ status: 'REJECTED', reasonCode: 'LIMIT_EXCEEDED' });
    expect(run.lines).toEqual([]);
  });

  it('runs a built-in Unit without the Supervisor', async () => {
    const run = setup();
    await run.submit(
      'MESSAGE_PUBLISH',
      { kind: 'DEGRADED_REPLY', agentLabel: 'main', reason: 'BUDGET_EXHAUSTED' },
      { kind: 'NONE' },
    );
    expect(run.dispatched).toEqual([]);
    expect(run.reports[0]).toMatchObject({ status: 'OK', output: { kind: 'DEGRADED_REPLY' } });
  });
});

describe('resolving references', () => {
  it('turns objectiveRef into the objective', async () => {
    const run = setup();
    const objectiveRef = await run.artifacts.storeUserInput({
      inputId: testId('inp'),
      text: 'why?',
    });
    await run.submit('REPOSITORY_ORIENT', { objectiveRef });
    expect(run.last().input).toMatchObject({ objective: 'why?' });
  });

  it('refuses an objective of another Session before anything runs', async () => {
    const run = setup();
    const other = setup();
    const objectiveRef = await other.artifacts.storeUserInput({
      inputId: testId('inp'),
      text: 'theirs',
    });
    await run.submit('REPOSITORY_ORIENT', { objectiveRef });
    expect(run.dispatched).toEqual([]);
    expect(run.reports[0]).toMatchObject({
      status: 'REJECTED',
      reasonCode: 'INVALID_ARTIFACT_REF',
    });
  });

  it('assembles history from artifacts, and tells the model what a refusal means', async () => {
    const run = setup();
    const contentRef = await run.artifacts.storeUserInput({
      inputId: testId('inp'),
      text: 'hello',
    });
    const outputRef = await run.artifacts.put(
      canonicalJson({
        provider: 'deepseek',
        apiModelId: 'deepseek-v4',
        providerFinishReason: 'tool_calls',
        text: 'reading',
        toolCalls: [{ toolCallId: 'call_1', toolName: 'read_file', argumentsText: '{"path":"a"}' }],
        receivedAt: '2026-11-02T00:00:00.000Z',
      }),
      MEDIA_TYPES.modelOutput,
      'SESSION',
    );
    const reasoningRef = await run.artifacts.put('secret thoughts', 'text/plain', 'SESSION');
    const entry = { category: 'NORMAL', turnId: testId('trn') };
    await run.submit(
      'CONTEXT_ASSEMBLE',
      {
        final: false,
        history: [
          { ...entry, seq: 1, kind: 'HUMAN', contentRef },
          {
            ...entry,
            seq: 2,
            kind: 'MODEL_TURN',
            modelId: 'deepseek-v4',
            outputRef,
            reasoningRef,
            replayable: false,
          },
          {
            ...entry,
            seq: 3,
            kind: 'TOOL_RESULT',
            toolCallId: 'call_1',
            toolName: 'read_file',
            status: 'REJECTED',
            reasonCode: 'USER_DECLINED',
          },
        ],
        status: {
          round: 1,
          maxRounds: 10,
          budget: { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' },
          final: false,
        },
      },
      { kind: 'NONE' },
    );
    expect(run.last().input).toMatchObject({
      instructions: 'You are a test agent.',
      tokenBudget: testAgentBudget.perCallInputLimit,
      history: [
        { kind: 'HUMAN', text: 'hello' },
        {
          kind: 'MODEL_TURN',
          text: 'reading',
          toolCalls: [{ toolCallId: 'call_1', arguments: { path: 'a' } }],
        },
        {
          kind: 'TOOL_RESULT',
          status: 'REJECTED',
          reasonCode: 'USER_DECLINED',
          toolName: 'read_file',
        },
      ],
    });
    expect(JSON.stringify(run.last().input)).not.toContain('secret thoughts');
  });
});

describe('technical retries', () => {
  const contextPack = (tokenBudget = testAgentBudget.perCallInputLimit) => ({
    contextPackId: testId('ctx'),
    tokenCount: 0,
    tokenBudget,
    createdAt: '2026-11-02T00:00:00.000Z',
    operation: 'ASSEMBLE',
    prefixSha256: 'a'.repeat(64),
    projectionDigest: 'b'.repeat(64),
    headDigest: 'c'.repeat(64),
    elidedEntries: [],
    items: [],
  });
  async function atModel(run: ReturnType<typeof setup>) {
    const contextPackRef = await run.artifacts.put(
      canonicalJson(contextPack()),
      MEDIA_TYPES.contextPack,
      'EXPIRING',
    );
    await run.submit('MODEL', { contextPackRef, final: false }, { ...modelScope });
  }

  it('waits for the longer of the back-off and Retry-After, and says so', async () => {
    const run = setup();
    await atModel(run);
    await run.execution.handleFact(run.factFor(run.last(), failure({ retryAfterMs: 2000 })));
    expect(run.dispatched).toHaveLength(2);
    expect(run.last().notBefore).toBe('2026-11-02T00:00:02.000Z');
    expect(run.retries).toMatchObject([{ attempt: 1, retryAt: '2026-11-02T00:00:02.000Z' }]);

    await run.execution.handleFact(run.factFor(run.last(), failure()));
    expect(run.last().notBefore).toBe('2026-11-02T00:00:00.200Z');
  });

  it('gives up when Retry-After is too long, with the original reason', async () => {
    const run = setup();
    await atModel(run);
    await run.execution.handleFact(run.factFor(run.last(), failure({ retryAfterMs: 5001 })));
    expect(run.dispatched).toHaveLength(1);
    expect(run.reports[0]).toMatchObject({
      status: 'FAILED',
      reasonCode: 'PROVIDER_UNREACHABLE',
    });
  });
});

describe('unknown effects', () => {
  it('reports an execution that never stopped', async () => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    run.execution.cancel(2);
    run.timers[0]?.due();
    await Promise.resolve();
    expect(run.execution.unknownEffects()).toMatchObject([
      { effect: 'EXECUTION_STOP_UNCONFIRMED', executionKind: 'FILE_READ' },
    ]);
  });
});

describe('project files', () => {
  it('stores the file for the Session and reports a missing one', async () => {
    const run = setup();
    const read = await run.execution.readProjectFile('AGENTS.md', repository);
    if (!read.exists) throw new Error('missing');
    expect(await run.artifacts.read(read.ref)).toEqual({ ok: true, text: 'be careful' });
    expect(read.truncated).toBe(false);
    expect(
      await run.execution.readProjectFile('.multiagentos/workflows/a.yaml', repository),
    ).toEqual({
      exists: false,
    });
  });
});

describe('cancelling', () => {
  it('ends what is queued and cancels what is in flight', async () => {
    const run = setup({ maxConcurrentAttempts: 1 });
    await run.submit('FILE_READ', fileInput);
    await run.submit('FILE_READ', { path: 'b.ts' });
    run.execution.cancel(2);
    expect(run.cancelled).toEqual([2]);
    expect(run.ended).toHaveLength(1);
    await run.execution.handleFact(
      run.factFor(run.last(), {
        outcome: 'TERMINATED',
        reasonCode: 'EXECUTION_CANCELLED',
      }),
    );
    expect(run.ended).toHaveLength(2);
    run.execution.closed();
    expect(run.timers[0]?.cancelled).toBe(true);
    expect(run.reports).toEqual([]);
  });

  it('judges an execution that never stops as unconfirmed', async () => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    run.execution.cancel(2);
    expect(run.timers[0]?.delayMs).toBe(30);
    run.timers[0]?.due();
    await Promise.resolve();
    expect(run.faults).toMatchObject([{ kind: 'STOP_UNCONFIRMED' }]);
    expect(run.ended).toHaveLength(1);
  });
});

describe('waiting for a call slot (M2Design 7.2)', () => {
  async function modelAttempt(run: ReturnType<typeof setup>, agentRun: number) {
    const contextPackRef = await run.artifacts.put(
      canonicalJson({
        contextPackId: testId('ctx'),
        tokenCount: 0,
        tokenBudget: testAgentBudget.perCallInputLimit,
        createdAt: '2026-11-02T00:00:00.000Z',
        operation: 'ASSEMBLE',
        prefixSha256: 'a'.repeat(64),
        projectionDigest: 'b'.repeat(64),
        headDigest: 'c'.repeat(64),
        elidedEntries: [],
        items: [],
      }),
      MEDIA_TYPES.contextPack,
      'EXPIRING',
    );
    await run.submit('MODEL', { contextPackRef, final: false }, { ...modelScope }, agentRun);
  }

  it('holds a model call back when every slot is in use, and sends it when one is free', async () => {
    const slots = { free: 1 };
    const run = setup({ slots });
    await modelAttempt(run, 1);
    await modelAttempt(run, 2);
    // Not a failure: no report, no fault, nothing ended, one request sent.
    expect(run.dispatched).toHaveLength(1);
    expect(run.reports).toEqual([]);
    expect(run.faults).toEqual([]);
    expect(run.ended).toEqual([]);
    await run.execution.drainCapacityWaiters();
    expect(run.dispatched).toHaveLength(1);
    // The first call ends, its slot comes back, and the second goes.
    await run.execution.handleFact(
      run.factFor(run.last(), {
        outcome: 'FAILED',
        reasonCode: 'PROVIDER_AUTH',
        retryable: false,
        requestState: 'NOT_SENT',
      }),
    );
    await run.execution.drainCapacityWaiters();
    expect(run.dispatched).toHaveLength(2);
    expect(run.dispatched[1]?.executionKind).toBe('MODEL');
  });

  it('holds the reads behind the call that waits, and does not hold another AgentRun back', async () => {
    const slots = { free: 0 };
    const run = setup({ slots });
    await modelAttempt(run, 1);
    await run.submit('FILE_READ', fileInput, repository, 1);
    await run.submit('FILE_READ', fileInput, repository, 2);
    // AgentRun 1 waits for a slot and holds its read; AgentRun 2 is not affected.
    expect(run.dispatched.map((request) => request.executionKind)).toEqual(['FILE_READ']);
  });

  it('gives up a waiting call when the run converges', async () => {
    const slots = { free: 0 };
    const run = setup({ slots });
    await modelAttempt(run, 1);
    run.execution.cancel(2);
    expect(run.ended).toHaveLength(1);
    expect(run.cancelled).toEqual([]);
    slots.free = 1;
    await run.execution.drainCapacityWaiters();
    expect(run.dispatched).toEqual([]);
  });
});

describe('pausing and aborting (Kernel/Execution 4e)', () => {
  const cancelledBy = (reason: 'PAUSED' | 'ABORTED') => ({
    outcome: 'TERMINATED',
    reasonCode: 'EXECUTION_CANCELLED',
    cancelReason: reason,
  });
  const modelPack = async (run: ReturnType<typeof setup>) =>
    run.artifacts.put(
      canonicalJson({
        contextPackId: testId('ctx'),
        tokenCount: 0,
        tokenBudget: testAgentBudget.perCallInputLimit,
        createdAt: '2026-11-02T00:00:00.000Z',
        operation: 'ASSEMBLE',
        prefixSha256: 'a'.repeat(64),
        projectionDigest: 'b'.repeat(64),
        headDigest: 'c'.repeat(64),
        elidedEntries: [],
        items: [],
      }),
      MEDIA_TYPES.contextPack,
      'EXPIRING',
    );

  it('starts nothing while paused, and everything held when resumed, oldest first', async () => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    let drained = 0;
    run.execution.pause(() => {
      drained += 1;
    });
    // The read is still executing: it may finish, so the pause is not complete.
    expect(drained).toBe(0);
    await run.submit('FILE_READ', { path: 'b.ts' }, repository, 2);
    expect(run.dispatched).toHaveLength(1);
    await run.execution.handleFact(run.factFor(run.dispatched[0] as never, run.fileResult()));
    expect(run.reports[0]).toMatchObject({ status: 'OK' });
    expect(drained).toBe(1);
    expect(run.dispatched).toHaveLength(1);
    await run.execution.resume();
    expect(run.dispatched).toHaveLength(2);
    expect(run.last().input).toMatchObject({ path: 'b.ts' });
  });

  it('is paused at once when nothing is executing', () => {
    const run = setup();
    let drained = 0;
    run.execution.pause(() => {
      drained += 1;
    });
    expect(drained).toBe(1);
  });

  it('lets a read finish within pauseDrainMs and cancels it after', async () => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    let drained = 0;
    run.execution.pause(() => {
      drained += 1;
    });
    const timer = run.timers.at(-1);
    expect(timer?.delayMs).toBe(50);
    expect(run.cancelledExecutions).toEqual([]);
    timer?.due();
    expect(run.cancelledExecutions).toEqual([
      { executionId: run.last().executionId, reason: 'PAUSED' },
    ]);
    await run.execution.handleFact(run.factFor(run.last(), cancelledBy('PAUSED')));
    expect(run.reports[0]).toMatchObject({ status: 'INTERRUPTED', interruptedBy: 'PAUSED' });
    expect(drained).toBe(1);
  });

  it('does not cancel a read that finished within pauseDrainMs', async () => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    run.execution.pause(() => undefined);
    const timer = run.timers.at(-1);
    await run.execution.handleFact(run.factFor(run.last(), run.fileResult()));
    expect(timer?.cancelled).toBe(true);
    expect(run.cancelledExecutions).toEqual([]);
  });

  it('cancels a model call at once when pausing, and settles what it used', async () => {
    const run = setup();
    const contextPackRef = await modelPack(run);
    await run.submit('MODEL', { contextPackRef, final: false }, { ...modelScope });
    run.execution.pause(() => undefined);
    expect(run.cancelledExecutions).toEqual([
      { executionId: run.last().executionId, reason: 'PAUSED' },
    ]);
    await run.execution.handleFact(
      run.factFor(run.last(), { ...cancelledBy('PAUSED'), requestState: 'NOT_SENT' }),
    );
    expect(run.reports[0]).toMatchObject({ status: 'INTERRUPTED', interruptedBy: 'PAUSED' });
  });

  it('answers every attempt INTERRUPTED(ABORTED) on abort, the queued ones too', async () => {
    const run = setup();
    const contextPackRef = await modelPack(run);
    await run.submit('MODEL', { contextPackRef, final: false }, { ...modelScope }, 1);
    // Behind the model call of its AgentRun: queued, never sent.
    await run.submit('FILE_READ', fileInput, repository, 1);
    await run.submit('FILE_READ', { path: 'b.ts' }, repository, 2);
    expect(run.dispatched).toHaveLength(2);
    run.execution.abort();
    expect(run.cancelledExecutions.map((entry) => entry.reason)).toEqual(['ABORTED', 'ABORTED']);
    // The queued one answers at once; the two that were sent when their facts arrive.
    expect(run.reports.map((report) => report.status)).toEqual(['INTERRUPTED']);
    for (const request of run.dispatched)
      await run.execution.handleFact(
        run.factFor(request, {
          ...cancelledBy('ABORTED'),
          ...(request.executionKind === 'MODEL' ? { requestState: 'NOT_SENT' } : {}),
        }),
      );
    expect(run.reports.map((report) => report.status)).toEqual([
      'INTERRUPTED',
      'INTERRUPTED',
      'INTERRUPTED',
    ]);
    expect(
      run.reports.every(
        (report) => 'interruptedBy' in report && report.interruptedBy === 'ABORTED',
      ),
    ).toBe(true);
    // The runEpoch did not move, so nothing was left to judge unconfirmed.
    expect(run.faults).toEqual([]);
  });

  it('judges a run that does not stop unconfirmed after the grace', async () => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    run.execution.abort();
    const timer = run.timers.at(-1);
    expect(timer?.delayMs).toBe(30);
    timer?.due();
    expect(run.faults).toEqual([expect.objectContaining({ kind: 'STOP_UNCONFIRMED' })]);
  });

  it('still starts what is made after an abort, such as the closing reply', async () => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    run.execution.abort();
    await run.execution.handleFact(run.factFor(run.last(), cancelledBy('ABORTED')));
    await run.submit(
      'MESSAGE_PUBLISH',
      { kind: 'DEGRADED_REPLY', agentLabel: 'main', reason: 'INTERRUPTED' },
      { kind: 'NONE' },
    );
    expect(run.reports.at(-1)).toMatchObject({ status: 'OK', output: { kind: 'DEGRADED_REPLY' } });
  });
});
