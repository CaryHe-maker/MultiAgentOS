import {
  canonicalJson,
  createM1ProtocolRegistry,
  MEDIA_TYPES,
  sha256Hex,
  type AnalysisReport,
  type AgentDefinition,
  type ArtifactRef,
  type ArtifactStorePort,
  type AssembleContextPack,
  type CapabilityDescriptor,
  type ContextAssembleInput,
  type ExecutionFact,
  type ExecutionRequest,
  type ModelDefinition,
  type OrientContextPack,
  type PinnedDefinitionSet,
  type PromptDefinition,
  type RunSummary,
  type StepRecord,
  type ToolDefinition,
  type UnitDefinition,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KERNEL_CONFIG,
  type AttemptRegistration,
  type AttemptSpec,
  type CoreSyscalls,
  type ExecutionRegistration,
  type ReservationDecision,
  type ResultCheck,
} from '../interfaces/index.js';
import { ArtifactOwnership } from './artifact-ownership.js';
import type { AttemptDispatcher } from './dispatcher.js';
import { Execution } from './index.js';

const sha = 'a'.repeat(64);
const contextPackRef: ArtifactRef = {
  artifactId: `art_${sha}`,
  mediaType: MEDIA_TYPES.contextPack,
  sha256: sha,
  size: 3,
};

const report: AnalysisReport = {
  workflowRunId: 'wfr_123456',
  goal: 'analyze',
  summary: 'summary',
  conclusions: [
    {
      statement: 'a conclusion',
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
    {
      agentId: 'code-viewer',
      agentRunId: 'agr_123456',
      roundsUsed: 1,
      maxRounds: 20,
    },
  ],
  snapshotId: `snp_${sha}`,
  createdAt: '2026-10-19T00:00:00.000Z',
};

function unit(executionKind: UnitDefinition['executionKind'] = 'FILE_READ'): UnitDefinition {
  const isRepository =
    executionKind === 'REPOSITORY_ORIENT' ||
    executionKind === 'REPOSITORY_SEARCH' ||
    executionKind === 'FILE_READ';
  return {
    schemaVersion: 'v0',
    kind: 'UNIT',
    id: executionKind === 'MODEL' ? 'model-call' : 'file-read',
    version: 'v0.1.0',
    digest: 'd'.repeat(64),
    description: 'unit',
    executionKind,
    protectedCapabilities: isRepository ? ['repo.read'] : [],
    inputContract: { kind: 'contract', id: 'executor.FileReadInput', version: 'v0' },
    outputContract: { kind: 'contract', id: 'executor.FileReadOutput', version: 'v0' },
    toolRefs: [],
    effect: 'READ_ONLY',
    isIdempotent: true,
    failurePolicy: {},
  };
}

function spec(
  requestId: string,
  executionKind: UnitDefinition['executionKind'] = 'FILE_READ',
  runEpoch = 1,
  input: AttemptSpec['input'] = { path: 'a.ts' },
  pinned: PinnedDefinitionSet = {} as PinnedDefinitionSet,
): AttemptSpec {
  return {
    requestId,
    agentRunId: 'agr_123456',
    unit: unit(executionKind),
    input,
    scope: scopeFor(executionKind),
    pinned,
    runEpoch,
  };
}

function scopeFor(executionKind: UnitDefinition['executionKind']): AttemptSpec['scope'] {
  if (
    executionKind === 'REPOSITORY_ORIENT' ||
    executionKind === 'REPOSITORY_SEARCH' ||
    executionKind === 'FILE_READ'
  )
    return { kind: 'REPOSITORY', repositoryRoot: '/repo', exclusions: [] };
  if (executionKind === 'MODEL')
    return {
      kind: 'MODEL',
      provider: 'deepseek',
      apiModelId: 'deepseek-flash',
      apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
      baseUrl: 'https://api.deepseek.com',
      thinking: 'DISABLED',
    };
  return { kind: 'NONE' };
}

const finishToolRef = { id: 'finish-analysis', version: 'v0.1.0' };
const handoffToolRef = { id: 'handoff-to-code-viewer', version: 'v0.1.0' };
const searchToolRef = { id: 'search-repository', version: 'v0.1.0' };

function tool(
  id: string,
  purpose: ToolDefinition['purpose'],
  modelName: string,
  parametersContract: ToolDefinition['parametersContract'],
): ToolDefinition {
  return {
    schemaVersion: 'v0',
    kind: 'TOOL',
    id,
    version: 'v0.1.0',
    digest: 'e'.repeat(64),
    description: id,
    purpose,
    modelName,
    modelDescription: `${modelName} description`,
    parametersContract,
    riskClass: 'READ_ONLY',
    sideEffect: 'NONE',
    isIdempotent: true,
    contentStatus: 'FINAL',
  };
}

function pinnedSet(options: { readonly contextWindowTokens?: number } = {}): PinnedDefinitionSet {
  const finish = tool('finish-analysis', 'CONTROL', 'finish_analysis', {
    kind: 'contract',
    id: 'workflow.AnalysisReportDraft',
    version: 'v0',
  });
  const handoff = tool('handoff-to-code-viewer', 'CONTROL', 'handoff_to_code_viewer', {
    kind: 'contract',
    id: 'workflow.HandoffBrief',
    version: 'v0',
  });
  const search = tool('search-repository', 'UNIT', 'search_repository', {
    kind: 'contract',
    id: 'context.RepositorySearchInput',
    version: 'v0',
  });
  const searchUnit: UnitDefinition = {
    ...unit('REPOSITORY_SEARCH'),
    toolRefs: [searchToolRef],
  };
  const agent = {
    actions: {
      finish: { toolRef: finishToolRef },
      handoff: {
        toolRef: handoffToolRef,
        targetAgentRef: { id: 'code-viewer', version: 'v0.1.0' },
      },
    },
  } as unknown as AgentDefinition;
  const model = {
    limits: {
      contextWindowTokens: options.contextWindowTokens ?? 128_000,
      maxOutputTokens: 8_192,
    },
  } as unknown as ModelDefinition;
  const prompt = { template: 'you are a read-only code viewer' } as unknown as PromptDefinition;
  return {
    schemaVersion: 'v0',
    agent,
    model,
    prompt,
    units: [searchUnit, unit('CONTEXT_ASSEMBLE'), unit('MODEL')],
    tools: [search, finish, handoff],
    refs: [],
  };
}

function assemblePack(tokenBudget: number): AssembleContextPack {
  return {
    contextPackId: 'ctx_000001',
    operation: 'ASSEMBLE',
    tokenCount: 0,
    tokenBudget,
    truncated: false,
    droppedCount: 0,
    prefixSha256: sha,
    items: [],
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

function orientPack(): OrientContextPack {
  return {
    contextPackId: 'ctx_000002',
    operation: 'ORIENT',
    snapshotId: `snp_${sha}`,
    tokenCount: 0,
    tokenBudget: DEFAULT_KERNEL_CONFIG.budget.orientBudget,
    truncated: false,
    droppedCount: 0,
    items: [],
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

function contextInput(
  final = false,
  orientPackRef?: ArtifactRef,
  steps: StepRecord[] = [],
): ContextAssembleInput {
  return {
    objective: 'analyze',
    final,
    ...(orientPackRef === undefined ? {} : { orientPackRef }),
    steps,
    status: {
      roundsUsed: 0,
      maxRounds: 20,
      final,
      budgetState: 'NORMAL',
    },
  };
}

class FakeCore implements CoreSyscalls {
  public readonly attempts: AttemptRegistration[] = [];
  public readonly executions: ExecutionRegistration[] = [];
  public readonly checks: ResultCheck[] = [];
  public readonly reservations: {
    unitAttemptId: string;
    estimatedTokens: number;
    final: boolean;
  }[] = [];
  public reservationDecision: ReservationDecision = {
    granted: true,
    reservationId: 'rsv_000001',
    grantId: 'grt_000001',
  };
  public epoch = 1;

  public registerAttempt(attempt: AttemptRegistration): void {
    this.attempts.push(attempt);
  }

  public registerExecution(execution: ExecutionRegistration): void {
    this.executions.push(execution);
  }

  public requestReservation(request: {
    readonly unitAttemptId: string;
    readonly estimatedTokens: number;
    readonly final: boolean;
  }): ReservationDecision {
    this.reservations.push({
      unitAttemptId: request.unitAttemptId,
      estimatedTokens: request.estimatedTokens,
      final: request.final,
    });
    return this.reservationDecision;
  }

  public submitResultCheck(check: ResultCheck): void {
    this.checks.push(check);
  }

  public retryExecution(): never {
    throw new Error('retryExecution is not used by stage 2.3');
  }

  public currentRunEpoch(): number {
    return this.epoch;
  }
}

class RecordingDispatcher implements AttemptDispatcher {
  public readonly requests: ExecutionRequest[] = [];

  public dispatch(request: ExecutionRequest): void {
    this.requests.push(request);
  }
}

class FakeArtifactStore implements ArtifactStorePort {
  public readonly objects = new Map<string, { content: Uint8Array; mediaType: string }>();
  public readonly puts: { content: Uint8Array; mediaType: string }[] = [];
  public failNextPut = false;

  public put(workflowRunId: string, content: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    if (this.failNextPut) {
      this.failNextPut = false;
      return Promise.reject(new Error('write failed'));
    }
    const digest = sha256Hex(content);
    const ref: ArtifactRef = {
      artifactId: `art_${digest}`,
      mediaType,
      sha256: digest,
      size: content.byteLength,
    };
    this.objects.set(`${workflowRunId}:${digest}`, { content, mediaType });
    this.puts.push({ content, mediaType });
    return Promise.resolve(ref);
  }

  public get(workflowRunId: string, ref: ArtifactRef): Promise<Uint8Array> {
    const stored = this.objects.get(`${workflowRunId}:${ref.sha256}`);
    if (stored === undefined) return Promise.reject(new Error('artifact is missing'));
    if (stored.content.byteLength !== ref.size || sha256Hex(stored.content) !== ref.sha256)
      return Promise.reject(new Error('artifact failed verification'));
    return Promise.resolve(stored.content);
  }

  public capabilities(): readonly CapabilityDescriptor[] {
    return [];
  }
}

function harness(options: { readonly maxReportBytes?: number } = {}): {
  readonly core: FakeCore;
  readonly dispatcher: RecordingDispatcher;
  readonly artifacts: FakeArtifactStore;
  readonly ownership: ArtifactOwnership;
  readonly execution: Execution;
} {
  const core = new FakeCore();
  const dispatcher = new RecordingDispatcher();
  const artifacts = new FakeArtifactStore();
  const ownership = new ArtifactOwnership();
  const config = {
    ...DEFAULT_KERNEL_CONFIG,
    maxReportBytes: options.maxReportBytes ?? DEFAULT_KERNEL_CONFIG.maxReportBytes,
  };
  let attemptSequence = 0;
  let executionSequence = 0;
  const execution = new Execution({
    core,
    dispatcher,
    workflowRunId: 'wfr_123456',
    artifacts,
    config,
    registry: createM1ProtocolRegistry(),
    ownership,
    now: () => new Date('2026-10-19T00:00:00.000Z'),
    newAttemptId: () => `una_${String((attemptSequence += 1)).padStart(6, '0')}`,
    newExecutionId: () => `exe_${String((executionSequence += 1)).padStart(6, '0')}`,
  });
  return { core, dispatcher, artifacts, ownership, execution };
}

type TestHarness = ReturnType<typeof harness>;

async function seedJson(
  test: TestHarness,
  value: unknown,
  mediaType: string,
): Promise<ArtifactRef> {
  const ref = await test.artifacts.put(
    'wfr_123456',
    Buffer.from(canonicalJson(value), 'utf8'),
    mediaType,
  );
  test.ownership.register(ref, 'seed');
  return ref;
}

async function seedText(test: TestHarness, text: string): Promise<ArtifactRef> {
  const ref = await test.artifacts.put(
    'wfr_123456',
    Buffer.from(text, 'utf8'),
    MEDIA_TYPES.fileText,
  );
  test.ownership.register(ref, 'seed');
  return ref;
}

async function modelSpec(
  test: TestHarness,
  requestId: string,
  final = false,
  contextWindowTokens?: number,
): Promise<AttemptSpec> {
  const tokenBudget = final
    ? DEFAULT_KERNEL_CONFIG.budget.finalInputBudget
    : DEFAULT_KERNEL_CONFIG.budget.perCallInputLimit;
  const contextPackRef = await seedJson(test, assemblePack(tokenBudget), MEDIA_TYPES.contextPack);
  return spec(
    requestId,
    'MODEL',
    1,
    { contextPackRef, final },
    pinnedSet(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  );
}

function failedFact(
  unitAttemptId: string,
  executionId: string,
  executionKind: 'FILE_READ' | 'MODEL' = 'FILE_READ',
): ExecutionFact {
  if (executionKind === 'MODEL') {
    return {
      workflowRunId: 'wfr_123456',
      unitAttemptId,
      executionId,
      runEpoch: 1,
      executionKind: 'MODEL',
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
      retryable: false,
      requestState: 'NOT_SENT',
      startedAt: '2026-10-19T00:00:01.000Z',
      endedAt: '2026-10-19T00:00:02.000Z',
    };
  }
  return {
    workflowRunId: 'wfr_123456',
    unitAttemptId,
    executionId,
    runEpoch: 1,
    executionKind: 'FILE_READ',
    outcome: 'FAILED',
    reasonCode: 'INTERNAL',
    retryable: false,
    startedAt: '2026-10-19T00:00:01.000Z',
    endedAt: '2026-10-19T00:00:02.000Z',
  };
}

describe('Execution attempts and FIFO', () => {
  it('registers an attempt before dispatching it', async () => {
    const test = harness();
    const unitAttemptId = await test.execution.createAttempt(spec('req_000001'));

    expect(unitAttemptId).toBe('una_000001');
    expect(test.core.attempts).toEqual([
      {
        unitAttemptId: 'una_000001',
        requestId: 'req_000001',
        agentRunId: 'agr_123456',
        runEpoch: 1,
        executionKind: 'FILE_READ',
        requiresLease: true,
      },
    ]);
    expect(test.core.executions).toEqual([
      { unitAttemptId: 'una_000001', executionId: 'exe_000001', runEpoch: 1 },
    ]);
    expect(test.dispatcher.requests).toHaveLength(1);
    expect(test.dispatcher.requests[0]?.executionKind).toBe('FILE_READ');
    expect(test.dispatcher.requests[0]?.unitAttemptId).toBe('una_000001');
    expect(test.dispatcher.requests[0]?.executionId).toBe('exe_000001');
  });

  it('is idempotent by requestId', async () => {
    const test = harness();
    const first = await test.execution.createAttempt(spec('req_000001'));
    const second = await test.execution.createAttempt(spec('req_000001'));

    expect(second).toBe(first);
    expect(test.core.attempts).toHaveLength(1);
    expect(test.dispatcher.requests).toHaveLength(1);
  });

  it('rejects a different attempt for the same requestId', async () => {
    const test = harness();
    await test.execution.createAttempt(spec('req_000001'));

    await expect(
      test.execution.createAttempt(spec('req_000001', 'FILE_READ', 1, { path: 'b.ts' })),
    ).rejects.toThrow('Conflicting attempt');
  });

  it('starts only one attempt and advances after a result check', async () => {
    const test = harness();
    const first = await test.execution.createAttempt(spec('req_000001'));
    const second = await test.execution.createAttempt(spec('req_000002'));
    const firstExecution = test.dispatcher.requests[0]?.executionId;

    expect(firstExecution).toBe('exe_000001');
    expect(test.dispatcher.requests).toHaveLength(1);

    await test.execution.handleExecutionFact(failedFact(first, firstExecution ?? ''));

    expect(test.core.checks).toHaveLength(1);
    expect(test.core.checks[0]).toMatchObject({
      unitAttemptId: first,
      executionId: firstExecution,
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
    });
    expect(test.dispatcher.requests).toHaveLength(2);
    expect(test.dispatcher.requests[1]?.unitAttemptId).toBe(second);
  });

  it('does not start a follow-up attempt before the first result check', async () => {
    const test = harness();
    await test.execution.createAttempt(spec('req_000001'));
    await test.execution.createAttempt(spec('req_000002'));

    expect(test.dispatcher.requests).toHaveLength(1);
    expect(test.core.checks).toHaveLength(0);
  });

  it('ignores duplicate and late execution facts', async () => {
    const test = harness();
    const first = await test.execution.createAttempt(spec('req_000001'));
    const executionId = test.dispatcher.requests[0]?.executionId ?? '';
    const fact = failedFact(first, executionId);

    await test.execution.handleExecutionFact(fact);
    await test.execution.handleExecutionFact(fact);

    expect(test.core.checks).toHaveLength(1);
  });

  it('ignores a fact whose executionKind does not match the attempt', async () => {
    const test = harness();
    const first = await test.execution.createAttempt(spec('req_000001'));
    const executionId = test.dispatcher.requests[0]?.executionId ?? '';

    await test.execution.handleExecutionFact(failedFact(first, executionId, 'MODEL'));
    expect(test.core.checks).toHaveLength(0);

    await test.execution.handleExecutionFact(failedFact(first, executionId));
    expect(test.core.checks).toHaveLength(1);
  });

  it('carries MODEL request state into the result check', async () => {
    const test = harness();
    const first = await test.execution.createAttempt(await modelSpec(test, 'req_000001'));
    await flush();
    const executionId = test.dispatcher.requests[0]?.executionId ?? '';

    await test.execution.handleExecutionFact({
      workflowRunId: 'wfr_123456',
      unitAttemptId: first,
      executionId,
      runEpoch: 1,
      executionKind: 'MODEL',
      outcome: 'FAILED',
      reasonCode: 'PROVIDER_UNREACHABLE',
      retryable: true,
      requestState: 'NOT_SENT',
      startedAt: '2026-10-19T00:00:01.000Z',
      endedAt: '2026-10-19T00:00:02.000Z',
    });

    expect(test.core.checks[0]).toMatchObject({
      unitAttemptId: first,
      executionId,
      outcome: 'FAILED',
      reasonCode: 'PROVIDER_UNREACHABLE',
      requestState: 'NOT_SENT',
    });
  });

  it('aborts queued attempts and returns the in-flight execution', async () => {
    const test = harness();
    const first = await test.execution.createAttempt(spec('req_000001'));
    await test.execution.createAttempt(spec('req_000002'));
    await test.execution.createAttempt(spec('req_000003'));

    const aborted = test.execution.abortQueued();
    expect(aborted.inFlight).toEqual([{ unitAttemptId: first, executionId: 'exe_000001' }]);

    await test.execution.handleExecutionFact(failedFact(first, 'exe_000001'));
    expect(test.dispatcher.requests).toHaveLength(1);
  });

  it('does not start an attempt from an old runEpoch', async () => {
    const test = harness();
    test.core.epoch = 2;

    const unitAttemptId = await test.execution.createAttempt(spec('req_000001', 'FILE_READ', 1));

    expect(unitAttemptId).toBe('una_000001');
    expect(test.core.attempts).toHaveLength(1);
    expect(test.dispatcher.requests).toHaveLength(0);
  });

  it('synthesizes STOP_UNCONFIRMED and reports the unknown effect', async () => {
    const test = harness();
    const first = await test.execution.createAttempt(spec('req_000001'));
    const executionId = test.dispatcher.requests[0]?.executionId ?? '';

    test.execution.synthesizeStopUnconfirmed([executionId]);

    expect(test.core.checks[0]).toMatchObject({
      unitAttemptId: first,
      executionId,
      outcome: 'STOP_UNCONFIRMED',
      stopVerdictBy: 'CORE',
    });
    expect(test.execution.collectUnknownEffects()).toEqual([
      {
        unitAttemptId: first,
        executionId,
        executionKind: 'FILE_READ',
        effect: 'EXECUTION_STOP_UNCONFIRMED',
      },
    ]);
  });

  it('counts dispatched MODEL executions', async () => {
    const test = harness();
    await test.execution.createAttempt(await modelSpec(test, 'req_000001'));
    await flush();

    expect(test.execution.modelRequestCount()).toBe(1);
  });
});

function outputRefOf(check: ResultCheck | undefined): ArtifactRef {
  if (check?.outputRef === undefined) throw new Error('result check has no outputRef');
  return check.outputRef;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const runSummary: RunSummary = {
  workflowRunId: 'wfr_123456',
  closeReason: 'CANCELLED',
  startedAt: '2026-10-19T00:00:00.000Z',
  closedAt: '2026-10-19T00:00:01.000Z',
  durationMs: 1_000,
  agentRuns: [],
  units: { submitted: 0, ok: 0, rejected: 0, failed: 0, notDelivered: 0 },
  model: { requests: 0, finalCallUsed: false },
  tokens: {
    limit: 600_000,
    used: 0,
    unknown: 0,
    inputTokens: 0,
    outputTokens: 0,
    finalBudgetState: 'NORMAL',
  },
  unknownEffects: [],
};

describe('Execution artifacts and built-in report-publish', () => {
  it('publishes a report without dispatching to the Supervisor', async () => {
    const test = harness();
    const unitAttemptId = await test.execution.createAttempt(
      spec('req_000001', 'REPORT_PUBLISH', 1, { report }),
    );
    await flush();

    expect(test.dispatcher.requests).toHaveLength(0);
    expect(test.core.executions).toHaveLength(0);
    expect(test.core.checks).toHaveLength(1);
    expect(test.core.checks[0]).toMatchObject({
      unitAttemptId,
      outcome: 'COMPLETED',
      output: { conclusionCount: 1, unconfirmedCount: 0, degraded: false },
    });
    const ref = outputRefOf(test.core.checks[0]);
    expect(ref.mediaType).toBe(MEDIA_TYPES.analysisReport);
    expect(test.execution.ownsArtifact(ref)).toBe(true);
    await expect(test.execution.readArtifact(ref)).resolves.toEqual({
      ok: true,
      text: canonicalJson(report),
    });
  });

  it('rejects a report over maxReportBytes without writing it', async () => {
    const test = harness({ maxReportBytes: 10 });
    await test.execution.createAttempt(spec('req_000001', 'REPORT_PUBLISH', 1, { report }));
    await flush();

    expect(test.core.checks[0]).toMatchObject({
      outcome: 'REJECTED',
      reasonCode: 'LIMIT_EXCEEDED',
    });
    expect(test.artifacts.puts).toHaveLength(0);
  });

  it('turns an artifact write failure into FAILED(INTERNAL)', async () => {
    const test = harness();
    test.artifacts.failNextPut = true;
    await test.execution.createAttempt(spec('req_000001', 'REPORT_PUBLISH', 1, { report }));
    await flush();

    expect(test.core.checks[0]).toMatchObject({
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
    });
  });

  it('rejects an invalid report-publish input before writing', async () => {
    const test = harness();
    await test.execution.createAttempt(spec('req_000001', 'REPORT_PUBLISH', 1, { path: 'a.ts' }));
    await flush();

    expect(test.core.checks[0]).toMatchObject({
      outcome: 'NOT_DISPATCHED',
      reasonCode: 'INVALID_INPUT',
    });
    expect(test.artifacts.puts).toHaveLength(0);
  });

  it('keeps report-publish in the FIFO and advances afterwards', async () => {
    const test = harness();
    await test.execution.createAttempt(spec('req_000001', 'REPORT_PUBLISH', 1, { report }));
    const second = await test.execution.createAttempt(spec('req_000002'));
    await flush();

    expect(test.core.checks).toHaveLength(1);
    expect(test.dispatcher.requests).toHaveLength(1);
    expect(test.dispatcher.requests[0]?.unitAttemptId).toBe(second);
  });

  it('publishes and reads a RunSummary', async () => {
    const test = harness();
    const ref = await test.execution.publishRunSummary(runSummary);

    expect(ref.mediaType).toBe(MEDIA_TYPES.runSummary);
    expect(test.execution.ownsArtifact(ref)).toBe(true);
    await expect(test.execution.readArtifact(ref)).resolves.toEqual({
      ok: true,
      text: canonicalJson(runSummary),
    });
    expect(test.artifacts.puts[0]?.mediaType).toBe(MEDIA_TYPES.runSummary);
  });

  it('fails when the RunSummary cannot be written', async () => {
    const test = harness();
    test.artifacts.failNextPut = true;

    await expect(test.execution.publishRunSummary(runSummary)).rejects.toThrow('write failed');
  });

  it('does not own a reference with a different media type or integrity fields', async () => {
    const test = harness();
    await test.execution.createAttempt(spec('req_000001', 'REPORT_PUBLISH', 1, { report }));
    await flush();
    const ref = outputRefOf(test.core.checks[0]);

    const differentMediaType: ArtifactRef = { ...ref, mediaType: MEDIA_TYPES.fileText };
    const differentDigest: ArtifactRef = { ...ref, sha256: 'b'.repeat(64) };

    expect(test.execution.ownsArtifact(differentMediaType)).toBe(false);
    await expect(test.execution.readArtifact(differentMediaType)).resolves.toEqual({
      ok: false,
    });
    expect(test.execution.ownsArtifact(differentDigest)).toBe(false);
    await expect(test.execution.readArtifact(differentDigest)).resolves.toEqual({
      ok: false,
    });
  });
});

describe('Execution request construction', () => {
  it('builds a REPOSITORY_ORIENT request with the configured budget and limits', async () => {
    const test = harness();
    await test.execution.createAttempt(
      spec('req_000001', 'REPOSITORY_ORIENT', 1, { objective: 'analyze' }),
    );
    await flush();

    expect(test.dispatcher.requests[0]).toMatchObject({
      executionKind: 'REPOSITORY_ORIENT',
      scope: { kind: 'REPOSITORY' },
      input: {
        objective: 'analyze',
        tokenBudget: DEFAULT_KERNEL_CONFIG.budget.orientBudget,
      },
      limits: {
        deadline: '2026-10-19T00:01:00.000Z',
        maxOutputBytes: DEFAULT_KERNEL_CONFIG.executionLimits.REPOSITORY_ORIENT.maxOutputBytes,
        maxFiles: DEFAULT_KERNEL_CONFIG.maxSnapshotFiles,
      },
    });
  });

  it('builds a REPOSITORY_SEARCH request with defaults and explicit values', async () => {
    const test = harness();
    await test.execution.createAttempt(
      spec('req_000001', 'REPOSITORY_SEARCH', 1, {
        query: 'needle',
        mode: 'TEXT',
        maxItems: 5,
      }),
    );
    await flush();

    expect(test.dispatcher.requests[0]).toMatchObject({
      executionKind: 'REPOSITORY_SEARCH',
      input: {
        query: 'needle',
        mode: 'TEXT',
        maxItems: 5,
        tokenBudget: DEFAULT_KERNEL_CONFIG.budget.searchBudget,
      },
      limits: { deadline: '2026-10-19T00:00:30.000Z' },
    });
  });

  it('fills the REPOSITORY_SEARCH defaults', async () => {
    const test = harness();
    await test.execution.createAttempt(
      spec('req_000001', 'REPOSITORY_SEARCH', 1, { query: 'needle' }),
    );
    await flush();

    expect(test.dispatcher.requests[0]).toMatchObject({
      executionKind: 'REPOSITORY_SEARCH',
      input: {
        query: 'needle',
        mode: 'AUTO',
        maxItems: 20,
        tokenBudget: DEFAULT_KERNEL_CONFIG.budget.searchBudget,
      },
    });
  });

  it('builds a FILE_READ request from the Unit input', async () => {
    const test = harness();
    await test.execution.createAttempt(
      spec('req_000001', 'FILE_READ', 1, { path: 'a.ts', startLine: 1, endLine: 10 }),
    );
    await flush();

    expect(test.dispatcher.requests[0]).toMatchObject({
      executionKind: 'FILE_READ',
      input: { path: 'a.ts', startLine: 1, endLine: 10 },
      limits: { deadline: '2026-10-19T00:00:10.000Z' },
    });
  });

  it('builds a CONTEXT_ASSEMBLE input with tools, orient pack and resolved history', async () => {
    const test = harness();
    const orientRef = await seedJson(test, orientPack(), MEDIA_TYPES.contextPack);
    const textRef = await seedText(test, 'const answer = 42;');
    const step: StepRecord = {
      kind: 'TOOL_RESULT',
      round: 1,
      requestId: 'req_000002',
      toolCallId: 'call_1',
      toolName: 'read_file',
      status: 'OK',
      output: {
        path: 'a.ts',
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        contentSha256: sha,
        fileSha256: 'b'.repeat(64),
      },
      outputRef: textRef,
    };

    await test.execution.createAttempt(
      spec(
        'req_000001',
        'CONTEXT_ASSEMBLE',
        1,
        contextInput(false, orientRef, [step]),
        pinnedSet(),
      ),
    );
    await flush();

    const request = test.dispatcher.requests[0];
    expect(request).toMatchObject({
      executionKind: 'CONTEXT_ASSEMBLE',
      scope: { kind: 'NONE' },
      input: {
        objective: 'analyze',
        final: false,
        tokenBudget: DEFAULT_KERNEL_CONFIG.budget.perCallInputLimit,
        instructions: 'you are a read-only code viewer',
        orientPack: orientPack(),
      },
      limits: { deadline: '2026-10-19T00:00:30.000Z' },
    });
    if (request?.executionKind !== 'CONTEXT_ASSEMBLE') throw new Error('wrong request kind');
    expect(request.input.toolSpecs.map((spec) => spec.name)).toEqual([
      'search_repository',
      'finish_analysis',
      'handoff_to_code_viewer',
    ]);
    expect(request.input.history[0]?.outputText).toBe('const answer = 42;');
  });

  it('provides only the finish tool to a final CONTEXT_ASSEMBLE', async () => {
    const test = harness();
    await test.execution.createAttempt(
      spec('req_000001', 'CONTEXT_ASSEMBLE', 1, contextInput(true), pinnedSet()),
    );
    await flush();

    const request = test.dispatcher.requests[0];
    if (request?.executionKind !== 'CONTEXT_ASSEMBLE') throw new Error('wrong request kind');
    expect(request.input.toolSpecs.map((spec) => spec.name)).toEqual(['finish_analysis']);
    expect(request.input.tokenBudget).toBe(DEFAULT_KERNEL_CONFIG.budget.finalInputBudget);
  });

  it('builds a MODEL request and reserves the estimated input plus output', async () => {
    const test = harness();
    await test.execution.createAttempt(await modelSpec(test, 'req_000001'));
    await flush();

    expect(test.core.reservations).toEqual([
      { unitAttemptId: 'una_000001', estimatedTokens: 8_192, final: false },
    ]);
    expect(test.dispatcher.requests[0]).toMatchObject({
      executionKind: 'MODEL',
      scope: { kind: 'MODEL' },
      input: { final: false },
      limits: {
        deadline: '2026-10-19T00:03:00.000Z',
        maxOutputTokens: DEFAULT_KERNEL_CONFIG.budget.maxOutputTokens,
      },
    });
  });

  it('uses the final output budget and reservation for a final MODEL call', async () => {
    const test = harness();
    await test.execution.createAttempt(await modelSpec(test, 'req_000001', true));
    await flush();

    expect(test.core.reservations).toEqual([
      { unitAttemptId: 'una_000001', estimatedTokens: 8_192, final: true },
    ]);
    expect(test.dispatcher.requests[0]).toMatchObject({
      executionKind: 'MODEL',
      input: { final: true },
      limits: {
        deadline: '2026-10-19T00:03:00.000Z',
        maxOutputTokens: DEFAULT_KERNEL_CONFIG.budget.finalMaxOutputTokens,
      },
    });
  });

  it('rejects a context pack reference that this run does not own', async () => {
    const test = harness();
    await test.execution.createAttempt(
      spec('req_000001', 'MODEL', 1, { contextPackRef, final: false }, pinnedSet()),
    );
    await flush();

    expect(test.dispatcher.requests).toHaveLength(0);
    expect(test.core.checks[0]).toMatchObject({
      outcome: 'NOT_DISPATCHED',
      reasonCode: 'INVALID_ARTIFACT_REF',
    });
  });

  it('rejects a context pack whose budget does not match final', async () => {
    const test = harness();
    const contextPackRef = await seedJson(
      test,
      assemblePack(DEFAULT_KERNEL_CONFIG.budget.perCallInputLimit),
      MEDIA_TYPES.contextPack,
    );
    await test.execution.createAttempt(
      spec('req_000001', 'MODEL', 1, { contextPackRef, final: true }, pinnedSet()),
    );
    await flush();

    expect(test.dispatcher.requests).toHaveLength(0);
    expect(test.core.checks[0]).toMatchObject({
      outcome: 'NOT_DISPATCHED',
      reasonCode: 'INVALID_INPUT',
    });
  });

  it('rejects a MODEL request that exceeds the model context window', async () => {
    const test = harness();
    await test.execution.createAttempt(await modelSpec(test, 'req_000001', false, 100));
    await flush();

    expect(test.dispatcher.requests).toHaveLength(0);
    expect(test.core.checks[0]).toMatchObject({
      outcome: 'NOT_DISPATCHED',
      reasonCode: 'LIMIT_EXCEEDED',
    });
  });

  it('does not dispatch when Core rejects the reservation', async () => {
    const test = harness();
    test.core.reservationDecision = { granted: false, reason: 'BUDGET_EXHAUSTED' };
    await test.execution.createAttempt(await modelSpec(test, 'req_000001'));
    await flush();

    expect(test.dispatcher.requests).toHaveLength(0);
    expect(test.core.checks).toHaveLength(0);
  });
});
