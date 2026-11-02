import {
  ExecutionFactV1Schema,
  MEDIA_TYPES,
  validate,
  type ExecutionFactV1,
  type ExecutionRequestV1,
  type ExecutorV1,
  type ExecutorKindV1,
  type ExecutorOutcomeV1,
  type ExecutorRegistryV1,
  type ProviderCredentials,
  type SubprocessRunner,
} from '@multiagentos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutorEnvironment } from './environment.js';
import { ExecutionRunner } from './execution-runner.js';
import { toExecutionFact, toTerminationFact } from './fact-mapper.js';

type OrientRequest = Extract<ExecutionRequestV1, { executionKind: 'REPOSITORY_ORIENT' }>;
type ModelRequest = Extract<ExecutionRequestV1, { executionKind: 'MODEL' }>;

const SHA = 'a'.repeat(64);
const TOOL_LIMITS = {
  deadline: '2026-10-19T01:00:00.000Z',
  maxOutputBytes: 1024,
  preview: { maxBytes: 1024, maxLines: 100 },
  maxFullOutputBytes: 4096,
};
const completedOrient: ExecutorOutcomeV1 = {
  outcome: 'COMPLETED',
  result: {
    output: {
      snapshotId: `snp_${SHA}`,
      fileCount: 0,
      totalBytes: 0,
      summary: 'empty',
      tokenCount: 0,
      truncated: false,
    },
    artifact: { mediaType: MEDIA_TYPES.contextPack, text: '{}' },
  },
};

class RecordingSink {
  public readonly facts: ExecutionFactV1[] = [];

  public report(fact: ExecutionFactV1): Promise<void> {
    this.facts.push(fact);
    return Promise.resolve();
  }
}

const runners: ExecutionRunner[] = [];
afterEach(() => {
  for (const runner of runners.splice(0)) runner.stop();
});

function orientRequest(executionId = 'exe_123456'): OrientRequest {
  return {
    sessionId: 'ses_123456',
    workflowRunId: 'wfr_123456',
    unitAttemptId: 'una_123456',
    executionId,
    runEpoch: 1,
    executionKind: 'REPOSITORY_ORIENT',
    input: { objective: 'analyze', tokenBudget: 4000 },
    scope: { kind: 'REPOSITORY', repositoryRoot: '/repo', exclusions: [] },
    limits: {
      deadline: '2026-10-19T01:00:00.000Z',
      maxOutputBytes: 1024,
      preview: { maxBytes: 1024, maxLines: 100 },
      maxFullOutputBytes: 4096,
      maxFiles: 10,
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

function requestFor(kind: ExecutorKindV1): ExecutionRequestV1 {
  switch (kind) {
    case 'REPOSITORY_ORIENT':
      return orientRequest();
    case 'REPOSITORY_SEARCH':
      return {
        ...orientRequest(),
        executionKind: 'REPOSITORY_SEARCH',
        input: { query: 'x', mode: 'AUTO', maxItems: 10, tokenBudget: 1000 },
        limits: TOOL_LIMITS,
      };
    case 'REPOSITORY_LIST':
      return {
        ...orientRequest(),
        executionKind: 'REPOSITORY_LIST',
        input: {},
        limits: TOOL_LIMITS,
      };
    case 'FILE_READ':
      return {
        ...orientRequest(),
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
            budget: { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' },
          },
        },
        scope: { kind: 'NONE' },
        limits: { deadline: '2026-10-19T01:00:00.000Z', maxOutputBytes: 1024 },
      };
    case 'MODEL':
      return modelRequest();
  }
}

function completedFor(kind: ExecutorKindV1): ExecutorOutcomeV1 {
  switch (kind) {
    case 'REPOSITORY_ORIENT':
      return completedOrient;
    case 'REPOSITORY_SEARCH':
      return {
        outcome: 'COMPLETED',
        result: {
          output: { snapshotId: `snp_${SHA}`, hits: [], truncated: false },
          artifact: { mediaType: MEDIA_TYPES.contextPack, text: '{}' },
        },
      };
    case 'REPOSITORY_LIST':
      return {
        outcome: 'COMPLETED',
        result: {
          output: { path: '.', directoryCount: 0, fileCount: 0, omittedEntries: 0 },
          artifact: { mediaType: MEDIA_TYPES.fileText, text: '' },
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
  }
}

const credentials: ProviderCredentials = {
  apiKeyFor: (provider) => (provider === 'deepseek' ? 'test-key' : undefined),
};

const subprocess: SubprocessRunner = {
  run: () => Promise.resolve({ exitCode: 0, signal: null, stdout: 'matched', truncated: false }),
};

function executor<K extends ExecutorKindV1>(
  kind: K,
  execute: ExecutorV1<K>['execute'],
): ExecutorV1<K> {
  return { executionKind: kind, execute };
}

function registry(orient: ExecutorV1<'REPOSITORY_ORIENT'>): ExecutorRegistryV1 {
  const unused = <K extends ExecutorKindV1>(kind: K): ExecutorV1<K> =>
    executor(kind, () => Promise.resolve({ outcome: 'REJECTED', reasonCode: 'OUT_OF_SCOPE' }));
  return {
    REPOSITORY_ORIENT: orient,
    REPOSITORY_SEARCH: unused('REPOSITORY_SEARCH'),
    REPOSITORY_LIST: unused('REPOSITORY_LIST'),
    FILE_READ: unused('FILE_READ'),
    CONTEXT_ASSEMBLE: unused('CONTEXT_ASSEMBLE'),
    MODEL: unused('MODEL'),
  };
}

function makeRunner(orient: ExecutorV1<'REPOSITORY_ORIENT'>): {
  readonly runner: ExecutionRunner;
  readonly sink: RecordingSink;
} {
  return makeRunnerWith(registry(orient));
}

function makeRunnerWith(
  executors: ExecutorRegistryV1,
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
    facts: sink,
    cancelGraceMs,
    now: () => new Date('2026-10-19T00:00:00.000Z'),
  });
  runners.push(runner);
  return { runner, sink };
}

function registryFor<K extends ExecutorKindV1>(kind: K, target: ExecutorV1<K>): ExecutorRegistryV1 {
  const base = registry(executor('REPOSITORY_ORIENT', () => Promise.resolve(completedOrient)));
  return { ...base, [kind]: target };
}

function pendingUntilAbort(outcome: ExecutorOutcomeV1): ExecutorV1<'REPOSITORY_ORIENT'> {
  return executor('REPOSITORY_ORIENT', (_input, environment) => {
    if (environment.signal.aborted) return Promise.resolve(outcome);
    return new Promise((resolve) => {
      environment.signal.addEventListener('abort', () => resolve(outcome), { once: true });
    });
  });
}

function hanging(): ExecutorV1<'REPOSITORY_ORIENT'> {
  return executor('REPOSITORY_ORIENT', () => new Promise(() => undefined));
}

async function waitForFact(sink: RecordingSink): Promise<ExecutionFactV1> {
  await vi.waitFor(() => expect(sink.facts).toHaveLength(1));
  return sink.facts[0] as ExecutionFactV1;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ExecutionRunner', () => {
  it('accepts before starting and reports a completed fact', async () => {
    let started = false;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_ORIENT', () => {
        started = true;
        return Promise.resolve(completedOrient);
      }),
    );

    runner.execute(orientRequest(), 'cor_123456');
    expect(started).toBe(false);

    await vi.waitFor(() => expect(started).toBe(true));
    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({
      outcome: 'COMPLETED',
      executionKind: 'REPOSITORY_ORIENT',
      workflowRunId: 'wfr_123456',
      unitAttemptId: 'una_123456',
      executionId: 'exe_123456',
      runEpoch: 1,
      startedAt: '2026-10-19T00:00:00.000Z',
      endedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
  });

  it('honours notBefore before starting the Executor', async () => {
    let started = false;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_ORIENT', () => {
        started = true;
        return Promise.resolve(completedOrient);
      }),
    );
    const request = { ...orientRequest(), notBefore: '2026-10-19T00:00:00.050Z' };

    runner.execute(request, 'cor_123456');
    await delay(10);
    expect(started).toBe(false);

    await vi.waitFor(() => expect(started).toBe(true));
    const fact = await waitForFact(sink);
    expect(fact.outcome).toBe('COMPLETED');
  });

  it.each<ExecutorOutcomeV1>([
    completedOrient,
    { outcome: 'REJECTED', reasonCode: 'OUT_OF_SCOPE' },
    { outcome: 'FAILED', reasonCode: 'INTERNAL', retryable: true },
    { outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' },
  ])('maps the normal Executor outcome %# without duplicates', async (outcome) => {
    let calls = 0;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_ORIENT', () => {
        calls += 1;
        return Promise.resolve(outcome);
      }),
    );

    runner.execute(orientRequest(), 'cor_123456');
    const fact = await waitForFact(sink);
    expect(fact.outcome).toBe(outcome.outcome);
    expect(calls).toBe(1);
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
    expect(sink.facts).toHaveLength(1);
  });

  it('normalizes an Executor throw to FAILED(INTERNAL, retryable=false)', async () => {
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_ORIENT', () => Promise.reject(new Error('boom'))),
    );

    runner.execute(orientRequest(), 'cor_123456');
    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
      retryable: false,
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
  });

  it('ignores a duplicate executionId and reports one fact', async () => {
    let calls = 0;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_ORIENT', () => {
        calls += 1;
        return Promise.resolve(completedOrient);
      }),
    );

    const request = orientRequest();
    runner.execute(request, 'cor_123456');
    runner.execute(request, 'cor_123456');
    await waitForFact(sink);

    expect(calls).toBe(1);
    expect(sink.facts).toHaveLength(1);
  });

  it.each<ExecutorKindV1>([
    'REPOSITORY_ORIENT',
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
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
  });

  it('turns a missing executor into FAILED(INTERNAL)', async () => {
    const { runner, sink } = makeRunnerWith({} as ExecutorRegistryV1);
    runner.execute(orientRequest(), 'cor_123456');
    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({ outcome: 'FAILED', reasonCode: 'INTERNAL', retryable: false });
  });

  it('stop clears a scheduled start and rejects later requests', async () => {
    let started = false;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_ORIENT', () => {
        started = true;
        return Promise.resolve(completedOrient);
      }),
    );
    const request = { ...orientRequest(), notBefore: '2026-10-19T00:00:00.050Z' };

    runner.execute(request, 'cor_123456');
    runner.stop();
    await delay(60);

    expect(started).toBe(false);
    expect(sink.facts).toHaveLength(0);
    expect(() => runner.execute(orientRequest('exe_654321'), 'cor_123456')).toThrow('stopped');
  });

  it('reports STOP_UNCONFIRMED when stop happens while the Executor is running', async () => {
    let release: ((outcome: ExecutorOutcomeV1) => void) | undefined;
    const pending = new Promise<ExecutorOutcomeV1>((resolve) => {
      release = resolve;
    });
    const { runner, sink } = makeRunner(executor('REPOSITORY_ORIENT', () => pending));

    runner.execute(orientRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.stop();
    const fact = await waitForFact(sink);
    release?.(completedOrient);
    await delay(10);

    expect(fact).toMatchObject({
      outcome: 'STOP_UNCONFIRMED',
      reasonCode: 'EXECUTION_CANCELLED',
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(sink.facts).toHaveLength(1);
  });

  it('is idempotent across repeated stop calls', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedOrient)), 50);

    runner.execute(orientRequest(), 'cor_123456');
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
    const request = orientRequest();
    request.limits = { ...request.limits, deadline: '2026-10-19T00:00:00.010Z' };

    runner.execute(request, 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    await delay(15);
    runner.stop();

    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({ outcome: 'STOP_UNCONFIRMED', reasonCode: 'UNIT_TIMEOUT' });
  });

  it('records a stop-time delivery failure without an unhandled rejection', async () => {
    const sink: { report(fact: ExecutionFactV1): Promise<void> } = {
      report: () => Promise.reject(new Error('stop inbox unavailable')),
    };
    const runner = new ExecutionRunner({
      executors: registry(pendingUntilAbort(completedOrient)),
      credentials,
      subprocess,
      facts: sink,
      cancelGraceMs: 50,
      now: () => new Date('2026-10-19T00:00:00.000Z'),
    });
    runners.push(runner);

    runner.execute(orientRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.stop();
    await vi.waitFor(() =>
      expect(runner.healthDetails().some((line) => line.includes('stop inbox unavailable'))).toBe(
        true,
      ),
    );
  });

  it('records a fact delivery failure without retrying the execution', async () => {
    const sink: { report(fact: ExecutionFactV1): Promise<void> } = {
      report: () => Promise.reject(new Error('inbox unavailable')),
    };
    const runner = new ExecutionRunner({
      executors: registry(executor('REPOSITORY_ORIENT', () => Promise.resolve(completedOrient))),
      credentials,
      subprocess,
      facts: sink,
      cancelGraceMs: 1000,
      now: () => new Date('2026-10-19T00:00:00.000Z'),
    });
    runners.push(runner);

    runner.execute(orientRequest(), 'cor_123456');
    await vi.waitFor(() =>
      expect(runner.healthDetails().some((line) => line.includes('inbox unavailable'))).toBe(true),
    );
  });

  it('cancels a scheduled execution before it starts', async () => {
    let started = false;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_ORIENT', () => {
        started = true;
        return Promise.resolve(completedOrient);
      }),
    );
    const request = { ...orientRequest(), notBefore: '2026-10-19T00:00:00.050Z' };

    runner.execute(request, 'cor_123456');
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    const fact = await waitForFact(sink);

    expect(started).toBe(false);
    expect(fact).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
    });
    expect(fact).not.toHaveProperty('startedAt');
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
  });

  it('cancels a running execution and reports TERMINATED within grace', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedOrient)), 50);

    runner.execute(orientRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    const fact = await waitForFact(sink);

    expect(fact).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
  });

  it('reports TERMINATED(UNIT_TIMEOUT) when the deadline aborts a running execution', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedOrient)), 50);
    const request = orientRequest();
    request.limits = { ...request.limits, deadline: '2026-10-19T00:00:00.020Z' };

    runner.execute(request, 'cor_123456');
    const fact = await waitForFact(sink);

    expect(fact).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'UNIT_TIMEOUT',
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
  });

  it('does not start an Executor whose deadline is already past', async () => {
    let calls = 0;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_ORIENT', () => {
        calls += 1;
        return Promise.resolve(completedOrient);
      }),
    );
    const request = orientRequest();
    request.limits = { ...request.limits, deadline: '2026-10-18T23:59:59.000Z' };

    runner.execute(request, 'cor_123456');
    const fact = await waitForFact(sink);

    expect(calls).toBe(0);
    expect(fact).toMatchObject({ outcome: 'TERMINATED', reasonCode: 'UNIT_TIMEOUT' });
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
  });

  it('treats an unparsable deadline as an immediate timeout', async () => {
    let calls = 0;
    const { runner, sink } = makeRunner(
      executor('REPOSITORY_ORIENT', () => {
        calls += 1;
        return Promise.resolve(completedOrient);
      }),
    );
    const request = orientRequest();
    request.limits = { ...request.limits, deadline: 'not-a-timestamp' };

    runner.execute(request, 'cor_123456');
    const fact = await waitForFact(sink);

    expect(calls).toBe(0);
    expect(fact).toMatchObject({ outcome: 'TERMINATED', reasonCode: 'UNIT_TIMEOUT' });
  });

  it('is idempotent across repeated cancelRun calls', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedOrient)), 50);

    runner.execute(orientRequest(), 'cor_123456');
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
    const request = orientRequest();
    request.limits = { ...request.limits, deadline: '2026-10-19T00:00:00.010Z' };

    runner.execute(request, 'cor_123456');
    const fact = await waitForFact(sink);

    expect(fact).toMatchObject({
      outcome: 'STOP_UNCONFIRMED',
      reasonCode: 'UNIT_TIMEOUT',
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(fact).not.toHaveProperty('usage');
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
  });

  it('discards a late Executor result after STOP_UNCONFIRMED', async () => {
    let release: ((outcome: ExecutorOutcomeV1) => void) | undefined;
    const pending = new Promise<ExecutorOutcomeV1>((resolve) => {
      release = resolve;
    });
    const { runner, sink } = makeRunnerWith(
      registry(executor('REPOSITORY_ORIENT', () => pending)),
      20,
    );
    const request = orientRequest();
    request.limits = { ...request.limits, deadline: '2026-10-19T00:00:00.010Z' };

    runner.execute(request, 'cor_123456');
    await waitForFact(sink);
    release?.(completedOrient);
    await delay(10);

    expect(sink.facts).toHaveLength(1);
    expect(sink.facts[0]).toMatchObject({ outcome: 'STOP_UNCONFIRMED' });
  });

  it('keeps the first abort reason when cancel arrives after deadline', async () => {
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(completedOrient)), 30);
    const request = orientRequest();
    request.limits = { ...request.limits, deadline: '2026-10-19T00:00:00.010Z' };

    runner.execute(request, 'cor_123456');
    await waitForFact(sink);
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    await delay(10);

    expect(sink.facts).toHaveLength(1);
    expect(sink.facts[0]).toMatchObject({ outcome: 'TERMINATED', reasonCode: 'UNIT_TIMEOUT' });
  });

  it('preserves VIOLATION when the Executor reports it during abort', async () => {
    const violation: ExecutorOutcomeV1 = { outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' };
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(violation)), 50);

    runner.execute(orientRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });

    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({ outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' });
  });

  it('reports TERMINATED when the Executor rejects during abort', async () => {
    const failing = executor('REPOSITORY_ORIENT', (_input, environment) => {
      if (environment.signal.aborted) return Promise.reject(new Error('aborted'));
      return new Promise<ExecutorOutcomeV1>((_resolve, reject) => {
        environment.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    });
    const { runner, sink } = makeRunnerWith(registry(failing), 50);

    runner.execute(orientRequest(), 'cor_123456');
    await vi.waitFor(() => expect(runner.activeCount()).toBe(1));
    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });

    const fact = await waitForFact(sink);
    expect(fact).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
  });

  it('reports TERMINATED without Executor extras when abort receives REJECTED', async () => {
    const rejected: ExecutorOutcomeV1 = { outcome: 'REJECTED', reasonCode: 'OUT_OF_SCOPE' };
    const { runner, sink } = makeRunnerWith(registry(pendingUntilAbort(rejected)), 50);

    runner.execute(orientRequest(), 'cor_123456');
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
      executor('REPOSITORY_ORIENT', () => {
        calls += 1;
        return Promise.resolve(completedOrient);
      }),
    );

    runner.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    runner.execute(orientRequest('exe_654321'), 'cor_123456');
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

describe('ExecutionFactV1 normalization', () => {
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
    expect(validate(ExecutionFactV1Schema, rejected).ok).toBe(true);

    const failed = toExecutionFact(modelRequest(), startedAt, endedAt, {
      outcome: 'FAILED',
      reasonCode: 'PROVIDER_ERROR',
      retryable: false,
    });
    expect(failed).toMatchObject({ requestState: 'UNKNOWN' });
    expect(validate(ExecutionFactV1Schema, failed).ok).toBe(true);
  });

  it('drops usage and requestState for non-MODEL outcomes', () => {
    const fact = toExecutionFact(orientRequest(), startedAt, endedAt, {
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
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
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
    expect(validate(ExecutionFactV1Schema, terminated).ok).toBe(true);

    const unconfirmed = toTerminationFact(modelRequest(), startedAt, endedAt, {
      outcome: 'STOP_UNCONFIRMED',
      reasonCode: 'UNIT_TIMEOUT',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(unconfirmed).not.toHaveProperty('usage');
    expect(validate(ExecutionFactV1Schema, unconfirmed).ok).toBe(true);
  });

  it('does not add requestState to a non-MODEL termination', () => {
    const fact = toTerminationFact(orientRequest(), startedAt, endedAt, {
      outcome: 'TERMINATED',
      reasonCode: 'UNIT_TIMEOUT',
      requestState: 'UNKNOWN',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(fact).not.toHaveProperty('requestState');
    expect(fact).not.toHaveProperty('usage');
    expect(validate(ExecutionFactV1Schema, fact).ok).toBe(true);
  });
});

describe('Executor environment', () => {
  it('gives repository Executors no credentials or subprocess', async () => {
    const environment = createExecutorEnvironment(orientRequest(), new AbortController().signal, {
      credentials,
      subprocess,
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
      now: () => new Date(),
    });
    expect(model.credentials.apiKeyFor('deepseek')).toBe('test-key');

    const search = createExecutorEnvironment(
      {
        ...orientRequest(),
        executionKind: 'REPOSITORY_SEARCH',
        input: { query: 'x', mode: 'AUTO', maxItems: 10, tokenBudget: 1000 },
        limits: TOOL_LIMITS,
      },
      new AbortController().signal,
      { credentials, subprocess, now: () => new Date() },
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
