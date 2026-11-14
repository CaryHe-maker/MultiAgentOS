import {
  DENY_SANDBOX,
  ExecutionFactSchema,
  MEDIA_TYPES,
  validate,
  type ExecutionFact,
  type ExecutionRequest,
  type Executor,
  type ExecutorKind,
  type ExecutorOutcome,
  type ExecutorRegistry,
  type ProviderCredentials,
  type SubprocessRunner,
} from '@multiagentos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutorEnvironment } from './environment.js';
import { ExecutionRunner } from './execution-runner.js';
import { toExecutionFact, toTerminationFact } from './fact-mapper.js';

type ListRequest = Extract<ExecutionRequest, { executionKind: 'REPOSITORY_LIST' }>;
type ModelRequest = Extract<ExecutionRequest, { executionKind: 'MODEL' }>;

const SHA = 'a'.repeat(64);
const TOOL_LIMITS = {
  deadline: '2026-10-19T01:00:00.000Z',
  maxOutputBytes: 1024,
  preview: { maxBytes: 1024, maxLines: 100 },
  maxFullOutputBytes: 4096,
};
const completedList: ExecutorOutcome = {
  outcome: 'COMPLETED',
  result: {
    output: { path: '.', directoryCount: 0, fileCount: 0, omittedEntries: 0 },
    artifact: { mediaType: MEDIA_TYPES.fileText, text: '' },
  },
};

class RecordingSink {
  public readonly facts: ExecutionFact[] = [];

  public report(fact: ExecutionFact): Promise<void> {
    this.facts.push(fact);
    return Promise.resolve();
  }
}

const runners: ExecutionRunner[] = [];
afterEach(() => {
  for (const runner of runners.splice(0)) runner.stop();
});

function listRequest(executionId = 'exe_123456'): ListRequest {
  return {
    sessionId: 'ses_123456',
    workflowRunId: 'wfr_123456',
    unitAttemptId: 'una_123456',
    executionId,
    runEpoch: 1,
    executionKind: 'REPOSITORY_LIST',
    input: {},
    scope: { kind: 'REPOSITORY', repositoryRoot: '/repo', exclusions: [] },
    limits: {
      deadline: '2026-10-19T01:00:00.000Z',
      maxOutputBytes: 1024,
      preview: { maxBytes: 1024, maxLines: 100 },
      maxFullOutputBytes: 4096,
    },
  };
}

function modelRequest(): ModelRequest {
  return {
    sessionId: 'ses_123456',
    workflowRunId: 'wfr_123456',
    unitAttemptId: 'una_123456',
    executionId: 'exe_123456',
    runEpoch: 1,
    executionKind: 'MODEL',
    input: {
      contextPack: {
        contextPackId: 'ctx_123456',
        operation: 'ASSEMBLE',
        tokenCount: 0,
        tokenBudget: 1000,
        prefixSha256: SHA,
        projectionDigest: SHA,
        headDigest: SHA,
        elidedEntries: [],
        items: [],
        createdAt: '2026-10-19T00:00:00.000Z',
      },
      final: false,
    },
    scope: {
      kind: 'MODEL',
      provider: 'deepseek',
      apiModelId: 'deepseek-flash',
      apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
      baseUrl: 'https://api.deepseek.com',
      thinking: 'DISABLED',
    },
    limits: {
      deadline: '2026-10-19T01:00:00.000Z',
      maxOutputBytes: 1024,
      maxOutputTokens: 100,
    },
  };
}

function requestFor(kind: ExecutorKind): ExecutionRequest {
  switch (kind) {
    case 'REPOSITORY_LIST':
      return listRequest();
    case 'REPOSITORY_SEARCH':
      return {
        ...listRequest(),
        executionKind: 'REPOSITORY_SEARCH',
        input: { query: 'x', mode: 'AUTO', maxItems: 10, tokenBudget: 1000 },
        limits: TOOL_LIMITS,
      };
    case 'FILE_READ':
      return {
        ...listRequest(),
        executionKind: 'FILE_READ',
        input: { path: 'a.ts' },
        limits: TOOL_LIMITS,
      };
    case 'CONTEXT_ASSEMBLE':
      return {
        sessionId: 'ses_123456',
        workflowRunId: 'wfr_123456',
        unitAttemptId: 'una_123456',
        executionId: 'exe_123456',
        runEpoch: 1,
        executionKind: 'CONTEXT_ASSEMBLE',
        input: {
          final: false,
          tokenBudget: 1000,
          instructions: 'system',
          toolSpecs: [],
          history: [],
          status: {
            round: 1,
            maxRounds: 1,
            final: false,
            budget: { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' },
          },
        },
        scope: { kind: 'NONE' },
        limits: { deadline: '2026-10-19T01:00:00.000Z', maxOutputBytes: 1024 },
      };
    case 'MODEL':
      return modelRequest();
    default:
      throw new Error(`No request for ${kind}`);
  }
}

function completedFor(kind: ExecutorKind): ExecutorOutcome {
  switch (kind) {
    case 'REPOSITORY_LIST':
      return completedList;
    case 'REPOSITORY_SEARCH':
      return {
        outcome: 'COMPLETED',
        result: {
          output: { snapshotId: `snp_${SHA}`, hits: [], truncated: false },
          artifact: { mediaType: MEDIA_TYPES.contextPack, text: '{}' },
        },
      };
    case 'FILE_READ':
      return {
        outcome: 'COMPLETED',
        result: {
          output: {
            path: 'a.ts',
            startLine: 1,
            endLine: 0,
            totalLines: 0,
            contentSha256: SHA,
            fileSha256: SHA,
          },
          artifact: { mediaType: MEDIA_TYPES.fileText, text: '' },
        },
      };
    case 'CONTEXT_ASSEMBLE':
      return {
        outcome: 'COMPLETED',
        result: {
          output: {
            contextPackId: 'ctx_123456',
            tokenCount: 0,
            tokenBudget: 1000,
            prefixSha256: SHA,
            projectionDigest: SHA,
            headDigest: SHA,
            elidedEntries: [],
          },
          artifact: { mediaType: MEDIA_TYPES.contextPack, text: '{}' },
        },
      };
    case 'MODEL':
      return {
        outcome: 'COMPLETED',
        result: {
          output: { finishReason: 'STOP', toolCalls: [], hasText: false, hasReasoning: false },
          artifact: { mediaType: MEDIA_TYPES.modelOutput, text: '{}' },
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    default:
      throw new Error(`No result for ${kind}`);
  }
}

const credentials: ProviderCredentials = {
  apiKeyFor: (provider) => (provider === 'deepseek' ? 'test-key' : undefined),
};

const subprocess: SubprocessRunner = {
  run: () => Promise.resolve({ exitCode: 0, signal: null, stdout: 'matched', truncated: false }),
};

function executor<K extends ExecutorKind>(kind: K, execute: Executor<K>['execute']): Executor<K> {
  return { executionKind: kind, execute };
}

function registry(list: Executor<'REPOSITORY_LIST'>): ExecutorRegistry {
  const unused = <K extends ExecutorKind>(kind: K): Executor<K> =>
    executor(kind, () => Promise.resolve({ outcome: 'REJECTED', reasonCode: 'OUT_OF_SCOPE' }));
  return {
    REPOSITORY_LIST: list,
    REPOSITORY_SEARCH: unused('REPOSITORY_SEARCH'),
    FILE_READ: unused('FILE_READ'),
    FILE_WRITE: unused('FILE_WRITE'),
    FILE_EDIT: unused('FILE_EDIT'),
    OUTPUT_READ: unused('OUTPUT_READ'),
    COMMAND: unused('COMMAND'),
    GIT_INSPECT: unused('GIT_INSPECT'),
    WEB_SEARCH: unused('WEB_SEARCH'),
    WEB_FETCH: unused('WEB_FETCH'),
    CONTEXT_PRUNE: unused('CONTEXT_PRUNE'),
    CONTEXT_ASSEMBLE: unused('CONTEXT_ASSEMBLE'),
    MODEL: unused('MODEL'),
  };
}

function makeRunner(list: Executor<'REPOSITORY_LIST'>): {
  readonly runner: ExecutionRunner;
  readonly sink: RecordingSink;
} {
  return makeRunnerWith(registry(list));
}

function makeRunnerWith(
  executors: ExecutorRegistry,
  cancelGraceMs = 1000,
): {
  readonly runner: ExecutionRunner;
  readonly sink: RecordingSink;
} {
  const sink = new RecordingSink();
  const runner = new ExecutionRunner({
    executors,
    credentials,
    subprocess,
    sandbox: DENY_SANDBOX,
    facts: sink,
    cancelGraceMs,
    killGraceMs: 100,
    now: () => new Date('2026-10-19T00:00:00.000Z'),
  });
  runners.push(runner);
  return { runner, sink };
}

function registryFor<K extends ExecutorKind>(kind: K, target: Executor<K>): ExecutorRegistry {
  const base = registry(executor('REPOSITORY_LIST', () => Promise.resolve(completedList)));
  return { ...base, [kind]: target };
}

function pendingUntilAbort(outcome: ExecutorOutcome): Executor<'REPOSITORY_LIST'> {
  return executor('REPOSITORY_LIST', (_input, environment) => {
    if (environment.signal.aborted) return Promise.resolve(outcome);
    return new Promise((resolve) => {
      environment.signal.addEventListener('abort', () => resolve(outcome), { once: true });
    });
  });
}

function hanging(): Executor<'REPOSITORY_LIST'> {
  return executor('REPOSITORY_LIST', () => new Promise(() => undefined));
}

async function waitForFact(sink: RecordingSink): Promise<ExecutionFact> {
  await vi.waitFor(() => expect(sink.facts).toHaveLength(1));
  return sink.facts[0] as ExecutionFact;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ExecutionRunner', () => {
  it('accepts before starting and reports a completed fact', async () => {
    let started = false;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => {
        started = true;
        return Promise.resolve(completedList);
      }),
    );

    runner.execute(listRequest(), 'cor_123456');
    expect(started).toBe(false);

    await vi.waitFor(() => expect(started).toBe(true));
    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({
      outcome: 'COMPLETED',
      executionKind: 'REPOSITORY_LIST',
      workflowRunId: 'wfr_123456',
      unitAttemptId: 'una_123456',
      executionId: 'exe_123456',
      runEpoch: 1,
      startedAt: '2026-10-19T00:00:00.000Z',
      endedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });

  it('honours notBefore before starting the Executor', async () => {
    let started = false;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => {
        started = true;
        return Promise.resolve(completedList);
      }),
    );
    const request = { ...listRequest(), notBefore: '2026-10-19T00:00:00.050Z' };

    runner.execute(request, 'cor_123456');
    await delay(10);
    expect(started).toBe(false);

    await vi.waitFor(() => expect(started).toBe(true));
    const fact = await waitForFact(sink);
    expect(fact.outcome).toBe('COMPLETED');
  });

  it.each<ExecutorOutcome>([
    completedList,
    { outcome: 'REJECTED', reasonCode: 'OUT_OF_SCOPE' },
    { outcome: 'FAILED', reasonCode: 'INTERNAL', retryable: true },
    { outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' },
  ])('maps the normal Executor outcome %# without duplicates', async (outcome) => {
    let calls = 0;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => {
        calls += 1;
        return Promise.resolve(outcome);
      }),
    );

    runner.execute(listRequest(), 'cor_123456');
    const fact = await waitForFact(sink);
    expect(fact.outcome).toBe(outcome.outcome);
    expect(calls).toBe(1);
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
    expect(sink.facts).toHaveLength(1);
  });

  it('normalizes an Executor throw to FAILED(INTERNAL, retryable=false)', async () => {
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => Promise.reject(new Error('boom'))),
    );

    runner.execute(listRequest(), 'cor_123456');
    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
      retryable: false,
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });

  it('ignores a duplicate executionId and reports one fact', async () => {
    let calls = 0;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => {
        calls += 1;
        return Promise.resolve(completedList);
      }),
    );

    const request = listRequest();
    runner.execute(request, 'cor_123456');
    runner.execute(request, 'cor_123456');
    await waitForFact(sink);

    expect(calls).toBe(1);
    expect(sink.facts).toHaveLength(1);
  });

  it.each<ExecutorKind>([
    'REPOSITORY_LIST',
    'REPOSITORY_SEARCH',
    'FILE_READ',
    'CONTEXT_ASSEMBLE',
    'MODEL',
  ])('runs a %s executor and emits a kind-specific fact', async (kind) => {
    const outcome = completedFor(kind);
    const { runner, sink } = makeRunnerWith(
      registryFor(
        kind,
        executor(kind, () => Promise.resolve(outcome)),
      ),
    );

    runner.execute(requestFor(kind), 'cor_123456');
    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({ executionKind: kind, outcome: 'COMPLETED' });
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });

  it('turns a missing executor into FAILED(INTERNAL)', async () => {
    const { runner, sink } = makeRunnerWith({} as ExecutorRegistry);
    runner.execute(listRequest(), 'cor_123456');
    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({ outcome: 'FAILED', reasonCode: 'INTERNAL', retryable: false });
  });

  it('stop clears a scheduled start and rejects later requests', async () => {
    let started = false;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => {
        started = true;
        return Promise.resolve(completedList);
      }),
    );
    const request = { ...listRequest(), notBefore: '2026-10-19T00:00:00.050Z' };

    runner.execute(request, 'cor_123456');
    runner.stop();
    await delay(60);

    expect(started).toBe(false);
    expect(sink.facts).toHaveLength(0);
    expect(() => runner.execute(listRequest('exe_654321'), 'cor_123456')).toThrow('stopped');
  });

  it('reports STOP_UNCONFIRMED when stop happens while the Executor is running', async () => {
    let release: ((outcome: ExecutorOutcome) => void) | undefined;
    const pending = new Promise<ExecutorOutcome>((resolve) => {
      release = resolve;
    });
    const { runner, sink } = makeRunner(executor('REPOSITORY_LIST', () => pending));

    runner.execute(listRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.stop();
    const fact = await waitForFact(sink);
    release?.(completedList);
    await delay(10);

    expect(fact).toMatchObject({
      outcome: 'STOP_UNCONFIRMED',
      reasonCode: 'EXECUTION_CANCELLED',
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(sink.facts).toHaveLength(1);
  });

  it('is idempotent across repeated stop calls', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedList)), 50);

    runner.execute(listRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.stop();
    runner.stop();
    await waitForFact(sink);
    await delay(10);

    expect(sink.facts).toHaveLength(1);
    expect(sink.facts[0]).toMatchObject({ outcome: 'STOP_UNCONFIRMED' });
  });

  it('keeps the existing abort reason when stop follows a deadline', async () => {
    const { runner, sink } = makeRunnerWith(registry(hanging()), 50);
    const request = listRequest();
    request.limits = { ...request.limits, deadline: '2026-10-19T00:00:00.010Z' };

    runner.execute(request, 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    await delay(15);
    runner.stop();

    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({ outcome: 'STOP_UNCONFIRMED', reasonCode: 'UNIT_TIMEOUT' });
  });

  it('records a stop-time delivery failure without an unhandled rejection', async () => {
    const sink: { report(fact: ExecutionFact): Promise<void> } = {
      report: () => Promise.reject(new Error('stop inbox unavailable')),
    };
    const runner = new ExecutionRunner({
      executors: registry(pendingUntilAbort(completedList)),
      credentials,
      subprocess,
      sandbox: DENY_SANDBOX,
      facts: sink,
      cancelGraceMs: 50,
      killGraceMs: 50,
      now: () => new Date('2026-10-19T00:00:00.000Z'),
    });
    runners.push(runner);

    runner.execute(listRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.stop();
    await vi.waitFor(() =>
      expect(runner.healthDetails().some((line) => line.includes('stop inbox unavailable'))).toBe(
        true,
      ),
    );
  });

  it('records a fact delivery failure without retrying the execution', async () => {
    const sink: { report(fact: ExecutionFact): Promise<void> } = {
      report: () => Promise.reject(new Error('inbox unavailable')),
    };
    const runner = new ExecutionRunner({
      executors: registry(executor('REPOSITORY_LIST', () => Promise.resolve(completedList))),
      credentials,
      subprocess,
      sandbox: DENY_SANDBOX,
      facts: sink,
      cancelGraceMs: 1000,
      killGraceMs: 100,
      now: () => new Date('2026-10-19T00:00:00.000Z'),
    });
    runners.push(runner);

    runner.execute(listRequest(), 'cor_123456');
    await vi.waitFor(() =>
      expect(runner.healthDetails().some((line) => line.includes('inbox unavailable'))).toBe(true),
    );
  });

  it('cancels a scheduled execution before it starts', async () => {
    let started = false;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => {
        started = true;
        return Promise.resolve(completedList);
      }),
    );
    const request = { ...listRequest(), notBefore: '2026-10-19T00:00:00.050Z' };

    runner.execute(request, 'cor_123456');
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    const fact = await waitForFact(sink);

    expect(started).toBe(false);
    expect(fact).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
    });
    expect(fact).not.toHaveProperty('startedAt');
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });

  it('cancels a running execution and reports TERMINATED within grace', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedList)), 50);

    runner.execute(listRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    const fact = await waitForFact(sink);

    expect(fact).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });

  it('reports TERMINATED(UNIT_TIMEOUT) when the deadline aborts a running execution', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedList)), 50);
    const request = listRequest();
    request.limits = { ...request.limits, deadline: '2026-10-19T00:00:00.020Z' };

    runner.execute(request, 'cor_123456');
    const fact = await waitForFact(sink);

    expect(fact).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'UNIT_TIMEOUT',
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });

  it('does not start an Executor whose deadline is already past', async () => {
    let calls = 0;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => {
        calls += 1;
        return Promise.resolve(completedList);
      }),
    );
    const request = listRequest();
    request.limits = { ...request.limits, deadline: '2026-10-18T23:59:59.000Z' };

    runner.execute(request, 'cor_123456');
    const fact = await waitForFact(sink);

    expect(calls).toBe(0);
    expect(fact).toMatchObject({ outcome: 'TERMINATED', reasonCode: 'UNIT_TIMEOUT' });
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });

  it('treats an unparsable deadline as an immediate timeout', async () => {
    let calls = 0;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => {
        calls += 1;
        return Promise.resolve(completedList);
      }),
    );
    const request = listRequest();
    request.limits = { ...request.limits, deadline: 'not-a-timestamp' };

    runner.execute(request, 'cor_123456');
    const fact = await waitForFact(sink);

    expect(calls).toBe(0);
    expect(fact).toMatchObject({ outcome: 'TERMINATED', reasonCode: 'UNIT_TIMEOUT' });
  });

  it('is idempotent across repeated cancelRun calls', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedList)), 50);

    runner.execute(listRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 3 });
    await waitForFact(sink);
    await delay(10);

    expect(sink.facts).toHaveLength(1);
    expect(sink.facts[0]).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
    });
  });

  it('reports STOP_UNCONFIRMED when the Executor ignores abort', async () => {
    const { runner, sink } = makeRunnerWith(registry(hanging()), 20);
    const request = listRequest();
    request.limits = { ...request.limits, deadline: '2026-10-19T00:00:00.010Z' };

    runner.execute(request, 'cor_123456');
    const fact = await waitForFact(sink);

    expect(fact).toMatchObject({
      outcome: 'STOP_UNCONFIRMED',
      reasonCode: 'UNIT_TIMEOUT',
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(fact).not.toHaveProperty('usage');
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });

  it('discards a late Executor result after STOP_UNCONFIRMED', async () => {
    let release: ((outcome: ExecutorOutcome) => void) | undefined;
    const pending = new Promise<ExecutorOutcome>((resolve) => {
      release = resolve;
    });
    const { runner, sink } = makeRunnerWith(
      registry(executor('REPOSITORY_LIST', () => pending)),
      20,
    );
    const request = listRequest();
    request.limits = { ...request.limits, deadline: '2026-10-19T00:00:00.010Z' };

    runner.execute(request, 'cor_123456');
    await waitForFact(sink);
    release?.(completedList);
    await delay(10);

    expect(sink.facts).toHaveLength(1);
    expect(sink.facts[0]).toMatchObject({ outcome: 'STOP_UNCONFIRMED' });
  });

  it('keeps the first abort reason when cancel arrives after deadline', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedList)), 30);
    const request = listRequest();
    request.limits = { ...request.limits, deadline: '2026-10-19T00:00:00.010Z' };

    runner.execute(request, 'cor_123456');
    await waitForFact(sink);
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    await delay(10);

    expect(sink.facts).toHaveLength(1);
    expect(sink.facts[0]).toMatchObject({ outcome: 'TERMINATED', reasonCode: 'UNIT_TIMEOUT' });
  });

  it('preserves VIOLATION when the Executor reports it during abort', async () => {
    const violation: ExecutorOutcome = { outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' };
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(violation)), 50);

    runner.execute(listRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });

    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({ outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' });
  });

  it('reports TERMINATED when the Executor rejects during abort', async () => {
    const failing = executor('REPOSITORY_LIST', (_input, environment) => {
      if (environment.signal.aborted) return Promise.reject(new Error('aborted'));
      return new Promise<ExecutorOutcome>((_resolve, reject) => {
        environment.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    });
    const { runner, sink } = makeRunnerWith(registry(failing), 50);

    runner.execute(listRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });

    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });

  it('reports TERMINATED without Executor extras when abort receives REJECTED', async () => {
    const rejected: ExecutorOutcome = { outcome: 'REJECTED', reasonCode: 'OUT_OF_SCOPE' };
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(rejected)), 50);

    runner.execute(listRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });

    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({ outcome: 'TERMINATED', reasonCode: 'EXECUTION_CANCELLED' });
    expect(fact).not.toHaveProperty('requestState');
    expect(fact).not.toHaveProperty('usage');
  });

  it('rejects a late execute after cancelRun using the recorded epoch', async () => {
    let calls = 0;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => {
        calls += 1;
        return Promise.resolve(completedList);
      }),
    );

    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    runner.execute(listRequest('exe_654321'), 'cor_123456');
    const fact = await waitForFact(sink);

    expect(calls).toBe(0);
    expect(fact).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
      executionId: 'exe_654321',
    });
    expect(fact).not.toHaveProperty('startedAt');
  });
});

describe('ExecutionFact normalization', () => {
  const startedAt = '2026-10-19T00:00:00.000Z';
  const endedAt = '2026-10-19T00:00:01.000Z';

  it('sets SENT and preserves usage for a completed MODEL call', () => {
    const fact = toExecutionFact(modelRequest(), startedAt, endedAt, {
      outcome: 'COMPLETED',
      result: {
        output: { finishReason: 'STOP', toolCalls: [], hasText: false, hasReasoning: false },
        artifact: { mediaType: MEDIA_TYPES.modelOutput, text: '{}' },
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(fact).toMatchObject({
      executionKind: 'MODEL',
      outcome: 'COMPLETED',
      requestState: 'SENT',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('normalizes MODEL rejection to NOT_SENT and missing state to UNKNOWN', () => {
    const rejected = toExecutionFact(modelRequest(), startedAt, endedAt, {
      outcome: 'REJECTED',
      reasonCode: 'LIMIT_EXCEEDED',
    });
    expect(rejected).toMatchObject({ requestState: 'NOT_SENT' });
    expect(validate(ExecutionFactSchema, rejected).ok).toBe(true);

    const failed = toExecutionFact(modelRequest(), startedAt, endedAt, {
      outcome: 'FAILED',
      reasonCode: 'PROVIDER_ERROR',
      retryable: false,
    });
    expect(failed).toMatchObject({ requestState: 'UNKNOWN' });
    expect(validate(ExecutionFactSchema, failed).ok).toBe(true);
  });

  it('drops usage and requestState for non-MODEL outcomes', () => {
    const fact = toExecutionFact(listRequest(), startedAt, endedAt, {
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
      retryable: true,
    });
    expect(fact).not.toHaveProperty('requestState');
    expect(fact).not.toHaveProperty('usage');
  });

  it('omits startedAt for a pre-start MODEL cancellation and marks NOT_SENT', () => {
    const fact = toTerminationFact(modelRequest(), undefined, endedAt, {
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
    });
    expect(fact).toMatchObject({ requestState: 'NOT_SENT' });
    expect(fact).not.toHaveProperty('startedAt');
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });

  it('keeps MODEL usage for TERMINATED but not for STOP_UNCONFIRMED', () => {
    const terminated = toTerminationFact(modelRequest(), startedAt, endedAt, {
      outcome: 'TERMINATED',
      reasonCode: 'UNIT_TIMEOUT',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(terminated).toMatchObject({
      requestState: 'UNKNOWN',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(validate(ExecutionFactSchema, terminated).ok).toBe(true);

    const unconfirmed = toTerminationFact(modelRequest(), startedAt, endedAt, {
      outcome: 'STOP_UNCONFIRMED',
      reasonCode: 'UNIT_TIMEOUT',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(unconfirmed).not.toHaveProperty('usage');
    expect(validate(ExecutionFactSchema, unconfirmed).ok).toBe(true);
  });

  it('does not add requestState to a non-MODEL termination', () => {
    const fact = toTerminationFact(listRequest(), startedAt, endedAt, {
      outcome: 'TERMINATED',
      reasonCode: 'UNIT_TIMEOUT',
      requestState: 'UNKNOWN',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(fact).not.toHaveProperty('requestState');
    expect(fact).not.toHaveProperty('usage');
    expect(validate(ExecutionFactSchema, fact).ok).toBe(true);
  });
});

describe('Executor environment', () => {
  it('gives repository Executors no credentials or subprocess', async () => {
    const environment = createExecutorEnvironment(listRequest(), new AbortController().signal, {
      credentials,
      subprocess,
      sandbox: DENY_SANDBOX,
      now: () => new Date(),
    });
    expect(environment.credentials.apiKeyFor('deepseek')).toBeUndefined();
    await expect(
      environment.subprocess.run('rg', [], {
        cwd: '/repo',
        signal: AbortSignal.abort(),
        maxOutputBytes: 1,
      }),
    ).resolves.toEqual({ exitCode: null, signal: null, stdout: '', truncated: false });
  });

  it('gives MODEL credentials and REPOSITORY_SEARCH the real subprocess', async () => {
    const model = createExecutorEnvironment(modelRequest(), new AbortController().signal, {
      credentials,
      subprocess,
      sandbox: DENY_SANDBOX,
      now: () => new Date(),
    });
    expect(model.credentials.apiKeyFor('deepseek')).toBe('test-key');

    const search = createExecutorEnvironment(
      {
        ...listRequest(),
        executionKind: 'REPOSITORY_SEARCH',
        input: { query: 'x', mode: 'AUTO', maxItems: 10, tokenBudget: 1000 },
        limits: TOOL_LIMITS,
      },
      new AbortController().signal,
      { credentials, subprocess, sandbox: DENY_SANDBOX, now: () => new Date() },
    );
    await expect(
      search.subprocess.run('rg', [], {
        cwd: '/repo',
        signal: AbortSignal.abort(),
        maxOutputBytes: 1,
      }),
    ).resolves.toMatchObject({ stdout: 'matched' });
  });
});

describe('cancelExecution', () => {
  it('stops one running execution and says why, leaving the others alone', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedList)), 50);
    const first = listRequest('exe_000001');
    runner.execute(first, 'cor_123456');
    runner.execute(listRequest('exe_000002'), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(2));

    runner.cancelExecution({
      executionId: 'exe_000001',
      runEpoch: first.runEpoch,
      reason: 'PAUSED',
    });
    await vi.waitFor(() => expect(sink.facts).toHaveLength(1));

    expect(sink.facts[0]).toMatchObject({
      executionId: 'exe_000001',
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
      cancelReason: 'PAUSED',
      runEpoch: first.runEpoch,
    });
    expect(validate(ExecutionFactSchema, sink.facts[0]).ok).toBe(true);
    expect(runner.activeCount()).toBe(1);
  });

  it('answers an execution that has not started at once, without a start time', async () => {
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => Promise.resolve(completedList)),
    );
    const request = { ...listRequest(), notBefore: '2026-10-19T00:00:10.000Z' };
    runner.execute(request, 'cor_123456');

    runner.cancelExecution({
      executionId: request.executionId,
      runEpoch: request.runEpoch,
      reason: 'ABORTED',
    });
    const fact = await waitForFact(sink);

    expect(fact).toMatchObject({ outcome: 'TERMINATED', cancelReason: 'ABORTED' });
    expect(fact).not.toHaveProperty('startedAt');
  });

  it('reports a cancelled execution once, however often it is asked', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedList)), 50);
    const request = listRequest();
    runner.execute(request, 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));

    for (const reason of ['ABORTED', 'PAUSED'] as const)
      runner.cancelExecution({
        executionId: request.executionId,
        runEpoch: request.runEpoch,
        reason,
      });
    await delay(80);

    expect(sink.facts).toHaveLength(1);
    // The first reason stays: a pause that turns into an abort is Core's to say, not the fact's.
    expect(sink.facts[0]).toMatchObject({ cancelReason: 'ABORTED' });
  });

  it.each([
    ['an unknown execution', { executionId: 'exe_999999' }],
    ['an execution of another epoch', { runEpoch: 99 }],
  ])('ignores %s', async (_name, over) => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedList)), 50);
    const request = listRequest();
    runner.execute(request, 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));

    runner.cancelExecution({
      executionId: request.executionId,
      runEpoch: request.runEpoch,
      reason: 'ABORTED',
      ...over,
    });
    await delay(80);

    expect(sink.facts).toEqual([]);
    expect(runner.activeCount()).toBe(1);
  });

  it('does not touch an execution that already ended', async () => {
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_LIST', () => Promise.resolve(completedList)),
    );
    const request = listRequest();
    runner.execute(request, 'cor_123456');
    await waitForFact(sink);

    runner.cancelExecution({
      executionId: request.executionId,
      runEpoch: request.runEpoch,
      reason: 'ABORTED',
    });
    await delay(20);

    expect(sink.facts).toHaveLength(1);
    expect(sink.facts[0]).toMatchObject({ outcome: 'COMPLETED' });
  });

  it('still escalates to STOP_UNCONFIRMED when the Executor will not stop', async () => {
    const { runner, sink } = makeRunnerWith(registry(hanging()), 40);
    const request = listRequest();
    runner.execute(request, 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));

    runner.cancelExecution({
      executionId: request.executionId,
      runEpoch: request.runEpoch,
      reason: 'ABORTED',
    });
    const fact = await waitForFact(sink);

    expect(fact).toMatchObject({ outcome: 'STOP_UNCONFIRMED', reasonCode: 'EXECUTION_CANCELLED' });
  });
});
