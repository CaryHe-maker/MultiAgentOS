import {
  canonicalJson,
  createM1ProtocolRegistry,
  MEDIA_TYPES,
  sha256Hex,
  type ArtifactRef,
  type ArtifactStorePort,
  type AssembleContextPack,
  type CapabilityDescriptor,
  type ExecutionFact,
  type ExecutionRequest,
  type PinnedDefinitionSet,
  type UnitDefinition,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { CoreAttempts, createRunState, type CoreAuditEntry, type CoreEvent } from './core/index.js';
import { ArtifactOwnership, Execution, type AttemptDispatcher } from './execution/index.js';
import {
  DEFAULT_KERNEL_CONFIG,
  type AttemptSpec,
  type BudgetConfig,
  type KernelConfig,
} from './interfaces/index.js';
import { Monitor } from './monitor/index.js';
import { InProcessProviderCapacity, Scheduler } from './scheduler/index.js';

const sha = 'a'.repeat(64);

function modelUnit(): UnitDefinition {
  return {
    schemaVersion: 'v0',
    kind: 'UNIT',
    id: 'model-call',
    version: 'v0.1.0',
    digest: 'd'.repeat(64),
    description: 'model',
    executionKind: 'MODEL',
    protectedCapabilities: [],
    inputContract: { kind: 'contract', id: 'executor.ModelCallInput', version: 'v0' },
    outputContract: { kind: 'contract', id: 'executor.ModelCallOutput', version: 'v0' },
    toolRefs: [],
    effect: 'READ_ONLY',
    isIdempotent: false,
    failurePolicy: {},
  };
}

function pinnedSet(contextWindowTokens = 128_000): PinnedDefinitionSet {
  return {
    model: { limits: { contextWindowTokens, maxOutputTokens: 8_192 } },
  } as unknown as PinnedDefinitionSet;
}

function assemblePack(tokenBudget: number, content?: string): AssembleContextPack {
  return {
    contextPackId: 'ctx_000001',
    operation: 'ASSEMBLE',
    tokenCount: 0,
    tokenBudget,
    truncated: false,
    droppedCount: 0,
    prefixSha256: sha,
    items:
      content === undefined
        ? []
        : [
            {
              itemId: 'ctx_000001:0',
              segment: 'INSTRUCTIONS',
              role: 'system',
              content,
              contentSha256: sha256Hex(content),
              tokenCount: 0,
              reason: 'budget fixture',
            },
          ],
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

class FakeArtifactStore implements ArtifactStorePort {
  readonly #objects = new Map<string, Uint8Array>();

  public put(workflowRunId: string, content: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    const digest = sha256Hex(content);
    this.#objects.set(`${workflowRunId}:${digest}`, content);
    return Promise.resolve({
      artifactId: `art_${digest}`,
      mediaType,
      sha256: digest,
      size: content.byteLength,
    });
  }

  public get(workflowRunId: string, ref: ArtifactRef): Promise<Uint8Array> {
    const content = this.#objects.get(`${workflowRunId}:${ref.sha256}`);
    if (content === undefined) return Promise.reject(new Error('artifact is missing'));
    return Promise.resolve(content);
  }

  public capabilities(): readonly CapabilityDescriptor[] {
    return [];
  }
}

class RecordingDispatcher implements AttemptDispatcher {
  public readonly requests: ExecutionRequest[] = [];

  public dispatch(request: ExecutionRequest): void {
    this.requests.push(request);
  }
}

interface Harness {
  readonly config: KernelConfig;
  readonly run: ReturnType<typeof createRunState>;
  readonly monitor: Monitor;
  readonly scheduler: Scheduler;
  readonly capacity: InProcessProviderCapacity;
  readonly attempts: CoreAttempts;
  readonly execution: Execution;
  readonly dispatcher: RecordingDispatcher;
  readonly artifacts: FakeArtifactStore;
  readonly ownership: ArtifactOwnership;
  readonly events: CoreEvent[];
  readonly audits: CoreAuditEntry[];
}

function harness(options: { readonly budget?: BudgetConfig } = {}): Harness {
  const config: KernelConfig = {
    ...DEFAULT_KERNEL_CONFIG,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  };
  const run = createRunState({
    workflowRunId: 'wfr_123456',
    correlationId: 'cor_123456',
    goal: 'analyze',
    repositoryRoot: '/repo',
    startedAt: '2026-10-19T00:00:00.000Z',
  });
  const monitor = new Monitor(config.budget);
  const capacity = new InProcessProviderCapacity();
  const scheduler = new Scheduler(capacity);
  const events: CoreEvent[] = [];
  const audits: CoreAuditEntry[] = [];
  const artifacts = new FakeArtifactStore();
  const ownership = new ArtifactOwnership();
  const dispatcher = new RecordingDispatcher();
  const now = (): Date => new Date('2026-10-19T00:00:00.000Z');
  const executionHolder: { current?: Execution } = {};
  let attemptSequence = 0;
  let executionSequence = 0;

  const attempts = new CoreAttempts({
    run,
    execution: {
      createAttempt: (spec) => {
        const current = executionHolder.current;
        if (current === undefined) throw new Error('Execution is not assembled yet');
        return current.createAttempt(spec);
      },
    },
    monitor,
    scheduler,
    audit: {
      append: (entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    },
    events: { emit: (event) => events.push(event) },
    provider: config.provider,
    technicalRetryLimit: config.technicalRetryLimit,
    now,
    leaseIsValid: () => true,
    onViolation: () => undefined,
    onStopUnconfirmed: () => undefined,
    onKernelInternal: () => undefined,
  });

  const execution = new Execution({
    core: attempts,
    dispatcher,
    workflowRunId: run.workflowRunId,
    artifacts,
    config,
    registry: createM1ProtocolRegistry(),
    ownership,
    now,
    newAttemptId: () => `una_${String((attemptSequence += 1)).padStart(6, '0')}`,
    newExecutionId: () => `exe_${String((executionSequence += 1)).padStart(6, '0')}`,
  });
  executionHolder.current = execution;

  return {
    config,
    run,
    monitor,
    scheduler,
    capacity,
    attempts,
    execution,
    dispatcher,
    artifacts,
    ownership,
    events,
    audits,
  };
}

async function modelSpec(
  test: Harness,
  requestId: string,
  final: boolean,
  content?: string,
  contextWindowTokens = 128_000,
): Promise<AttemptSpec> {
  const tokenBudget = final
    ? test.config.budget.finalInputBudget
    : test.config.budget.perCallInputLimit;
  const contextPackRef = await test.artifacts.put(
    test.run.workflowRunId,
    Buffer.from(canonicalJson(assemblePack(tokenBudget, content)), 'utf8'),
    MEDIA_TYPES.contextPack,
  );
  test.ownership.register(contextPackRef, 'seed');
  return {
    requestId,
    agentRunId: 'agr_123456',
    unit: modelUnit(),
    input: { contextPackRef, final },
    scope: {
      kind: 'MODEL',
      provider: 'deepseek',
      apiModelId: 'deepseek-flash',
      apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
      baseUrl: 'https://api.deepseek.com',
      thinking: 'DISABLED',
    },
    pinned: pinnedSet(contextWindowTokens),
    runEpoch: 1,
  };
}

function completedModelFact(
  unitAttemptId: string,
  executionId: string,
  usage: { inputTokens: number; outputTokens: number },
): ExecutionFact {
  return {
    workflowRunId: 'wfr_123456',
    unitAttemptId,
    executionId,
    runEpoch: 1,
    executionKind: 'MODEL',
    outcome: 'COMPLETED',
    result: {
      output: { finishReason: 'STOP', toolCalls: [], hasText: false },
      artifact: { mediaType: MEDIA_TYPES.modelOutput, text: '{"finishReason":"STOP"}' },
    },
    requestState: 'SENT',
    usage,
    startedAt: '2026-10-19T00:00:01.000Z',
    endedAt: '2026-10-19T00:00:02.000Z',
  };
}

function stopModelFact(unitAttemptId: string, executionId: string): ExecutionFact {
  return {
    workflowRunId: 'wfr_123456',
    unitAttemptId,
    executionId,
    runEpoch: 1,
    executionKind: 'MODEL',
    outcome: 'STOP_UNCONFIRMED',
    reasonCode: 'UNIT_TIMEOUT',
    requestState: 'UNKNOWN',
    startedAt: '2026-10-19T00:00:01.000Z',
    endedAt: '2026-10-19T00:00:02.000Z',
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Execution budget and capacity integration', () => {
  it('reserves, settles and releases a successful MODEL execution', async () => {
    const test = harness();
    const unitAttemptId = await test.attempts.startAttempt(
      await modelSpec(test, 'req_000001', false),
    );
    await flush();
    expect(test.dispatcher.requests).toHaveLength(1);

    const executionId = test.dispatcher.requests[0]?.executionId ?? '';
    await test.execution.handleExecutionFact(
      completedModelFact(unitAttemptId, executionId, {
        inputTokens: 100,
        outputTokens: 50,
      }),
    );

    expect(test.monitor.finalize()).toMatchObject({
      used: 150,
      unknown: 0,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(test.scheduler.releaseAll()).toBe(0);
  });

  it('rejects an ordinary reservation at the hard threshold and releases capacity', async () => {
    const budget: BudgetConfig = {
      tokenLimit: 2_500,
      perCallInputLimit: 1_800,
      finalInputBudget: 500,
      maxOutputTokens: 100,
      finalMaxOutputTokens: 100,
      orientBudget: 100,
      searchBudget: 100,
    };
    const test = harness({ budget });
    const unitAttemptId = await test.attempts.startAttempt(
      await modelSpec(test, 'req_000001', false, 'x'.repeat(2_000)),
    );
    await flush();

    expect(test.dispatcher.requests).toHaveLength(0);
    expect(test.scheduler.releaseAll()).toBe(0);
    expect(test.monitor.budgetState()).toBe('WRAP_UP');
    expect(test.run.units.rejected).toBe(1);
    expect(unitAttemptId).toMatch(/^una_/u);
  });

  it('still allows the final call after ordinary usage reaches WRAP_UP', async () => {
    const budget: BudgetConfig = {
      tokenLimit: 100,
      perCallInputLimit: 20,
      finalInputBudget: 20,
      maxOutputTokens: 10,
      finalMaxOutputTokens: 10,
      orientBudget: 10,
      searchBudget: 10,
    };
    const test = harness({ budget });
    const ordinary = await test.attempts.startAttempt(await modelSpec(test, 'req_000001', false));
    await flush();
    await test.execution.handleExecutionFact(
      completedModelFact(ordinary, test.dispatcher.requests[0]?.executionId ?? '', {
        inputTokens: 60,
        outputTokens: 10,
      }),
    );
    expect(test.monitor.budgetState()).toBe('WRAP_UP');

    await test.attempts.startAttempt(await modelSpec(test, 'req_000002', true));
    await flush();
    expect(test.dispatcher.requests).toHaveLength(2);
    expect(test.dispatcher.requests[1]?.executionKind).toBe('MODEL');
    expect(test.dispatcher.requests[1]?.input).toMatchObject({ final: true });
  });

  it('reports a settlement anomaly when actual usage exceeds the estimate', async () => {
    const budget: BudgetConfig = {
      tokenLimit: 100,
      perCallInputLimit: 20,
      finalInputBudget: 20,
      maxOutputTokens: 10,
      finalMaxOutputTokens: 10,
      orientBudget: 10,
      searchBudget: 10,
    };
    const test = harness({ budget });
    const unitAttemptId = await test.attempts.startAttempt(
      await modelSpec(test, 'req_000001', false),
    );
    await flush();
    await test.execution.handleExecutionFact(
      completedModelFact(unitAttemptId, test.dispatcher.requests[0]?.executionId ?? '', {
        inputTokens: 60,
        outputTokens: 15,
      }),
    );

    expect(test.audits.some((entry) => entry.type === 'SETTLEMENT_ANOMALY')).toBe(true);
    expect(test.monitor.finalize()).toMatchObject({ used: 75, finalBudgetState: 'EXHAUSTED' });
  });

  it('keeps a STOP_UNCONFIRMED reservation until finalization and releases it there', async () => {
    const test = harness();
    const unitAttemptId = await test.attempts.startAttempt(
      await modelSpec(test, 'req_000001', false),
    );
    await flush();
    await test.execution.handleExecutionFact(
      stopModelFact(unitAttemptId, test.dispatcher.requests[0]?.executionId ?? ''),
    );

    expect(test.scheduler.releaseAll()).toBe(1);
    expect(test.monitor.finalize()).toMatchObject({ unknown: 8_192 });
  });

  it('shares provider capacity across two Scheduler instances', () => {
    const capacity = new InProcessProviderCapacity();
    const first = new Scheduler(capacity);
    const second = new Scheduler(capacity);
    const firstGrant = first.acquire('deepseek');
    expect(firstGrant.ok).toBe(true);
    expect(second.acquire('deepseek')).toEqual({ ok: false });
    if (firstGrant.ok) first.release(firstGrant.grantId);
    expect(second.acquire('deepseek')).toMatchObject({ ok: true });
  });
});
