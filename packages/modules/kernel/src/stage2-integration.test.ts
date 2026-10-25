import {
  canonicalJson,
  createM1ProtocolRegistry,
  MEDIA_TYPES,
  sha256Hex,
  type AgentDefinition,
  type AnalysisReport,
  type ArtifactRef,
  type ArtifactStorePort,
  type AssembleContextPack,
  type BoundaryContext,
  type CapabilityDescriptor,
  type CatalogPort,
  type ExecutionFact,
  type ExecutionRequest,
  type ModelDefinition,
  type PinnedDefinitionSet,
  type PromptDefinition,
  type UnitDefinition,
  type UnitReport,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import {
  CoreRequestHandler,
  createRunState,
  type CoreAuditEntry,
  type CoreEvent,
  type RunResponse,
} from './core/index.js';
import { ArtifactOwnership, Execution, type AttemptDispatcher } from './execution/index.js';
import { DEFAULT_KERNEL_CONFIG, type KernelConfig } from './interfaces/index.js';
import { Monitor } from './monitor/index.js';
import { InProcessProviderCapacity, Scheduler } from './scheduler/index.js';

const sha = 'a'.repeat(64);
const agentDigest = 'd'.repeat(64);

function modelUnit(): UnitDefinition {
  return {
    schemaVersion: 'v0',
    kind: 'UNIT',
    id: 'model-call',
    version: 'v0.1.0',
    digest: 'b'.repeat(64),
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

function reportUnit(): UnitDefinition {
  return {
    schemaVersion: 'v0',
    kind: 'UNIT',
    id: 'report-publish',
    version: 'v0.1.0',
    digest: 'c'.repeat(64),
    description: 'report',
    executionKind: 'REPORT_PUBLISH',
    protectedCapabilities: [],
    inputContract: { kind: 'contract', id: 'kernel.unit.ReportPublishInput', version: 'v0' },
    outputContract: { kind: 'contract', id: 'kernel.unit.ReportPublishOutput', version: 'v0' },
    toolRefs: [],
    effect: 'READ_ONLY',
    isIdempotent: true,
    failurePolicy: {},
  };
}

function pinnedSet(): PinnedDefinitionSet {
  const agent = {
    schemaVersion: 'v0',
    kind: 'AGENT',
    id: 'code-viewer',
    version: 'v0.1.0',
    digest: agentDigest,
    description: 'viewer',
    role: 'analyst',
    modelRef: { id: 'deepseek-flash', version: 'v1.0.0' },
    modelSettings: { thinking: 'DISABLED' },
    promptRef: { id: 'code-viewer-system', version: 'v0.1.0' },
    unitRefs: [
      { id: 'model-call', version: 'v0.1.0' },
      { id: 'report-publish', version: 'v0.1.0' },
    ],
    startUnitRefs: [],
    actions: { finish: { toolRef: { id: 'finish-analysis', version: 'v0.1.0' } } },
    limits: { maxRounds: 20, maxToolCallsPerRound: 8 },
  } as unknown as AgentDefinition;
  const model = {
    schemaVersion: 'v0',
    kind: 'MODEL',
    id: 'deepseek-flash',
    version: 'v1.0.0',
    digest: 'f'.repeat(64),
    description: 'model',
    provider: 'deepseek',
    apiModelId: 'deepseek-flash',
    providerModelLabel: 'DeepSeek',
    apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
    baseUrl: 'https://api.deepseek.com',
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    features: {
      hasJsonOutput: true,
      hasToolCalls: true,
      hasVision: false,
      thinking: { isSupported: true, isEnabledByDefault: false, effortLevels: ['low', 'high'] },
    },
    pricing: {
      currency: 'USD',
      unit: 'MICRO_USD_PER_MILLION_TOKENS',
      offPeak: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
      peak: {
        ratePercent: 100,
        timeZone: 'UTC',
        weekdays: [1, 2, 3, 4, 5],
        windows: [],
      },
      source: { url: 'https://example.com', verifiedOn: '2026-10-19' },
    },
  } as unknown as ModelDefinition;
  const prompt = {
    schemaVersion: 'v0',
    kind: 'PROMPT',
    id: 'code-viewer-system',
    version: 'v0.1.0',
    digest: 'a'.repeat(64),
    description: 'prompt',
    role: 'system',
    template: 'you are a code viewer',
    variables: [],
    contentStatus: 'FINAL',
  } as unknown as PromptDefinition;
  return {
    schemaVersion: 'v0',
    agent,
    model,
    prompt,
    units: [modelUnit(), reportUnit()],
    tools: [],
    refs: [],
  };
}

function assemblePack(): AssembleContextPack {
  return {
    contextPackId: 'ctx_000001',
    operation: 'ASSEMBLE',
    tokenCount: 0,
    tokenBudget: DEFAULT_KERNEL_CONFIG.budget.perCallInputLimit,
    truncated: false,
    droppedCount: 0,
    prefixSha256: sha,
    items: [],
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

function report(): AnalysisReport {
  return {
    workflowRunId: 'wfr_123456',
    goal: 'analyze',
    summary: 'summary',
    conclusions: [
      {
        statement: 'conclusion',
        sources: [
          {
            path: 'a.ts',
            startLine: 1,
            endLine: 1,
            readRequestId: 'req_000001',
            readContentSha256: sha,
          },
        ],
      },
    ],
    unconfirmed: [],
    readSources: [
      {
        path: 'a.ts',
        startLine: 1,
        endLine: 1,
        readRequestId: 'req_000001',
        readContentSha256: sha,
      },
    ],
    degraded: false,
    agentRounds: [
      { agentId: 'code-viewer', agentRunId: 'agr_123456', roundsUsed: 1, maxRounds: 20 },
    ],
    snapshotId: `snp_${sha}`,
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

class FakeCatalog implements CatalogPort {
  readonly #pinned: PinnedDefinitionSet;

  public constructor(pinned: PinnedDefinitionSet) {
    this.#pinned = pinned;
  }

  public getDefinition(): Promise<never> {
    return Promise.reject(new Error('getDefinition is not used'));
  }

  public pinAgent(): Promise<{ ok: true; value: PinnedDefinitionSet }> {
    return Promise.resolve({ ok: true, value: this.#pinned });
  }

  public capabilities(): readonly CapabilityDescriptor[] {
    return [];
  }
}

const context: BoundaryContext = {
  correlationId: 'cor_123456',
  tenantId: 'local',
  projectId: 'local',
  workflowRunId: 'wfr_123456',
};

interface Harness {
  readonly run: ReturnType<typeof createRunState>;
  readonly handler: CoreRequestHandler;
  readonly execution: Execution;
  readonly dispatcher: RecordingDispatcher;
  readonly artifacts: FakeArtifactStore;
  readonly ownership: ArtifactOwnership;
  readonly events: CoreEvent[];
  readonly audits: CoreAuditEntry[];
  readonly monitor: Monitor;
  readonly scheduler: Scheduler;
}

function harness(): Harness {
  const config: KernelConfig = DEFAULT_KERNEL_CONFIG;
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

  const executionPort = {
    createAttempt: (spec: Parameters<Execution['createAttempt']>[0]) => {
      const current = executionHolder.current;
      if (current === undefined) throw new Error('Execution is not assembled yet');
      return current.createAttempt(spec);
    },
    abortQueued: () => {
      const current = executionHolder.current;
      if (current === undefined) throw new Error('Execution is not assembled yet');
      return current.abortQueued();
    },
    synthesizeStopUnconfirmed: (ids: readonly string[]) => {
      const current = executionHolder.current;
      if (current === undefined) throw new Error('Execution is not assembled yet');
      current.synthesizeStopUnconfirmed(ids);
    },
    ownsArtifact: (ref: ArtifactRef) => {
      const current = executionHolder.current;
      if (current === undefined) return false;
      return current.ownsArtifact(ref);
    },
    readArtifact: (ref: ArtifactRef) => {
      const current = executionHolder.current;
      if (current === undefined) throw new Error('Execution is not assembled yet');
      return current.readArtifact(ref);
    },
    collectUnknownEffects: () => {
      const current = executionHolder.current;
      if (current === undefined) return [];
      return current.collectUnknownEffects();
    },
    modelRequestCount: () => {
      const current = executionHolder.current;
      if (current === undefined) return 0;
      return current.modelRequestCount();
    },
    publishRunSummary: (summary: Parameters<Execution['publishRunSummary']>[0]) => {
      const current = executionHolder.current;
      if (current === undefined) throw new Error('Execution is not assembled yet');
      return current.publishRunSummary(summary);
    },
  };

  const pinned = pinnedSet();
  const handler = new CoreRequestHandler({
    catalog: new FakeCatalog(pinned),
    registry: createM1ProtocolRegistry(),
    execution: executionPort,
    monitor,
    scheduler,
    audit: {
      append: (entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    },
    events: { emit: (event) => events.push(event) },
    config,
    now,
  });
  const core = handler.coreSyscalls(run);
  const execution = new Execution({
    core,
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
    run,
    handler,
    execution,
    dispatcher,
    artifacts,
    ownership,
    events,
    audits,
    monitor,
    scheduler,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function registerAgent(test: Harness): Promise<void> {
  const response = await test.handler.handleForward(
    {
      caller: 'workflow',
      requestType: 'registerAgentRun',
      request: {
        requestId: 'req_register',
        workflowRunId: test.run.workflowRunId,
        agentRunId: 'agr_123456',
        agentRef: {
          kind: 'AGENT',
          id: 'code-viewer',
          version: 'v0.1.0',
          digest: agentDigest,
        },
      },
    },
    context,
    test.run,
  );
  expect(response).toEqual({ requestId: 'req_register', outcome: 'ACCEPTED' });
}

async function seedContextPack(test: Harness): Promise<ArtifactRef> {
  const ref = await test.artifacts.put(
    test.run.workflowRunId,
    Buffer.from(canonicalJson(assemblePack()), 'utf8'),
    MEDIA_TYPES.contextPack,
  );
  test.ownership.register(ref, 'seed');
  return ref;
}

async function submitModel(
  test: Harness,
  requestId: string,
  contextPackRef: ArtifactRef,
): Promise<RunResponse> {
  return test.handler.handleForward(
    {
      caller: 'workflow',
      requestType: 'submitUnit',
      request: {
        requestId,
        workflowRunId: test.run.workflowRunId,
        agentRunId: 'agr_123456',
        unitRef: {
          kind: 'UNIT',
          id: 'model-call',
          version: 'v0.1.0',
          digest: 'b'.repeat(64),
        },
        input: { contextPackRef, final: false },
      },
    },
    context,
    test.run,
  );
}

async function submitReport(test: Harness, requestId: string): Promise<RunResponse> {
  return test.handler.handleForward(
    {
      caller: 'workflow',
      requestType: 'submitUnit',
      request: {
        requestId,
        workflowRunId: test.run.workflowRunId,
        agentRunId: 'agr_123456',
        unitRef: {
          kind: 'UNIT',
          id: 'report-publish',
          version: 'v0.1.0',
          digest: 'c'.repeat(64),
        },
        input: { report: report() },
      },
    },
    context,
    test.run,
  );
}

function completedModelFact(unitAttemptId: string, executionId: string): ExecutionFact {
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
    usage: { inputTokens: 10, outputTokens: 5 },
    startedAt: '2026-10-19T00:00:01.000Z',
    endedAt: '2026-10-19T00:00:02.000Z',
  };
}

function unitReports(events: readonly CoreEvent[]): UnitReport[] {
  return events.filter((event): event is UnitReport => event.type === 'UnitReport');
}

describe('Stage 2 vertical integration', () => {
  it('runs MODEL and report-publish through Core, Execution and RunSummary', async () => {
    const test = harness();
    await registerAgent(test);
    const contextPackRef = await seedContextPack(test);

    const submitted = await submitModel(test, 'req_model', contextPackRef);
    expect(submitted).toEqual({ requestId: 'req_model', outcome: 'ACCEPTED' });
    await flush();
    const request = test.dispatcher.requests[0];
    expect(request?.executionKind).toBe('MODEL');
    if (request === undefined) throw new Error('MODEL was not dispatched');

    await test.execution.handleExecutionFact(
      completedModelFact(request.unitAttemptId, request.executionId),
    );
    await flush();
    const reports = unitReports(test.events);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: 'OK', executionKind: 'MODEL' });

    expect(await submitReport(test, 'req_report')).toEqual({
      requestId: 'req_report',
      outcome: 'ACCEPTED',
    });
    await flush();
    const reportEvent = unitReports(test.events).find(
      (event) => event.executionKind === 'REPORT_PUBLISH',
    );
    if (
      reportEvent === undefined ||
      reportEvent.status !== 'OK' ||
      reportEvent.outputRef === undefined
    )
      throw new Error('report was not published');
    const reportRef = reportEvent.outputRef;

    const closed = await test.handler.handleForward(
      {
        caller: 'workflow',
        requestType: 'closeRun',
        request: {
          requestId: 'req_close',
          workflowRunId: test.run.workflowRunId,
          outcome: 'COMPLETED',
          reportRef,
        },
      },
      context,
      test.run,
    );
    expect(closed).toEqual({ requestId: 'req_close', outcome: 'ACCEPTED' });
    await flush();
    expect(test.run.runState).toBe('CLOSED');

    const runClosed = test.events.find((event) => event.type === 'RunClosed');
    expect(runClosed).toMatchObject({ closeReason: 'COMPLETED' });
    if (runClosed === undefined || runClosed.type !== 'RunClosed') throw new Error('no RunClosed');
    if (!('runSummaryRef' in runClosed) || runClosed.runSummaryRef === undefined)
      throw new Error('RunClosed has no RunSummary');
    const runSummaryRef = runClosed.runSummaryRef;
    expect(test.execution.ownsArtifact(runSummaryRef)).toBe(true);

    const reportRead = await test.handler.handleForward(
      {
        caller: 'user-interaction',
        requestType: 'readArtifact',
        request: {
          requestId: 'req_read_report',
          workflowRunId: test.run.workflowRunId,
          ref: reportRef,
        },
      },
      context,
      test.run,
    );
    expect(reportRead).toMatchObject({ outcome: 'ACCEPTED', ref: reportRef });
    const summaryRead = await test.handler.handleForward(
      {
        caller: 'user-interaction',
        requestType: 'readArtifact',
        request: {
          requestId: 'req_read_summary',
          workflowRunId: test.run.workflowRunId,
          ref: runSummaryRef,
        },
      },
      context,
      test.run,
    );
    expect(summaryRead).toMatchObject({ outcome: 'ACCEPTED', ref: runSummaryRef });
  });

  it('keeps two submitted MODEL units in FIFO order', async () => {
    const test = harness();
    await registerAgent(test);
    const contextPackRef = await seedContextPack(test);

    await submitModel(test, 'req_model_1', contextPackRef);
    await submitModel(test, 'req_model_2', contextPackRef);
    await flush();
    expect(test.dispatcher.requests).toHaveLength(1);

    const first = test.dispatcher.requests[0];
    if (first === undefined) throw new Error('first MODEL was not dispatched');
    await test.execution.handleExecutionFact(
      completedModelFact(first.unitAttemptId, first.executionId),
    );
    await flush();
    expect(test.dispatcher.requests).toHaveLength(2);
    expect(unitReports(test.events)).toHaveLength(1);

    const second = test.dispatcher.requests[1];
    if (second === undefined) throw new Error('second MODEL was not dispatched');
    await test.execution.handleExecutionFact(
      completedModelFact(second.unitAttemptId, second.executionId),
    );
    await flush();
    expect(unitReports(test.events)).toHaveLength(2);
  });
});
