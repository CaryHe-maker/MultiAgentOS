import {
  createM1ProtocolRegistry,
  type AdmissionProjection,
  type CatalogPort,
  type GatewayForward,
  type PinnedDefinitionSet,
  type PortResult,
  type RunSummary,
  type SystemFaultReporter,
} from '@multiagentos/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { MonitorDuties, SchedulerDuties } from '../interfaces/index.js';
import { DEFAULT_KERNEL_CONFIG as KERNEL_CONFIG } from '../interfaces/kernel-config.js';
import type { AuditSink, CoreAuditEntry } from './audit.js';
import {
  CoreRequestHandler,
  type CoreEvent,
  type CoreExecutionPort,
  type CoreRequestHandlerDeps,
  type CoreSupervisorPort,
} from './request-handler.js';
import { createRunState, type RunState } from './run-state.js';

const agentRef = {
  kind: 'AGENT' as const,
  id: 'planner',
  version: 'v0.1.0',
  digest: 'a'.repeat(64),
};

const unitRef = {
  kind: 'UNIT' as const,
  id: 'file-read',
  version: 'v0.1.0',
  digest: 'd'.repeat(64),
};

function pinned(provider = 'deepseek'): PinnedDefinitionSet {
  return {
    schemaVersion: 'v0',
    agent: {
      schemaVersion: 'v0',
      kind: 'AGENT',
      id: 'planner',
      version: 'v0.1.0',
      digest: agentRef.digest,
      description: 'planner',
      role: 'planner',
      modelRef: { id: 'deepseek-flash', version: 'v1.0.0' },
      modelSettings: { thinking: 'DISABLED' },
      promptRef: { id: 'planner-system', version: 'v0.1.0' },
      unitRefs: [{ id: 'file-read', version: 'v0.1.0' }],
      startUnitRefs: [],
      actions: {
        finish: { toolRef: { id: 'finish-analysis', version: 'v0.1.0' } },
      },
      limits: { maxRounds: 3, maxToolCallsPerRound: 0 },
    },
    model: {
      schemaVersion: 'v0',
      kind: 'MODEL',
      id: 'deepseek-flash',
      version: 'v1.0.0',
      digest: 'b'.repeat(64),
      description: 'model',
      provider,
      apiModelId: 'deepseek-chat',
      providerModelLabel: 'DeepSeek',
      apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
      baseUrl: 'https://api.deepseek.com',
      limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
      features: {
        hasJsonOutput: true,
        hasToolCalls: true,
        hasVision: false,
        thinking: { isSupported: true, isEnabledByDefault: false, effortLevels: [] },
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
        source: { url: 'https://example.com/pricing', verifiedOn: '2026-10-19' },
      },
    },
    prompt: {
      schemaVersion: 'v0',
      kind: 'PROMPT',
      id: 'planner-system',
      version: 'v0.1.0',
      digest: 'c'.repeat(64),
      description: 'prompt',
      role: 'system',
      template: 'analyze',
      variables: [],
      contentStatus: 'FINAL',
    },
    units: [
      {
        schemaVersion: 'v0',
        kind: 'UNIT',
        id: 'file-read',
        version: 'v0.1.0',
        digest: unitRef.digest,
        description: 'read a file',
        executionKind: 'FILE_READ',
        protectedCapabilities: ['repo.read'],
        inputContract: { kind: 'contract', id: 'executor.FileReadInput', version: 'v0' },
        outputContract: { kind: 'contract', id: 'executor.FileReadOutput', version: 'v0' },
        toolRefs: [],
        effect: 'READ_ONLY',
        isIdempotent: true,
        failurePolicy: {},
      },
    ],
    tools: [],
    refs: [agentRef, unitRef],
  } as unknown as PinnedDefinitionSet;
}

function catalogWith(result: PortResult<PinnedDefinitionSet>): CatalogPort {
  return {
    getDefinition: () => Promise.reject(new Error('not used')),
    pinAgent: () => Promise.resolve(result),
    capabilities: () => [],
  };
}

const runSummaryRef = {
  artifactId: `art_${'f'.repeat(64)}`,
  sha256: 'f'.repeat(64),
  size: 10,
  mediaType: 'application/vnd.multiagentos.run-summary+json',
};

function execution(owned = true): CoreExecutionPort {
  return {
    createAttempt: () => Promise.resolve('una_123456'),
    abortQueued: () => ({ inFlight: [] }),
    synthesizeStopUnconfirmed: () => undefined,
    ownsArtifact: () => owned,
    readArtifact: () => Promise.resolve({ ok: true, text: 'artifact text' }),
    collectUnknownEffects: () => [],
    modelRequestCount: () => 0,
    publishRunSummary: () => Promise.resolve(runSummaryRef),
  };
}

const monitor: MonitorDuties = {
  reserve: () => ({ ok: true, reservationId: 'rsv_123456' }),
  settle: () => ({ budgetState: 'NORMAL', anomalies: [] }),
  budgetState: () => 'NORMAL',
  finalize: () => ({
    limit: 600_000,
    used: 0,
    unknown: 0,
    inputTokens: 0,
    outputTokens: 0,
    finalBudgetState: 'NORMAL',
  }),
};

const scheduler: SchedulerDuties = {
  acquire: () => ({ ok: true, grantId: 'grt_123456' }),
  release: () => undefined,
  stopGranting: () => undefined,
  releaseAll: () => 0,
};

function auditSink(): { readonly sink: AuditSink; readonly entries: CoreAuditEntry[] } {
  const entries: CoreAuditEntry[] = [];
  return {
    entries,
    sink: {
      append: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    },
  };
}

function handler(
  options: {
    readonly pinned?: PinnedDefinitionSet;
    readonly owned?: boolean;
    readonly execution?: CoreExecutionPort;
    readonly monitor?: MonitorDuties;
    readonly scheduler?: SchedulerDuties;
    readonly onRunClosed?: (run: RunState) => void;
    readonly admission?: (projection: AdmissionProjection) => void;
    readonly supervisor?: CoreSupervisorPort;
    readonly reportSystemFault?: SystemFaultReporter;
  } = {},
): {
  readonly handler: CoreRequestHandler;
  readonly run: RunState;
  readonly entries: CoreAuditEntry[];
  readonly events: CoreEvent[];
} {
  const audit = auditSink();
  const events: CoreEvent[] = [];
  const run = createRunState({
    workflowRunId: 'wfr_123456',
    correlationId: 'cor_123456',
    goal: 'analyze',
    repositoryRoot: '/repo',
    startedAt: '2026-10-19T00:00:00.000Z',
  });
  const deps: CoreRequestHandlerDeps = {
    catalog: catalogWith({ ok: true, value: options.pinned ?? pinned() }),
    registry: createM1ProtocolRegistry(),
    execution: options.execution ?? execution(options.owned ?? true),
    monitor: options.monitor ?? monitor,
    scheduler: options.scheduler ?? scheduler,
    audit: audit.sink,
    config: KERNEL_CONFIG,
    events: {
      emit: (event) => {
        events.push(event);
      },
    },
    ...(options.onRunClosed === undefined ? {} : { onRunClosed: options.onRunClosed }),
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    ...(options.supervisor === undefined ? {} : { supervisor: options.supervisor }),
    ...(options.reportSystemFault === undefined
      ? {}
      : { reportSystemFault: options.reportSystemFault }),
    now: () => new Date('2026-10-19T00:00:01.000Z'),
  };
  return {
    handler: new CoreRequestHandler(deps),
    run,
    entries: audit.entries,
    events,
  };
}

function context(): {
  readonly tenantId: string;
  readonly projectId: string;
  readonly correlationId: string;
  readonly workflowRunId: string;
} {
  return {
    tenantId: 'local',
    projectId: 'local',
    correlationId: 'cor_123456',
    workflowRunId: 'wfr_123456',
  };
}

function registerForward(
  requestId = 'req_reg123',
): Extract<GatewayForward, { requestType: 'registerAgentRun' }> {
  return {
    caller: 'workflow',
    requestType: 'registerAgentRun',
    request: { requestId, workflowRunId: 'wfr_123456', agentRunId: 'agr_123456', agentRef },
  };
}

function submitForward(
  requestId = 'req_sub123',
  unit = unitRef,
  input: unknown = { path: 'src/file.ts' },
): Extract<GatewayForward, { requestType: 'submitUnit' }> {
  return {
    caller: 'workflow',
    requestType: 'submitUnit',
    request: {
      requestId,
      workflowRunId: 'wfr_123456',
      agentRunId: 'agr_123456',
      unitRef: unit,
      input: input as never,
    },
  };
}

function endForward(
  requestId = 'req_end123',
): Extract<GatewayForward, { requestType: 'endAgentRun' }> {
  return {
    caller: 'workflow',
    requestType: 'endAgentRun',
    request: { requestId, workflowRunId: 'wfr_123456', agentRunId: 'agr_123456' },
  };
}

const reportRef = {
  artifactId: `art_${'e'.repeat(64)}`,
  sha256: 'e'.repeat(64),
  size: 10,
  mediaType: 'application/vnd.multiagentos.analysis-report+json',
};

function closeForward(
  requestId = 'req_close1',
  outcome: 'COMPLETED' | 'FAILED' = 'COMPLETED',
): Extract<GatewayForward, { requestType: 'closeRun' }> {
  return {
    caller: 'workflow',
    requestType: 'closeRun',
    request: {
      requestId,
      workflowRunId: 'wfr_123456',
      ...(outcome === 'COMPLETED'
        ? { outcome: 'COMPLETED', reportRef }
        : {
            outcome: 'FAILED',
            failure: { code: 'WORKFLOW_INTERNAL', category: 'INTERNAL', source: 'WORKFLOW' },
          }),
    },
  };
}

async function register(handler: CoreRequestHandler, run: RunState): Promise<void> {
  await handler.handleForward(registerForward(), context(), run);
}

describe('CoreRequestHandler registerAgentRun', () => {
  it('pins the agent, checks digest/provider and records the AgentRun', async () => {
    const { handler: core, run, entries } = handler();
    await expect(core.handleForward(registerForward(), context(), run)).resolves.toEqual({
      requestId: 'req_reg123',
      outcome: 'ACCEPTED',
    });
    expect(run.agentRuns.get('agr_123456')).toMatchObject({
      state: 'ACTIVE',
      agentRef,
      rounds: 0,
    });
    expect(entries.map((entry) => entry.type)).toContain('AGENT_RUN_REGISTERED');
  });

  it('replays the request and rejects a duplicate agentRunId or a second active AgentRun', async () => {
    const { handler: core, run, entries } = handler();
    await register(core, run);
    await expect(core.handleForward(registerForward(), context(), run)).resolves.toEqual({
      requestId: 'req_reg123',
      outcome: 'ACCEPTED',
    });

    await expect(
      core.handleForward(
        {
          ...registerForward('req_reg456'),
          request: { ...registerForward('req_reg456').request, agentRunId: 'agr_123456' },
        },
        context(),
        run,
      ),
    ).resolves.toMatchObject({ reasonCode: 'AGENT_RUN_EXISTS' });

    await expect(
      core.handleForward(
        {
          ...registerForward('req_reg789'),
          request: { ...registerForward('req_reg789').request, agentRunId: 'agr_654321' },
        },
        context(),
        run,
      ),
    ).resolves.toMatchObject({ reasonCode: 'AGENT_RUN_ACTIVE' });
    expect(entries.filter((entry) => entry.type === 'REQUEST_REJECTED')).toHaveLength(2);
  });

  it('rejects digest, provider and catalog failures', async () => {
    const { handler: core, run } = handler();
    await expect(
      core.handleForward(
        {
          ...registerForward('req_digest'),
          request: {
            ...registerForward('req_digest').request,
            agentRef: { ...agentRef, digest: 'f'.repeat(64) },
          },
        },
        context(),
        run,
      ),
    ).resolves.toMatchObject({ reasonCode: 'DEFINITION_MISMATCH' });

    const provider = handler({ pinned: pinned('other-provider') });
    await expect(
      provider.handler.handleForward(registerForward(), context(), provider.run),
    ).resolves.toMatchObject({ reasonCode: 'FORBIDDEN' });

    const unavailable = new CoreRequestHandler({
      catalog: catalogWith({
        ok: false,
        error: {
          code: 'CATALOG_DEFINITION_UNAVAILABLE',
          category: 'DEPENDENCY',
          message: 'missing',
          retryable: false,
          correlationId: 'cor_123456',
        },
      }),
      registry: {} as CoreRequestHandlerDeps['registry'],
      execution: execution(),
      monitor,
      scheduler,
      audit: auditSink().sink,
      config: KERNEL_CONFIG,
    });
    await expect(
      unavailable.handleForward(
        registerForward(),
        context(),
        createRunState({
          workflowRunId: 'wfr_123456',
          correlationId: 'cor_123456',
          goal: 'x',
          repositoryRoot: '/repo',
          startedAt: '2026-10-19T00:00:00.000Z',
        }),
      ),
    ).resolves.toMatchObject({ reasonCode: 'DEFINITION_UNAVAILABLE' });
  });

  it('rejects the same requestId with different content', async () => {
    const { handler: core, run } = handler();
    await register(core, run);
    await expect(
      core.handleForward(
        {
          ...registerForward(),
          request: { ...registerForward().request, agentRef: { ...agentRef, id: 'other' } },
        },
        context(),
        run,
      ),
    ).resolves.toMatchObject({ reasonCode: 'REQUEST_CONFLICT' });
  });
});

describe('CoreRequestHandler endAgentRun and submitUnit', () => {
  it('ends an active AgentRun and rejects unknown or repeated ends', async () => {
    const { handler: core, run, entries } = handler();
    await expect(
      core.handleForward(endForward('req_end000'), context(), run),
    ).resolves.toMatchObject({
      reasonCode: 'AGENT_RUN_NOT_FOUND',
    });

    await register(core, run);
    await expect(core.handleForward(endForward(), context(), run)).resolves.toEqual({
      requestId: 'req_end123',
      outcome: 'ACCEPTED',
    });
    expect(run.agentRuns.get('agr_123456')?.state).toBe('ENDED');
    expect(entries.map((entry) => entry.type)).toContain('AGENT_RUN_ENDED');
    await expect(
      core.handleForward(endForward('req_end456'), context(), run),
    ).resolves.toMatchObject({ reasonCode: 'AGENT_RUN_ENDED' });
  });

  it('checks AgentRun, unit membership and input schema', async () => {
    const { handler: core, run } = handler();
    await expect(core.handleForward(submitForward(), context(), run)).resolves.toMatchObject({
      reasonCode: 'AGENT_RUN_NOT_FOUND',
    });

    await register(core, run);
    await expect(
      core.handleForward(
        submitForward('req_other1', { ...unitRef, id: 'other-unit' }),
        context(),
        run,
      ),
    ).resolves.toMatchObject({ reasonCode: 'FORBIDDEN' });

    await expect(
      core.handleForward(submitForward('req_input1', unitRef, { path: 42 }), context(), run),
    ).resolves.toMatchObject({ reasonCode: 'INVALID_INPUT' });

    await expect(core.handleForward(submitForward('req_ok001'), context(), run)).resolves.toEqual({
      requestId: 'req_ok001',
      outcome: 'ACCEPTED',
    });
    expect(run.units.submitted).toBe(1);
    await expect(core.handleForward(submitForward('req_ok001'), context(), run)).resolves.toEqual({
      requestId: 'req_ok001',
      outcome: 'ACCEPTED',
    });
    expect(run.units.submitted).toBe(1);
  });

  it('rejects an unsupported executionKind before creating an attempt', async () => {
    const base = pinned();
    const [firstUnit] = base.units;
    if (firstUnit === undefined) throw new Error('fixture has no unit');
    const command = { ...firstUnit, executionKind: 'COMMAND' as const };
    const { handler: core, run } = handler({
      pinned: { ...base, units: [command] },
    });
    await register(core, run);
    await expect(
      core.handleForward(submitForward('req_unsup1'), context(), run),
    ).resolves.toMatchObject({ reasonCode: 'UNSUPPORTED_CAPABILITY' });
    expect(run.units.submitted).toBe(0);
  });

  it('rejects a submit for an ended AgentRun', async () => {
    const { handler: core, run } = handler();
    await register(core, run);
    await core.handleForward(endForward(), context(), run);
    await expect(core.handleForward(submitForward(), context(), run)).resolves.toMatchObject({
      reasonCode: 'AGENT_RUN_ENDED',
    });
  });
});

describe('CoreRequestHandler state matrix', () => {
  it('blocks new work and keeps terminal-oriented requests per Interaction 4.5', async () => {
    const { handler: core, run } = handler();
    await register(core, run);
    run.runState = 'CONVERGING';
    run.closeReason = 'CANCELLED';

    await expect(
      core.handleForward(registerForward('req_conv01'), context(), run),
    ).resolves.toMatchObject({ reasonCode: 'RUN_BLOCKED', closeReason: 'CANCELLED' });
    await expect(
      core.handleForward(submitForward('req_conv02'), context(), run),
    ).resolves.toMatchObject({ reasonCode: 'RUN_BLOCKED', closeReason: 'CANCELLED' });
    await expect(core.handleForward(endForward('req_conv03'), context(), run)).resolves.toEqual({
      requestId: 'req_conv03',
      outcome: 'ACCEPTED',
    });
    await expect(core.handleForward(closeForward('req_conv04'), context(), run)).resolves.toEqual({
      requestId: 'req_conv04',
      outcome: 'ACCEPTED',
    });
    await expect(
      core.handleForward(
        {
          caller: 'user-interaction',
          requestType: 'answerAuthorization',
          request: {
            requestId: 'req_conv05',
            workflowRunId: 'wfr_123456',
            questionId: 'qst_123456',
            answer: 'YES',
          },
        },
        context(),
        run,
      ),
    ).resolves.toMatchObject({ reasonCode: 'QUESTION_NOT_PENDING' });
  });

  it('uses the CLOSED row of the state matrix', async () => {
    const { handler: core, run } = handler();
    await register(core, run);
    run.runState = 'CLOSED';
    run.closeReason = 'COMPLETED';

    await expect(
      core.handleForward(registerForward('req_closed1'), context(), run),
    ).resolves.toMatchObject({ reasonCode: 'RUN_BLOCKED', closeReason: 'COMPLETED' });
    await expect(
      core.handleForward(submitForward('req_closed2'), context(), run),
    ).resolves.toMatchObject({ reasonCode: 'RUN_BLOCKED', closeReason: 'COMPLETED' });
    await expect(core.handleForward(endForward('req_closed3'), context(), run)).resolves.toEqual({
      requestId: 'req_closed3',
      outcome: 'ACCEPTED',
    });
    await expect(core.handleForward(closeForward('req_closed4'), context(), run)).resolves.toEqual({
      requestId: 'req_closed4',
      outcome: 'ACCEPTED',
    });
    await expect(
      core.handleForward(
        {
          caller: 'user-interaction',
          requestType: 'cancelRun',
          request: { requestId: 'req_closed5', workflowRunId: 'wfr_123456' },
        },
        context(),
        run,
      ),
    ).resolves.toEqual({ requestId: 'req_closed5', outcome: 'ACCEPTED' });
    await expect(
      core.handleForward(
        {
          caller: 'user-interaction',
          requestType: 'answerAuthorization',
          request: {
            requestId: 'req_closed6',
            workflowRunId: 'wfr_123456',
            questionId: 'qst_123456',
            answer: 'YES',
          },
        },
        context(),
        run,
      ),
    ).resolves.toMatchObject({ reasonCode: 'QUESTION_NOT_PENDING' });
    await expect(
      core.handleForward(
        {
          caller: 'user-interaction',
          requestType: 'readArtifact',
          request: { requestId: 'req_closed7', workflowRunId: 'wfr_123456', ref: reportRef },
        },
        context(),
        run,
      ),
    ).resolves.toMatchObject({ outcome: 'ACCEPTED', text: 'artifact text' });
    expect(run.runEpoch).toBe(1);
  });

  it('starts convergence on closeRun and cancelRun and does not repeat it', async () => {
    const { handler: core, run } = handler();
    await register(core, run);
    await expect(core.handleForward(closeForward(), context(), run)).resolves.toEqual({
      requestId: 'req_close1',
      outcome: 'ACCEPTED',
    });
    expect(run.runState).toBe('CLOSED');
    expect(run.runEpoch).toBe(2);
    expect(run.closeReason).toBe('COMPLETED');
    expect(run.reportRef).toEqual(reportRef);

    await expect(core.handleForward(closeForward('req_close2'), context(), run)).resolves.toEqual({
      requestId: 'req_close2',
      outcome: 'ACCEPTED',
    });
    expect(run.runEpoch).toBe(2);

    const cancelled = handler();
    await register(cancelled.handler, cancelled.run);
    await expect(
      cancelled.handler.handleForward(
        {
          caller: 'user-interaction',
          requestType: 'cancelRun',
          request: { requestId: 'req_cancel1', workflowRunId: 'wfr_123456' },
        },
        context(),
        cancelled.run,
      ),
    ).resolves.toEqual({ requestId: 'req_cancel1', outcome: 'ACCEPTED' });
    expect(cancelled.run.runState).toBe('CLOSED');
    expect(cancelled.run.closeReason).toBe('CANCELLED');
    expect(cancelled.run.runEpoch).toBe(2);
  });

  it('starts convergence on FAILED closeRun with the Workflow failure', async () => {
    const { handler: core, run } = handler();
    await core.handleForward(closeForward('req_fail01', 'FAILED'), context(), run);
    expect(run.runState).toBe('CLOSED');
    expect(run.closeReason).toBe('FAILED');
    expect(run.failure).toEqual({
      code: 'WORKFLOW_INTERNAL',
      category: 'INTERNAL',
      source: 'WORKFLOW',
    });
  });

  it('rejects a completed closeRun whose reportRef is not owned and leaves the run RUNNING', async () => {
    const { handler: core, run } = handler({ owned: false });
    await expect(core.handleForward(closeForward(), context(), run)).resolves.toMatchObject({
      reasonCode: 'INVALID_ARTIFACT_REF',
    });
    expect(run.runState).toBe('RUNNING');
    expect(run.runEpoch).toBe(1);
  });
});

describe('CoreRequestHandler artifacts', () => {
  it('reads an owned artifact in RUNNING and CLOSED states', async () => {
    const { handler: core, run } = handler();
    const read = {
      caller: 'user-interaction' as const,
      requestType: 'readArtifact' as const,
      request: { requestId: 'req_read01', workflowRunId: 'wfr_123456', ref: reportRef },
    };
    await expect(core.handleForward(read, context(), run)).resolves.toMatchObject({
      outcome: 'ACCEPTED',
      ref: reportRef,
      text: 'artifact text',
    });
    run.runState = 'CLOSED';
    run.closeReason = 'COMPLETED';
    await expect(
      core.handleForward(
        { ...read, request: { ...read.request, requestId: 'req_read02' } },
        context(),
        run,
      ),
    ).resolves.toMatchObject({ outcome: 'ACCEPTED', text: 'artifact text' });
  });

  it('rejects an artifact that is not owned', async () => {
    const { handler: core, run } = handler({ owned: false });
    await expect(
      core.handleForward(
        {
          caller: 'user-interaction',
          requestType: 'readArtifact',
          request: { requestId: 'req_read03', workflowRunId: 'wfr_123456', ref: reportRef },
        },
        context(),
        run,
      ),
    ).resolves.toMatchObject({ reasonCode: 'INVALID_ARTIFACT_REF' });
  });
});

describe('CoreRequestHandler authorization', () => {
  function answerForward(
    questionId: string,
    answer: 'YES' | 'NO',
    requestId = 'req_answer1',
  ): Extract<GatewayForward, { requestType: 'answerAuthorization' }> {
    return {
      caller: 'user-interaction',
      requestType: 'answerAuthorization',
      request: { requestId, workflowRunId: 'wfr_123456', questionId, answer },
    };
  }

  function questionIdOf(events: readonly CoreEvent[]): string {
    const request = events.find((event) => event.type === 'AuthorizationRequest');
    if (request === undefined) throw new Error('no authorization request');
    return request.questionId;
  }

  it('asks once, holds protected requests and allows them after YES', async () => {
    const createAttempt = vi.fn(() => Promise.resolve('una_123456'));
    const {
      handler: core,
      run,
      entries,
      events,
    } = handler({
      execution: { ...execution(), createAttempt },
    });
    await register(core, run);
    await expect(core.handleForward(submitForward('req_auth001'), context(), run)).resolves.toEqual(
      { requestId: 'req_auth001', outcome: 'ACCEPTED' },
    );

    const questionId = questionIdOf(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'AuthorizationRequest',
      questionId,
      capability: 'repo.read',
      repositoryPath: '/repo',
      provider: 'deepseek',
      expiresAt: '2026-10-19T00:05:01.000Z',
    });
    const requestEvent = events[0];
    if (requestEvent?.type !== 'AuthorizationRequest') throw new Error('wrong event');
    expect(requestEvent.exclusions).toEqual(
      expect.arrayContaining(['**/.env*', '**/node_modules/**']),
    );
    expect(run.unitDecisions.get('req_auth001')).toEqual({
      kind: 'PENDING',
      questionId,
    });
    expect(run.awaitingAuthorization.get('req_auth001')).toMatchObject({
      agentRunId: 'agr_123456',
      input: { path: 'src/file.ts' },
    });
    expect(entries.map((entry) => entry.type)).toContain('AUTHORIZATION_ASKED');

    await expect(core.handleForward(submitForward('req_auth002'), context(), run)).resolves.toEqual(
      { requestId: 'req_auth002', outcome: 'ACCEPTED' },
    );
    expect(run.unitDecisions.get('req_auth002')).toEqual({ kind: 'PENDING', questionId });
    expect(run.awaitingAuthorization.size).toBe(2);
    expect(events.filter((event) => event.type === 'AuthorizationRequest')).toHaveLength(1);

    await expect(
      core.handleForward(answerForward(questionId, 'YES'), context(), run),
    ).resolves.toEqual({ requestId: 'req_answer1', outcome: 'ACCEPTED' });
    expect(events).toContainEqual({
      type: 'AuthorizationResolved',
      questionId,
      resolution: 'GRANTED',
    });
    expect(core.isLeaseValid(run)).toBe(true);
    const decision = run.unitDecisions.get('req_auth001');
    expect(decision).toMatchObject({ kind: 'ALLOWED' });
    if (decision?.kind !== 'ALLOWED') throw new Error('decision was not allowed');
    expect(decision.scope).toMatchObject({
      kind: 'REPOSITORY',
      repositoryRoot: '/repo',
    });
    expect(run.awaitingAuthorization.has('req_auth001')).toBe(false);
    expect(entries.map((entry) => entry.type)).toContain('AUTHORIZATION_RESOLVED');

    await expect(core.handleForward(submitForward('req_auth002'), context(), run)).resolves.toEqual(
      { requestId: 'req_auth002', outcome: 'ACCEPTED' },
    );
    expect(run.unitDecisions.get('req_auth002')).toMatchObject({ kind: 'ALLOWED' });
    expect(events.filter((event) => event.type === 'AuthorizationRequest')).toHaveLength(1);
  });

  it('retains a denial and does not ask again', async () => {
    const { handler: core, run, events } = handler();
    await register(core, run);
    await core.handleForward(submitForward('req_auth003'), context(), run);
    const questionId = questionIdOf(events);
    await core.handleForward(answerForward(questionId, 'NO'), context(), run);

    expect(run.unitDecisions.get('req_auth003')).toEqual({
      kind: 'DECLINED',
      reasonCode: 'USER_DECLINED',
    });
    expect(core.isLeaseValid(run)).toBe(false);
    await core.handleForward(submitForward('req_auth004'), context(), run);
    expect(run.unitDecisions.get('req_auth004')).toEqual({
      kind: 'DECLINED',
      reasonCode: 'USER_DECLINED',
    });
    expect(events.filter((event) => event.type === 'AuthorizationRequest')).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'AuthorizationResolved',
      questionId,
      resolution: 'DECLINED',
    });
  });

  it('rejects a stale or wrong answer', async () => {
    const { handler: core, run } = handler();
    await register(core, run);
    await core.handleForward(submitForward('req_auth005'), context(), run);
    await expect(
      core.handleForward(answerForward('qst_wrong', 'YES'), context(), run),
    ).resolves.toMatchObject({ reasonCode: 'QUESTION_NOT_PENDING' });
  });

  it('times out and cancels pending questions through the public hooks', async () => {
    const expired = handler();
    await register(expired.handler, expired.run);
    await expired.handler.handleForward(submitForward('req_auth006'), context(), expired.run);
    const expiredResult = await expired.handler.expireAuthorization(expired.run);
    expect(expiredResult?.resolution).toBe('TIMED_OUT');
    expect(expired.run.unitDecisions.get('req_auth006')).toEqual({
      kind: 'DECLINED',
      reasonCode: 'USER_DECLINED',
    });

    const cancelled = handler();
    await register(cancelled.handler, cancelled.run);
    await cancelled.handler.handleForward(submitForward('req_auth007'), context(), cancelled.run);
    cancelled.run.runState = 'CONVERGING';
    cancelled.run.closeReason = 'CANCELLED';
    const cancelledResult = await cancelled.handler.cancelAuthorization(cancelled.run);
    expect(cancelledResult?.resolution).toBe('CANCELLED');
    expect(cancelled.run.unitDecisions.get('req_auth007')).toEqual({ kind: 'CANCELLED' });
  });
});

describe('CoreRequestHandler convergence', () => {
  it('waits for in-flight executions and completes on the convergence deadline', async () => {
    const synthesize = vi.fn();
    const onRunClosed = vi.fn();
    const admissions: AdmissionProjection[] = [];
    const cancelRun = vi.fn(() => Promise.resolve());
    const unknownEffects = [
      {
        unitAttemptId: 'una_pending',
        executionId: 'exe_pending',
        executionKind: 'MODEL' as const,
        effect: 'EXECUTION_STOP_UNCONFIRMED' as const,
      },
    ];
    const test = handler({
      onRunClosed,
      admission: (projection) => admissions.push(projection),
      supervisor: { cancelRun },
      execution: {
        ...execution(),
        abortQueued: () => ({
          inFlight: [{ unitAttemptId: 'una_pending', executionId: 'exe_pending' }],
        }),
        synthesizeStopUnconfirmed: synthesize,
        collectUnknownEffects: () => unknownEffects,
      },
    });

    await test.handler.handleForward(closeForward('req_closePend'), context(), test.run);
    expect(test.run.runState).toBe('CONVERGING');
    expect(test.events.some((event) => event.type === 'RunClosed')).toBe(false);

    await test.handler.convergenceDeadline(test.run);
    await test.handler.whenConverged(test.run);

    expect(synthesize).toHaveBeenCalledWith(['exe_pending']);
    expect(cancelRun).toHaveBeenCalledWith({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    expect(admissions).toEqual([
      { workflowRunId: 'wfr_123456', runState: 'CONVERGING', closeReason: 'COMPLETED' },
      { workflowRunId: 'wfr_123456', runState: 'CLOSED', closeReason: 'COMPLETED' },
    ]);
    expect(test.run.runState).toBe('CLOSED');
    expect(onRunClosed).toHaveBeenCalledWith(test.run);
    expect(test.entries.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['CONVERGENCE_STARTED', 'CONVERGENCE_DEADLINE', 'RUN_CLOSED']),
    );
    const closed = test.events.find((event) => event.type === 'RunClosed');
    const finished = test.events.find((event) => event.type === 'RunFinished');
    expect(closed).toMatchObject({
      type: 'RunClosed',
      closeReason: 'COMPLETED',
      unknownEffects,
    });
    expect(finished).toMatchObject({
      type: 'RunFinished',
      closeReason: 'COMPLETED',
      unknownEffects,
    });
  });

  it('cancels a run on shutdown and normalizes counters in RunSummary', async () => {
    let published: RunSummary | undefined;
    const test = handler({
      execution: {
        ...execution(),
        publishRunSummary: (summary) => {
          published = summary;
          return Promise.resolve(runSummaryRef);
        },
      },
    });
    await register(test.handler, test.run);
    test.run.units.submitted = 3;
    test.run.units.ok = 2;
    await test.handler.shutdownRun(test.run);

    expect(published?.units).toEqual({
      submitted: 3,
      ok: 2,
      rejected: 0,
      failed: 0,
      notDelivered: 1,
    });
    expect(test.run.runState).toBe('CLOSED');
    expect(test.run.closeReason).toBe('CANCELLED');
    expect(test.events).toContainEqual(
      expect.objectContaining({ type: 'RunClosed', closeReason: 'CANCELLED' }),
    );
    expect(test.events).toContainEqual(
      expect.objectContaining({ type: 'RunFinished', closeReason: 'CANCELLED' }),
    );
  });

  it('cancels a pending authorization question during convergence', async () => {
    const test = handler();
    await register(test.handler, test.run);
    await test.handler.handleForward(submitForward('req_authClose'), context(), test.run);
    const request = test.events.find((event) => event.type === 'AuthorizationRequest');
    if (request?.type !== 'AuthorizationRequest') throw new Error('no authorization request');

    await test.handler.handleForward(
      {
        caller: 'user-interaction',
        requestType: 'cancelRun',
        request: { requestId: 'req_cancelClose', workflowRunId: 'wfr_123456' },
      },
      context(),
      test.run,
    );
    await test.handler.whenConverged(test.run);

    expect(test.run.unitDecisions.get('req_authClose')).toEqual({ kind: 'CANCELLED' });
    expect(test.events).toContainEqual({
      type: 'AuthorizationResolved',
      questionId: request.questionId,
      resolution: 'CANCELLED',
    });
    expect(
      test.events.some(
        (event) => event.type === 'UnitReport' && event.requestId === 'req_authClose',
      ),
    ).toBe(false);
    expect(test.run.units.notDelivered).toBe(1);
  });

  it('aborts a RUNNING run with KERNEL_INTERNAL and the faultId', async () => {
    const test = handler();
    await test.handler.abortRun(test.run, 'fault-001');
    expect(test.run.runState).toBe('CLOSED');
    expect(test.run.closeReason).toBe('FAILED');
    expect(test.run.failure).toMatchObject({
      code: 'KERNEL_INTERNAL',
      source: 'KERNEL',
      detail: 'fault-001',
    });
    expect(test.entries).toContainEqual(
      expect.objectContaining({ type: 'SYSTEM_FAULT_ABORT', faultId: 'fault-001' }),
    );
  });

  it('ends a RUNNING run as RUN_TIMEOUT', async () => {
    const test = handler();
    await test.handler.runTimedOut(test.run);
    expect(test.run.runState).toBe('CLOSED');
    expect(test.run.closeReason).toBe('RUN_TIMEOUT');
    expect(test.events).toContainEqual(
      expect.objectContaining({ type: 'RunClosed', closeReason: 'RUN_TIMEOUT' }),
    );
  });

  it('keeps terminal events usable when RunSummary publication fails', async () => {
    const test = handler({
      execution: {
        ...execution(),
        publishRunSummary: () => Promise.reject(new Error('disk is full')),
      },
    });
    await test.handler.handleForward(closeForward('req_closeSum'), context(), test.run);
    expect(test.run.runState).toBe('CLOSED');
    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: 'RunClosed',
        closeReason: 'COMPLETED',
        finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
      }),
    );
    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: 'RunFinished',
        closeReason: 'COMPLETED',
        finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
      }),
    );
  });
});

describe('CoreRequestHandler non-halting exceptions', () => {
  it('handles KERNEL_FAULT as FAILED(KERNEL_INTERNAL) with the faultId', async () => {
    const test = handler();
    await expect(
      test.handler.handleCoreException(test.run, { kind: 'KERNEL_FAULT', faultId: 'fault-9' }),
    ).resolves.toBe('HANDLED');
    expect(test.run.runState).toBe('CLOSED');
    expect(test.run.closeReason).toBe('FAILED');
    expect(test.run.failure).toMatchObject({
      code: 'KERNEL_INTERNAL',
      source: 'KERNEL',
      detail: 'fault-9',
    });
    expect(test.entries).toContainEqual(
      expect.objectContaining({ type: 'SYSTEM_FAULT_ABORT', faultId: 'fault-9' }),
    );
  });

  it('only audits a KERNEL_FAULT after the run has closed', async () => {
    const test = handler();
    test.run.runState = 'CLOSED';
    test.run.closeReason = 'COMPLETED';
    await expect(
      test.handler.handleCoreException(test.run, { kind: 'KERNEL_FAULT', faultId: 'fault-10' }),
    ).resolves.toBe('ALREADY_CLOSED');
    expect(test.run.closeReason).toBe('COMPLETED');
    expect(test.entries).toContainEqual(
      expect.objectContaining({ type: 'SYSTEM_FAULT_ABORT', faultId: 'fault-10' }),
    );
  });

  it('routes RUN_TIMEOUT, VIOLATION and STOP_UNCONFIRMED to convergence', async () => {
    const timedOut = handler();
    await timedOut.handler.handleCoreException(timedOut.run, { kind: 'RUN_TIMEOUT' });
    expect(timedOut.run.closeReason).toBe('RUN_TIMEOUT');

    const violation = handler();
    await violation.handler.handleCoreException(violation.run, {
      kind: 'VIOLATION',
      reasonCode: 'PATH_ESCAPE',
      unitRequestId: 'req_viol001',
    });
    expect(violation.run.runState).toBe('CLOSED');
    expect(violation.run.closeReason).toBe('VIOLATION');
    expect(violation.run.failure).toMatchObject({
      code: 'PATH_ESCAPE',
      category: 'INTEGRITY',
      source: 'KERNEL',
      unitRequestId: 'req_viol001',
    });

    const stopped = handler();
    await stopped.handler.handleCoreException(stopped.run, {
      kind: 'STOP_UNCONFIRMED',
      unitRequestId: 'req_stop001',
    });
    expect(stopped.run.runState).toBe('CLOSED');
    expect(stopped.run.closeReason).toBe('FAILED');
    expect(stopped.run.failure).toMatchObject({
      code: 'EXECUTION_STOP_UNCONFIRMED',
      source: 'KERNEL',
      unitRequestId: 'req_stop001',
    });
  });

  it('expires authorization without stopping the run', async () => {
    const test = handler();
    await register(test.handler, test.run);
    await test.handler.handleForward(submitForward('req_authExp'), context(), test.run);
    await expect(
      test.handler.handleCoreException(test.run, { kind: 'AUTHORIZATION_TIMEOUT' }),
    ).resolves.toBe('HANDLED');
    expect(test.run.runState).toBe('RUNNING');
    expect(test.run.unitDecisions.get('req_authExp')).toEqual({
      kind: 'DECLINED',
      reasonCode: 'USER_DECLINED',
    });
    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: 'UnitReport',
        requestId: 'req_authExp',
        reasonCode: 'USER_DECLINED',
      }),
    );
  });

  it('keeps execution failures and settlement anomalies on the structured path', async () => {
    const test = handler();
    await expect(
      test.handler.handleCoreException(test.run, {
        kind: 'EXECUTION_FAILED',
        reasonCode: 'UNIT_TIMEOUT',
        retryable: true,
      }),
    ).resolves.toBe('IGNORED');
    await expect(
      test.handler.handleCoreException(test.run, {
        kind: 'SETTLEMENT_ANOMALY',
        unitAttemptId: 'una_123456',
        anomaly: 'ACTUAL_EXCEEDED_ESTIMATE',
      }),
    ).resolves.toBe('IGNORED');
    expect(test.run.runState).toBe('RUNNING');
  });

  it('requests panic when convergence itself fails', async () => {
    const reportSystemFault = vi.fn<SystemFaultReporter>();
    const test = handler({
      reportSystemFault,
      monitor: {
        ...monitor,
        finalize: () => {
          throw new Error('ledger failure');
        },
      },
    });
    await test.handler.handleForward(closeForward('req_closeFail'), context(), test.run);
    await expect(test.handler.whenConverged(test.run)).rejects.toThrow('ledger failure');
    expect(reportSystemFault).toHaveBeenCalledTimes(1);
    const fault = reportSystemFault.mock.calls[0]?.[0];
    expect(fault).toMatchObject({
      source: 'kernel-core',
      phase: 'RUN',
      workflowRunId: 'wfr_123456',
    });
    expect(fault?.error).toBeInstanceOf(Error);
  });
});

describe('CoreRequestHandler audit coverage', () => {
  it('records the Core lifecycle audit types without sensitive payloads', async () => {
    const test = handler();
    await register(test.handler, test.run);
    await test.handler.handleForward(submitForward('req_audit01'), context(), test.run);
    const question = test.events.find((event) => event.type === 'AuthorizationRequest');
    if (question?.type !== 'AuthorizationRequest') throw new Error('no authorization request');
    await test.handler.handleForward(
      {
        caller: 'user-interaction',
        requestType: 'answerAuthorization',
        request: {
          requestId: 'req_answerAudit',
          workflowRunId: 'wfr_123456',
          questionId: question.questionId,
          answer: 'NO',
        },
      },
      context(),
      test.run,
    );
    await test.handler.handleForward(endForward('req_endAudit'), context(), test.run);
    await test.handler.handleForward(closeForward('req_closeAudit', 'FAILED'), context(), test.run);

    const types = new Set(test.entries.map((entry) => entry.type));
    expect([...types]).toEqual(
      expect.arrayContaining([
        'AGENT_RUN_REGISTERED',
        'AUTHORIZATION_ASKED',
        'UNIT_ACCEPTED',
        'AUTHORIZATION_RESOLVED',
        'UNIT_REPORTED',
        'AGENT_RUN_ENDED',
        'CONVERGENCE_STARTED',
        'RUN_CLOSED',
      ]),
    );
    const serialized = JSON.stringify(test.entries);
    expect(serialized).not.toMatch(/lease|credential|prompt|sourceText/i);
  });
});
