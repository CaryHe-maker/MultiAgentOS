import { createHash } from 'node:crypto';
import {
  ExecutionFactV1Schema,
  ExecutionRequestV1Schema,
  MEDIA_TYPES,
  UnitReportV1Schema,
  assertValid,
  canonicalJson,
  type AppendLogPort,
  type ArtifactOwnerLine,
  type ArtifactStorePortV1,
  type ExecutionFactV1,
  type ExecutionKindV1,
  type ExecutionRequestV1,
  type UnitInputV1,
  type UnitReportV1,
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

function setup(options: { converging?: boolean } = {}) {
  const bodies = new Map<string, Uint8Array>();
  const lines: ArtifactOwnerLine[] = [];
  const store: ArtifactStorePortV1 = {
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
  const dispatched: ExecutionRequestV1[] = [];
  const reports: UnitReportV1[] = [];
  const ended: string[] = [];
  const faults: AttemptFault[] = [];
  const retries: RetryingActivity[] = [];
  const cancelled: number[] = [];
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
      dispatched.push(assertValid(ExecutionRequestV1Schema, request));
      return Promise.resolve();
    },
    cancelRun: (request) => {
      cancelled.push(request.runEpoch);
      return Promise.resolve();
    },
    retrying: (activity) => retries.push(activity),
    readRepositoryFile: (path) => Promise.resolve(path === 'AGENTS.md' ? 'be careful' : undefined),
    enqueue: (work) => {
      work();
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
  });
  const attempts: RunAttempts = new RunAttempts({
    provider: 'deepseek',
    technicalRetryLimit: 2,
    ledger: ledgers,
    scheduler: testScheduler(),
    createAttempt: (spec) => execution.createAttempt(spec, attempts),
    isDeliverable: () => options.converging !== true,
    isConverging: () => options.converging === true,
    leaseIsValid: () => true,
    deliver: (report) => reports.push(assertValid(UnitReportV1Schema, report)),
    attemptStarted: () => undefined,
    attemptRunning: () => undefined,
    attemptEnded: (_spec, id) => ended.push(id),
    onFault: (fault) => faults.push(fault),
    audit: () => undefined,
  });
  let requests = 0;
  const specOf = (kind: ExecutionKindV1, input: unknown, scope: AttemptSpec['scope']) => {
    requests += 1;
    return {
      requestId: testId('req', requests),
      agentRunId: testId('agr'),
      unitRunId: testId('unr', requests),
      turnId: testId('trn'),
      unit: testUnitDefinition(kind),
      input: input as UnitInputV1,
      scope,
      runEpoch: 1,
      agent: testPinnedAgent({ modelScope }),
      display: { toolName: 'tool', argsSummary: '' },
    };
  };
  const submit = (
    kind: ExecutionKindV1,
    input: unknown,
    scope: AttemptSpec['scope'] = repository,
  ) => attempts.start(specOf(kind, input, scope));
  const started = { startedAt: '2026-11-02T00:00:00.000Z', endedAt: '2026-11-02T00:00:01.000Z' };
  const factFor = (request: ExecutionRequestV1, rest: object): ExecutionFactV1 =>
    assertValid(ExecutionFactV1Schema, {
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

describe('the queue', () => {
  it('runs one attempt at a time, in order', async () => {
    const run = setup();
    await run.submit('FILE_READ', fileInput);
    await run.submit('FILE_READ', { path: 'b.ts' });
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
    const run = setup();
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
