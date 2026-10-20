import {
  createM1ProtocolRegistry,
  sha256Hex,
  type ArtifactRef,
  type ArtifactStorePort,
  type CapabilityDescriptor,
  type CatalogPort,
  type ExecutionFact,
  type ExecutionRequest,
  type GatewayForward,
  type PinnedDefinitionSet,
} from '@multiagentos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createRunState, type CoreEvent } from '../core/index.js';
import { DEFAULT_KERNEL_CONFIG } from '../interfaces/index.js';
import { InProcessProviderCapacity } from '../scheduler/index.js';
import { RunActor } from './actor.js';
import { createKernelRun, type KernelRun } from './kernel-run.js';
import type { AttemptDispatcher } from '../execution/index.js';

const context = {
  tenantId: 'local',
  projectId: 'local',
  correlationId: 'cor_123456',
  workflowRunId: 'wfr_123456',
} as const;

const sha = 'a'.repeat(64);
const agentDigest = 'd'.repeat(64);

function unit(id: string, executionKind: 'CONTEXT_ASSEMBLE' | 'REPORT_PUBLISH', digest: string) {
  const contract =
    executionKind === 'CONTEXT_ASSEMBLE'
      ? { input: 'context.ContextAssembleInput', output: 'context.ContextAssembleOutput' }
      : { input: 'kernel.unit.ReportPublishInput', output: 'kernel.unit.ReportPublishOutput' };
  return {
    schemaVersion: 'v0',
    kind: 'UNIT',
    id,
    version: 'v0.1.0',
    digest,
    description: id,
    executionKind,
    protectedCapabilities: [],
    inputContract: { kind: 'contract', id: contract.input, version: 'v0' },
    outputContract: { kind: 'contract', id: contract.output, version: 'v0' },
    toolRefs: [],
    effect: 'READ_ONLY',
    isIdempotent: true,
    failurePolicy: {},
  } as const;
}

function pinnedSet(): PinnedDefinitionSet {
  return {
    schemaVersion: 'v0',
    agent: {
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
        { id: 'context-assemble', version: 'v0.1.0' },
        { id: 'report-publish', version: 'v0.1.0' },
      ],
      startUnitRefs: [],
      actions: { finish: { toolRef: { id: 'finish-analysis', version: 'v0.1.0' } } },
      limits: { maxRounds: 3, maxToolCallsPerRound: 0 },
    },
    model: {
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
        thinking: { isSupported: true, isEnabledByDefault: false, effortLevels: ['low'] },
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
        source: { url: 'https://example.com', verifiedOn: '2026-10-21' },
      },
    },
    prompt: {
      schemaVersion: 'v0',
      kind: 'PROMPT',
      id: 'code-viewer-system',
      version: 'v0.1.0',
      digest: 'e'.repeat(64),
      description: 'prompt',
      role: 'system',
      template: 'You are a read-only analyst.',
      variables: [],
      contentStatus: 'FINAL',
    },
    units: [
      unit('context-assemble', 'CONTEXT_ASSEMBLE', 'b'.repeat(64)),
      unit('report-publish', 'REPORT_PUBLISH', 'c'.repeat(64)),
    ],
    tools: [
      {
        schemaVersion: 'v0',
        kind: 'TOOL',
        id: 'finish-analysis',
        version: 'v0.1.0',
        digest: '9'.repeat(64),
        description: 'finish the analysis',
        purpose: 'CONTROL',
        modelName: 'finish_analysis',
        modelDescription: 'Finish the analysis.',
        parametersContract: {
          kind: 'contract',
          id: 'workflow.AnalysisReportDraft',
          version: 'v0',
        },
        riskClass: 'READ_ONLY',
        sideEffect: 'NONE',
        isIdempotent: true,
        contentStatus: 'FINAL',
      },
    ],
    refs: [],
  } as unknown as PinnedDefinitionSet;
}

class FakeCatalog implements CatalogPort {
  readonly #pinned = pinnedSet();

  public getDefinition(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  public pinAgent(): Promise<{ ok: true; value: PinnedDefinitionSet }> {
    return Promise.resolve({ ok: true, value: this.#pinned });
  }

  public capabilities(): readonly CapabilityDescriptor[] {
    return [];
  }
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

function report() {
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
    agentRounds: [],
    snapshotId: `snp_${sha}`,
    createdAt: '2026-10-21T00:00:00.000Z',
  };
}

interface Harness {
  readonly actor: RunActor;
  readonly run: KernelRun;
  readonly events: CoreEvent[];
  readonly dispatcher: RecordingDispatcher;
}

function harness(): Harness {
  const events: CoreEvent[] = [];
  const dispatcher = new RecordingDispatcher();
  const runState = createRunState({
    workflowRunId: 'wfr_123456',
    correlationId: 'cor_123456',
    goal: 'analyze',
    repositoryRoot: '/repo',
    startedAt: '2026-10-21T00:00:00.000Z',
  });
  const holder: { actor?: RunActor } = {};
  let attemptSequence = 0;
  const run = createKernelRun({
    run: runState,
    catalog: new FakeCatalog(),
    registry: createM1ProtocolRegistry(),
    artifacts: new FakeArtifactStore(),
    config: DEFAULT_KERNEL_CONFIG,
    audit: { append: () => Promise.resolve() },
    dispatcher,
    capacity: new InProcessProviderCapacity(),
    events: { emit: (event) => events.push(event) },
    onRunClosed: () => holder.actor?.markClosed(),
    now: () => new Date('2026-10-21T00:00:01.000Z'),
    newAttemptId: () => `una_${String((attemptSequence += 1)).padStart(6, '0')}`,
    newExecutionId: () => 'exe_123456',
  });
  const actor = new RunActor({ processor: run.processor });
  holder.actor = actor;
  return { actor, run, events, dispatcher };
}

async function register(harnessValue: Harness): Promise<unknown> {
  const forward: GatewayForward = {
    caller: 'workflow',
    requestType: 'registerAgentRun',
    request: {
      requestId: 'req_reg123456',
      workflowRunId: 'wfr_123456',
      agentRunId: 'agr_123456',
      agentRef: { kind: 'AGENT', id: 'code-viewer', version: 'v0.1.0', digest: agentDigest },
    },
  };
  return harnessValue.actor.forward(forward, context);
}

async function submit(
  harnessValue: Harness,
  id: 'context-assemble' | 'report-publish',
  input: unknown,
  requestId: string,
): Promise<unknown> {
  const forward: GatewayForward = {
    caller: 'workflow',
    requestType: 'submitUnit',
    request: {
      requestId,
      workflowRunId: 'wfr_123456',
      agentRunId: 'agr_123456',
      unitRef: {
        kind: 'UNIT',
        id,
        version: 'v0.1.0',
        digest: id === 'context-assemble' ? 'b'.repeat(64) : 'c'.repeat(64),
      },
      input: input as never,
    },
  };
  return harnessValue.actor.forward(forward, context);
}

describe('createKernelRun and RunActor', () => {
  it('runs Core and Execution through the actor to a terminal report', async () => {
    const test = harness();
    test.actor.start();
    await test.actor.init();
    await test.actor.drain();

    expect(test.events[0]).toEqual({ type: 'RunStart', goal: 'analyze' });

    await register(test);
    await submit(
      test,
      'context-assemble',
      {
        objective: 'analyze',
        final: false,
        steps: [],
        status: { roundsUsed: 0, maxRounds: 3, final: false, budgetState: 'NORMAL' },
      },
      'req_sub123456',
    );
    await vi.waitFor(() => expect(test.dispatcher.requests).toHaveLength(1));
    const request = test.dispatcher.requests[0];
    if (request === undefined) throw new Error('no execution request');

    const fact: ExecutionFact = {
      workflowRunId: 'wfr_123456',
      unitAttemptId: request.unitAttemptId,
      executionId: request.executionId,
      runEpoch: request.runEpoch,
      executionKind: 'CONTEXT_ASSEMBLE',
      outcome: 'REJECTED',
      reasonCode: 'INVALID_QUERY',
      startedAt: '2026-10-21T00:00:00.500Z',
      endedAt: '2026-10-21T00:00:01.000Z',
    };
    await test.actor.reportFact(fact);
    await test.actor.drain();
    await vi.waitFor(() =>
      expect(test.events).toContainEqual(
        expect.objectContaining({ type: 'UnitReport', requestId: 'req_sub123456' }),
      ),
    );

    await submit(test, 'report-publish', { report: report() }, 'req_report123');
    await test.actor.drain();
    const unitReport = await vi.waitFor(() => {
      const found = test.events.find(
        (event) => event.type === 'UnitReport' && event.requestId === 'req_report123',
      );
      expect(found).toBeDefined();
      return found;
    });
    if (
      unitReport?.type !== 'UnitReport' ||
      unitReport.status !== 'OK' ||
      unitReport.outputRef === undefined
    )
      throw new Error('report was not published');

    const closed = await test.actor.forward(
      {
        caller: 'workflow',
        requestType: 'closeRun',
        request: {
          requestId: 'req_close123',
          workflowRunId: 'wfr_123456',
          outcome: 'COMPLETED',
          reportRef: unitReport.outputRef,
        },
      },
      context,
    );
    expect(closed).toEqual({ requestId: 'req_close123', outcome: 'ACCEPTED' });
    await test.actor.whenClosed();
    await test.actor.drain();

    expect(test.run.run.runState).toBe('CLOSED');
    expect(test.events).toContainEqual(
      expect.objectContaining({ type: 'RunClosed', closeReason: 'COMPLETED' }),
    );
    expect(test.events).toContainEqual(
      expect.objectContaining({ type: 'RunFinished', closeReason: 'COMPLETED' }),
    );
    await test.actor.stop();
  });

  it('completes an execution-fact convergence only after the actor settles it', async () => {
    const test = harness();
    test.actor.start();
    await test.actor.init();
    await test.actor.drain();
    await register(test);
    await submit(
      test,
      'context-assemble',
      {
        objective: 'analyze',
        final: false,
        steps: [],
        status: { roundsUsed: 0, maxRounds: 3, final: false, budgetState: 'NORMAL' },
      },
      'req_violation123',
    );
    await vi.waitFor(() => expect(test.dispatcher.requests).toHaveLength(1));
    const request = test.dispatcher.requests[0];
    if (request === undefined) throw new Error('no execution request');

    await test.actor.reportFact({
      workflowRunId: 'wfr_123456',
      unitAttemptId: request.unitAttemptId,
      executionId: request.executionId,
      runEpoch: request.runEpoch,
      executionKind: 'CONTEXT_ASSEMBLE',
      outcome: 'VIOLATION',
      reasonCode: 'SCOPE_MISSING',
      startedAt: '2026-10-21T00:00:00.500Z',
      endedAt: '2026-10-21T00:00:01.000Z',
    });
    await test.actor.drain();
    await test.actor.whenClosed();

    expect(test.run.run.runState).toBe('CLOSED');
    expect(test.run.run.closeReason).toBe('VIOLATION');
    expect(test.events).toContainEqual(
      expect.objectContaining({ type: 'RunClosed', closeReason: 'VIOLATION' }),
    );
    await test.actor.stop();
  });
});
