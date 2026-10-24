import {
  ContextAssembleInputSchema,
  PinnedDefinitionSetSchema,
  StepRecordSchema,
  SubmitUnitRequestSchema,
  UnitReportSchema,
  createM1ProtocolRegistry,
  MEDIA_TYPES,
  newId,
  validate,
} from '@multiagentos/contracts';
import type {
  ModelCallOutput,
  StepRecord,
  SubmitUnitRequest,
  UnitReport,
} from '@multiagentos/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_CONFIG } from '../index.js';
import { cycleDefinitions } from '../test-support/cycle-definitions.js';
import type { AgentRunState } from './state.js';
import { receiveUnitReport, startUnitCycle } from './unit-cycle.js';
import type { CycleEnvironment, CycleTransition } from './unit-cycle.js';

const contextOutput = {
  contextPackId: newId('ctx'),
  tokenCount: 10,
  tokenBudget: 100,
  truncated: false,
  droppedCount: 0,
  prefixSha256: 'a'.repeat(64),
  elidedRequestIds: [],
};
const readOutput = {
  path: 'src/cache.ts',
  startLine: 1,
  endLine: 10,
  totalLines: 10,
  contentSha256: 'a'.repeat(64),
  fileSha256: 'b'.repeat(64),
};
const finish: ModelCallOutput = {
  hasText: false,
  finishReason: 'TOOL_CALLS',
  toolCalls: [
    {
      toolCallId: 'finish',
      toolName: 'finish_analysis',
      arguments: {
        summary: '分析结果',
        conclusions: [],
        unconfirmed: [],
      },
    },
  ],
};
const tools: ModelCallOutput = {
  hasText: false,
  finishReason: 'TOOL_CALLS',
  toolCalls: [
    { toolCallId: 'read-1', toolName: 'read_file', arguments: { path: 'src/cache.ts' } },
    { toolCallId: 'read-2', toolName: 'read_file', arguments: { path: 'src/other.ts' } },
  ],
};

function setup(hasStartup = false, extra: Partial<AgentRunState> = {}) {
  const definitions = cycleDefinitions(hasStartup);
  const workflowRunId = newId('wfr');
  const environment = (): CycleEnvironment => ({
    workflowRunId,
    goal: '分析缓存问题',
    registry: createM1ProtocolRegistry(),
    config: DEFAULT_WORKFLOW_CONFIG,
    pinnedSets: [definitions],
    requestIds: Array.from({ length: 32 }, () => newId('req')),
  });
  const run: AgentRunState = {
    agentRunId: newId('agr'),
    definitions,
    roundsUsed: 0,
    regenerationCount: 0,
    noProgressCount: 0,
    steps: [],
    pendingRequestIds: new Set(),
    elidedRequestIds: [],
    ...extra,
  };
  return { run, environment };
}

function requestOf(transition: CycleTransition, index = 0): SubmitUnitRequest {
  const request = transition.submissions[index];
  if (request === undefined) throw new Error('Missing expected submission');
  expect(validate(SubmitUnitRequestSchema, request).ok).toBe(true);
  return request;
}

function ok(
  request: SubmitUnitRequest,
  kind: 'CONTEXT_ASSEMBLE' | 'MODEL' | 'FILE_READ',
  output: unknown,
  budgetState: UnitReport['budgetState'] = 'NORMAL',
): UnitReport {
  const value = {
    type: 'UnitReport',
    requestId: request.requestId,
    agentRunId: request.agentRunId,
    unitRef: request.unitRef,
    executionKind: kind,
    status: 'OK',
    budgetState,
    unitAttemptId: newId('una'),
    output,
    outputRef: {
      artifactId: `art_${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      size: 10,
      mediaType:
        kind === 'MODEL'
          ? MEDIA_TYPES.modelOutput
          : kind === 'FILE_READ'
            ? MEDIA_TYPES.fileText
            : MEDIA_TYPES.contextPack,
    },
  };
  const checked = validate<UnitReport>(UnitReportSchema, value);
  if (!checked.ok) throw new Error('Invalid UnitReport fixture');
  return checked.value;
}

function failure(
  request: SubmitUnitRequest,
  kind: 'MODEL' | 'FILE_READ',
  budgetState: UnitReport['budgetState'] = 'NORMAL',
): Extract<UnitReport, { readonly status: 'FAILED' }> {
  return {
    type: 'UnitReport',
    requestId: request.requestId,
    agentRunId: request.agentRunId,
    unitRef: request.unitRef,
    executionKind: kind,
    unitAttemptId: newId('una'),
    status: 'FAILED',
    reasonCode: 'PROVIDER_AUTH',
    budgetState,
  };
}

function rejected(
  request: SubmitUnitRequest,
  executionKind: 'REPOSITORY_ORIENT' | 'FILE_READ' | 'REPOSITORY_SEARCH',
  reasonCode: 'USER_DECLINED' | 'NOT_FOUND',
  budgetState: UnitReport['budgetState'] = 'NORMAL',
): UnitReport {
  const checked = validate<UnitReport>(UnitReportSchema, {
    type: 'UnitReport',
    requestId: request.requestId,
    agentRunId: request.agentRunId,
    unitRef: request.unitRef,
    executionKind,
    status: 'REJECTED',
    reasonCode,
    budgetState,
    ...(reasonCode === 'USER_DECLINED' ? {} : { unitAttemptId: newId('una') }),
  });
  if (!checked.ok) throw new Error('Invalid UnitReport fixture');
  return checked.value;
}

describe('registered Agent Unit cycle', () => {
  it('assembles context, calls the model, and collects tools before the next round', () => {
    const { run, environment } = setup();
    expect(validate(PinnedDefinitionSetSchema, run.definitions).ok).toBe(true);
    const start = startUnitCycle(run, environment());
    expect(validate(ContextAssembleInputSchema, requestOf(start).input).ok).toBe(true);
    const model = receiveUnitReport(
      start.state,
      ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    const batch = receiveUnitReport(
      model.state,
      ok(requestOf(model), 'MODEL', tools),
      environment(),
    );
    expect(batch.submissions).toHaveLength(2);
    expect(batch.state.run.roundsUsed).toBe(1);
    const partial = receiveUnitReport(
      batch.state,
      ok(requestOf(batch, 1), 'FILE_READ', { ...readOutput, path: 'src/other.ts' }),
      environment(),
    );
    expect(partial.submissions).toEqual([]);
    expect(partial.state.pending.size).toBe(1);
    const next = receiveUnitReport(
      partial.state,
      ok(requestOf(batch), 'FILE_READ', readOutput),
      environment(),
    );
    expect(next.state.phase).toBe('CONTEXT');
    expect(next.state.run.noProgressCount).toBe(0);
    expect(next.state.run.roundsUsed).toBe(1);
    expect(next.state.successfulCalls).toHaveLength(2);
    expect(next.state.reads.map((read) => read.output.path)).toEqual([
      'src/other.ts',
      'src/cache.ts',
    ]);
    expect(next.state.run.steps.map((step) => step.kind)).toEqual([
      'MODEL_TURN',
      'TOOL_RESULT',
      'TOOL_RESULT',
    ]);
    for (const step of next.state.run.steps) expect(validate(StepRecordSchema, step).ok).toBe(true);
    expect(requestOf(next).input).toMatchObject({
      steps: next.state.run.steps,
      status: { roundsUsed: 1, final: false },
    });
    expect(batch.state.pending.size).toBe(2);
  });

  it('starts with orient and goes directly to final-call when authorization is declined', () => {
    const { run, environment } = setup(true);
    const start = startUnitCycle(run, environment());
    expect(requestOf(start).unitRef.id).toBe('repository-orient');
    const request = requestOf(start);
    const report: UnitReport = {
      type: 'UnitReport',
      requestId: request.requestId,
      agentRunId: request.agentRunId,
      unitRef: request.unitRef,
      executionKind: 'REPOSITORY_ORIENT',
      status: 'REJECTED',
      reasonCode: 'USER_DECLINED',
      budgetState: 'NORMAL',
    };
    expect(validate(UnitReportSchema, report).ok).toBe(true);
    const next = receiveUnitReport(start.state, report, environment());
    expect(requestOf(next).input).toMatchObject({
      final: true,
      status: { roundsUsed: 0, wrapUpReason: 'USER_DECLINED' },
    });
    expect(next.state.run.steps).toMatchObject([{ code: 'WRAP_UP_NOTICE', round: 1 }]);
  });

  it('keeps fatal exhausted model failures on the error path with no report submission', () => {
    const { run, environment } = setup();
    const start = startUnitCycle(run, environment());
    const model = receiveUnitReport(
      start.state,
      ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    const failed = receiveUnitReport(
      model.state,
      failure(requestOf(model), 'MODEL', 'EXHAUSTED'),
      environment(),
    );
    expect(failed.submissions).toEqual([]);
    expect(failed.state.decision).toEqual({
      kind: 'FAILED',
      failure: {
        code: 'PROVIDER_AUTH',
        category: 'DEPENDENCY',
        source: 'WORKFLOW',
        unitRequestId: requestOf(model).requestId,
      },
    });
    expect(failed.state.run.roundsUsed).toBe(1);
  });

  it('retains the final model failure exception and never regenerates it', () => {
    const { run, environment } = setup(false, { wrapUpReason: 'ROUND_LIMIT' });
    const start = startUnitCycle(run, environment());
    const model = receiveUnitReport(
      start.state,
      ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    expect(requestOf(model).input).toMatchObject({ final: true });
    const failed = receiveUnitReport(
      model.state,
      failure(requestOf(model), 'MODEL'),
      environment(),
    );
    expect(failed.state.decision).toMatchObject({
      kind: 'DEGRADED_REPORT',
      reason: 'ROUND_LIMIT',
      lastIssue: { kind: 'FAILURE', failure: { code: 'PROVIDER_AUTH' } },
    });
    expect(failed.submissions).toEqual([]);
  });

  it('preserves a legal FINISH even with EXHAUSTED and counts it once', () => {
    const { run, environment } = setup();
    const start = startUnitCycle(run, environment());
    const model = receiveUnitReport(
      start.state,
      ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    const report = ok(requestOf(model), 'MODEL', finish, 'EXHAUSTED');
    const done = receiveUnitReport(model.state, report, environment());
    expect(done.state.decision?.kind).toBe('FINISH');
    expect(done.state.run.roundsUsed).toBe(1);
    expect(receiveUnitReport(done.state, report, environment()).state).toBe(done.state);
  });

  it('collects all tools before applying fatal failure over budget exhaustion', () => {
    const { run, environment } = setup();
    const start = startUnitCycle(run, environment());
    const model = receiveUnitReport(
      start.state,
      ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    const batch = receiveUnitReport(
      model.state,
      ok(requestOf(model), 'MODEL', tools),
      environment(),
    );
    const partial = receiveUnitReport(
      batch.state,
      failure(requestOf(batch), 'FILE_READ', 'EXHAUSTED'),
      environment(),
    );
    expect(partial.state.decision).toBeUndefined();
    const done = receiveUnitReport(
      partial.state,
      ok(requestOf(batch, 1), 'FILE_READ', readOutput),
      environment(),
    );
    expect(done.state.decision?.kind).toBe('FAILED');
    expect(done.submissions).toEqual([]);
  });

  it('budget wrap-up wins over regeneration and no-progress on the same invalid output', () => {
    const { run, environment } = setup(false, { regenerationCount: 2, noProgressCount: 1 });
    const start = startUnitCycle(run, environment());
    const model = receiveUnitReport(
      start.state,
      ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    const next = receiveUnitReport(
      model.state,
      ok(
        requestOf(model),
        'MODEL',
        {
          hasText: false,
          toolCalls: [],
          finishReason: 'STOP',
        },
        'WRAP_UP',
      ),
      environment(),
    );
    expect(next.state.run.wrapUpReason).toBe('BUDGET_WRAP_UP');
    expect(next.state.run.regenerationCount).toBe(3);
    expect(next.state.run.noProgressCount).toBe(2);
    expect(requestOf(next).input).toMatchObject({ final: true });
  });

  it('ignores already consumed request reports and rejects mismatched pending reports', () => {
    const { run, environment } = setup();
    const start = startUnitCycle(run, environment());
    const report = ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput);
    const model = receiveUnitReport(start.state, report, environment());
    expect(receiveUnitReport(model.state, report, environment()).state).toBe(model.state);
    expect(() =>
      receiveUnitReport(start.state, { ...report, agentRunId: newId('agr') }, environment()),
    ).toThrow('does not match');
  });

  it('submits startup Units one at a time and passes the last orient artifact to context', () => {
    const { run, environment } = setup(true);
    const orient = run.definitions.units.find((unit) => unit.executionKind === 'REPOSITORY_ORIENT');
    if (orient === undefined) throw new Error('Missing orient fixture');
    const second = { ...orient, id: 'second-orient' };
    const definition = {
      ...run.definitions,
      agent: {
        ...run.definitions.agent,
        unitRefs: [...run.definitions.agent.unitRefs, { id: second.id, version: second.version }],
        startUnitRefs: [
          ...run.definitions.agent.startUnitRefs,
          { id: second.id, version: second.version },
        ],
      },
      units: [...run.definitions.units, second],
    };
    const startup = startUnitCycle({ ...run, definitions: definition }, environment());
    const orientReport = (
      request: SubmitUnitRequest,
    ): Extract<
      UnitReport,
      { readonly status: 'OK'; readonly executionKind: 'REPOSITORY_ORIENT' }
    > => ({
      type: 'UnitReport',
      requestId: request.requestId,
      agentRunId: request.agentRunId,
      unitRef: request.unitRef,
      executionKind: 'REPOSITORY_ORIENT',
      status: 'OK',
      unitAttemptId: newId('una'),
      budgetState: 'NORMAL',
      output: {
        snapshotId: `snp_${'b'.repeat(64)}`,
        fileCount: 2,
        totalBytes: 10,
        summary: '仓库概况',
        tokenCount: 5,
        truncated: false,
      },
      outputRef: {
        artifactId: `art_${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        size: 10,
        mediaType: MEDIA_TYPES.contextPack,
      },
    });
    const firstReport = orientReport(requestOf(startup));
    expect(validate(UnitReportSchema, firstReport).ok).toBe(true);
    const nextStartup = receiveUnitReport(startup.state, firstReport, environment());
    expect(nextStartup.submissions).toHaveLength(1);
    expect(requestOf(nextStartup).unitRef.id).toBe('second-orient');
    const next = receiveUnitReport(
      nextStartup.state,
      orientReport(requestOf(nextStartup)),
      environment(),
    );
    expect(requestOf(next).input).toMatchObject({ orientPackRef: firstReport.outputRef });
    expect(next.state.snapshotId).toBe(`snp_${'b'.repeat(64)}`);
    expect(next.state.run.roundsUsed).toBe(0);
  });

  it('feeds back duplicate calls and reserves the final round after no progress', () => {
    const { run, environment } = setup();
    const start = startUnitCycle(run, environment());
    const model = receiveUnitReport(
      start.state,
      ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    const batch = receiveUnitReport(
      model.state,
      ok(requestOf(model), 'MODEL', { ...tools, toolCalls: tools.toolCalls.slice(0, 1) }),
      environment(),
    );
    const context = receiveUnitReport(
      batch.state,
      ok(requestOf(batch), 'FILE_READ', readOutput),
      environment(),
    );
    const secondModel = receiveUnitReport(
      context.state,
      ok(requestOf(context), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    const finalContext = receiveUnitReport(
      secondModel.state,
      ok(requestOf(secondModel), 'MODEL', { ...tools, toolCalls: tools.toolCalls.slice(0, 1) }),
      environment(),
    );
    expect(finalContext.state.run.steps).toContainEqual(
      expect.objectContaining({
        code: 'DUPLICATE_CALL',
        toolCallId: 'read-1',
        round: 2,
      }),
    );
    expect(finalContext.state.run.noProgressCount).toBe(1);
    expect(requestOf(finalContext).input).toMatchObject({
      final: true,
      status: { roundsUsed: 2, wrapUpReason: 'ROUND_LIMIT' },
    });
  });

  it('rejects a model reservation without counting a round and retries only as final-call', () => {
    const { run, environment } = setup();
    const definition = {
      ...run.definitions,
      units: run.definitions.units.map((unit) =>
        unit.executionKind === 'MODEL'
          ? { ...unit, failurePolicy: { BUDGET_WRAP_UP: 'FINAL_CALL' as const } }
          : unit,
      ),
    };
    const start = startUnitCycle({ ...run, definitions: definition }, environment());
    const model = receiveUnitReport(
      start.state,
      ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    const rejected: UnitReport = {
      ...failure(requestOf(model), 'MODEL', 'WRAP_UP'),
      status: 'REJECTED',
      reasonCode: 'BUDGET_WRAP_UP',
    };
    const next = receiveUnitReport(model.state, rejected, environment());
    expect(next.state.run.roundsUsed).toBe(0);
    // A wrap-up is explained once, by the notice; no MODEL_CALL_FAILED feedback is added.
    expect(next.state.run.steps).toMatchObject([{ code: 'WRAP_UP_NOTICE', round: 1 }]);
    expect(requestOf(next).input).toMatchObject({ final: true });
  });

  it('explains a model failure returned to the model, and only that kind', () => {
    const { run, environment } = setup();
    const definition = {
      ...run.definitions,
      units: run.definitions.units.map((unit) =>
        unit.executionKind === 'MODEL'
          ? { ...unit, failurePolicy: { PROVIDER_ERROR: 'RETURN_TO_MODEL' as const } }
          : unit,
      ),
    };
    const start = startUnitCycle({ ...run, definitions: definition }, environment());
    const model = receiveUnitReport(
      start.state,
      ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    const next = receiveUnitReport(
      model.state,
      { ...failure(requestOf(model), 'MODEL'), reasonCode: 'PROVIDER_ERROR' },
      environment(),
    );
    expect(next.state.run.steps).toMatchObject([{ code: 'MODEL_CALL_FAILED', round: 1 }]);
    expect(next.state.run.steps[0]).toMatchObject({
      message: expect.stringContaining('PROVIDER_ERROR') as unknown,
    });
    expect(requestOf(next).input).toMatchObject({ final: false });
  });

  it('degrades invalid final output without submitting another model or tool', () => {
    const { run, environment } = setup(false, { wrapUpReason: 'NO_PROGRESS' });
    const start = startUnitCycle(run, environment());
    const model = receiveUnitReport(
      start.state,
      ok(requestOf(start), 'CONTEXT_ASSEMBLE', contextOutput),
      environment(),
    );
    const done = receiveUnitReport(
      model.state,
      ok(requestOf(model), 'MODEL', {
        hasText: false,
        finishReason: 'LENGTH',
        toolCalls: [],
      }),
      environment(),
    );
    expect(done.submissions).toEqual([]);
    expect(done.state.decision).toEqual({
      kind: 'DEGRADED_REPORT',
      reason: 'NO_PROGRESS',
      lastIssue: { kind: 'INVALID_OUTPUT', reason: 'OUTPUT_TRUNCATED' },
    });
  });
});

/** M1Interface 6.6: every tool call of a MODEL_TURN is answered before the next MODEL_TURN. */
function unansweredCalls(steps: readonly StepRecord[]): string[] {
  const missing: string[] = [];
  steps.forEach((step, index) => {
    if (step.kind !== 'MODEL_TURN') return;
    const next = steps.findIndex((later, at) => at > index && later.kind === 'MODEL_TURN');
    const answers = steps.slice(index + 1, next === -1 ? undefined : next);
    for (const call of step.toolCalls)
      if (
        !answers.some((answer) => 'toolCallId' in answer && answer.toolCallId === call.toolCallId)
      )
        missing.push(`round ${step.round}: ${call.toolCallId}`);
  });
  return missing;
}

const generatedCall = fc.constantFrom(
  { toolName: 'read_file', arguments: { path: 'src/a.ts' } },
  { toolName: 'read_file', arguments: { path: 'src/b.ts' } },
  { toolName: 'read_file', arguments: {} },
  { toolName: 'search_repository', arguments: { query: 'cache' } },
  { toolName: 'run_shell', arguments: { command: 'ls' } },
  { toolName: 'finish_analysis', arguments: { summary: 's', conclusions: [], unconfirmed: [] } },
);

const generatedTurn = fc.record({
  // Providers reuse ids such as call_0 in every reply, so ids repeat across turns.
  calls: fc.array(generatedCall, { maxLength: 10 }),
  failed: fc.boolean(),
  budgetState: fc.constantFrom('NORMAL', 'WRAP_UP', 'EXHAUSTED' as const),
});

const generatedToolReport = fc.record({
  status: fc.constantFrom('OK', 'REJECTED', 'FAILED' as const),
  budgetState: fc.constantFrom('NORMAL', 'WRAP_UP', 'EXHAUSTED' as const),
});

describe('tool call answers (M1Interface 6.6)', () => {
  it('answers every tool call before the next model turn on generated runs', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(generatedTurn, { minLength: 1, maxLength: 6 }),
        fc.array(generatedToolReport, { maxLength: 40 }),
        (hasStartup, turns, toolReports) => {
          const { run, environment } = setup(hasStartup);
          let transition = startUnitCycle(run, environment());
          const queue = [...transition.submissions];
          let turnIndex = 0;
          let toolIndex = 0;
          for (let guard = 0; guard < 200 && transition.state.phase !== 'DECIDED'; guard += 1) {
            const request = queue.shift();
            if (request === undefined || request.unitRef.id === 'report-publish') break;
            let report: UnitReport;
            switch (request.unitRef.id) {
              case 'repository-orient':
                report = rejected(request, 'REPOSITORY_ORIENT', 'USER_DECLINED');
                break;
              case 'context-assemble': {
                const input = request.input as { steps: readonly StepRecord[] };
                expect(unansweredCalls(input.steps)).toEqual([]);
                report = ok(request, 'CONTEXT_ASSEMBLE', contextOutput);
                break;
              }
              case 'model-call': {
                const turn = turns[Math.min(turnIndex, turns.length - 1)];
                turnIndex += 1;
                if (turn === undefined) throw new Error('no generated turn');
                if (turn.failed) {
                  report = failure(request, 'MODEL', turn.budgetState);
                  break;
                }
                const toolCalls = turn.calls.map((call, index) => ({
                  ...call,
                  toolCallId: `call_${index}`,
                }));
                report = ok(
                  request,
                  'MODEL',
                  {
                    hasText: false,
                    finishReason: toolCalls.length === 0 ? 'STOP' : 'TOOL_CALLS',
                    toolCalls,
                  },
                  turn.budgetState,
                );
                break;
              }
              default: {
                const generated = toolReports[toolIndex] ?? { status: 'OK', budgetState: 'NORMAL' };
                toolIndex += 1;
                const path = (request.input as { path?: string }).path ?? 'src/a.ts';
                const isRead = request.unitRef.id === 'file-read';
                const executionKind = isRead ? 'FILE_READ' : 'REPOSITORY_SEARCH';
                if (isRead && generated.status === 'OK')
                  report = ok(request, 'FILE_READ', { ...readOutput, path }, generated.budgetState);
                else if (generated.status === 'FAILED')
                  report = {
                    ...failure(request, 'FILE_READ', generated.budgetState),
                    executionKind,
                  };
                else report = rejected(request, executionKind, 'NOT_FOUND', generated.budgetState);
              }
            }
            transition = receiveUnitReport(transition.state, report, environment());
            queue.push(...transition.submissions);
          }
          expect(unansweredCalls(transition.state.run.steps)).toEqual([]);
        },
      ),
      { seed: 20261024, numRuns: 300 },
    );
  });
});
