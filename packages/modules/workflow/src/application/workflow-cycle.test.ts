import {
  AnalysisReportSchema,
  CloseRunRequestSchema,
  ContextAssembleInputSchema,
  SubmitUnitRequestSchema,
  validate,
} from '@multiagentos/contracts';
import type {
  ModelCallOutput,
  PersistenceNamespace,
  RepositoryPort,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { cycleDefinitions } from '../test-support/cycle-definitions.js';
import { definitions } from '../test-support/definitions.js';
import { runWorkflowCase, finishOutput } from '../test-support/cycle-harness.js';
import { MemoryPersistence } from '../test-support/memory-persistence.js';

const tools: ModelCallOutput = {
  hasText: false,
  finishReason: 'TOOL_CALLS',
  toolCalls: [
    { toolCallId: 'read-a', toolName: 'read_file', arguments: { path: 'a.ts' } },
    { toolCallId: 'read-b', toolName: 'read_file', arguments: { path: 'b.ts' } },
  ],
};
const handoff: ModelCallOutput = {
  hasText: false,
  finishReason: 'TOOL_CALLS',
  toolCalls: [
    {
      toolCallId: 'handoff',
      toolName: 'handoff_to_code_viewer',
      arguments: {
        task: '分析缓存',
        focusAreas: ['缓存'],
        openQuestions: [],
      },
    },
  ],
};

describe('Workflow public cycle and report delivery', () => {
  it.each([true, false])('completes with reports arriving before Ack = %s', async (beforeAck) => {
    const result = await runWorkflowCase({ beforeAck });
    expect(result.faults).toEqual([]);
    expect(result.gateway.calls.map((call) => call.kind)).toEqual([
      'REGISTER',
      'SUBMIT',
      'SUBMIT',
      'SUBMIT',
      'END',
      'CLOSE',
    ]);
    for (const call of result.gateway.calls) {
      if (call.kind === 'SUBMIT')
        expect(validate(SubmitUnitRequestSchema, call.request).ok).toBe(true);
      if (call.kind === 'CLOSE')
        expect(validate(CloseRunRequestSchema, call.request).ok).toBe(true);
    }
    expect(result.persistence.writes).toHaveLength(2);
    expect(result.persistence.writes[1]).toMatchObject({
      businessState: 'COMPLETED',
      reportRef: { mediaType: 'application/vnd.multiagentos.analysis-report+json' },
      agentRuns: [{ roundsUsed: 1, ending: 'FINISH' }],
    });
  });

  it('collects tools before the next context and privately records empty reads', async () => {
    const result = await runWorkflowCase({
      modelOutputs: [tools, finishOutput],
      reverseTools: true,
      readIsEmpty: true,
    });
    expect(result.faults).toEqual([]);
    const submissions = result.gateway.calls.filter((call) => call.kind === 'SUBMIT');
    const nextContext = submissions.filter(
      (call) => call.request.unitRef.id === 'context-assemble',
    )[1];
    expect(validate(ContextAssembleInputSchema, nextContext?.request.input).ok).toBe(true);
    expect(nextContext?.request.input).toMatchObject({
      steps: [
        { kind: 'MODEL_TURN' },
        { kind: 'TOOL_RESULT', toolCallId: 'read-b' },
        { kind: 'TOOL_RESULT', toolCallId: 'read-a' },
      ],
    });
    const publish = submissions.find((call) => 'report' in call.request.input);
    if (publish === undefined || !('report' in publish.request.input))
      throw new Error('Missing publication');
    expect(validate(AnalysisReportSchema, publish.request.input.report).ok).toBe(true);
    expect(publish.request.input.report.summary).toContain('2 个空文件');
    expect(publish.request.input.report.readSources).toEqual([]);
    expect(result.persistence.writes[1]).toMatchObject({
      reads: [
        { output: { path: 'b.ts', totalLines: 0, endLine: 0 } },
        { output: { path: 'a.ts', totalLines: 0, endLine: 0 } },
      ],
    });
  });

  it('closes fatal exhausted model failures without publishing a report', async () => {
    const result = await runWorkflowCase({
      modelFailure: 'PROVIDER_AUTH',
      modelBudget: 'EXHAUSTED',
    });
    expect(result.faults).toEqual([]);
    expect(
      result.gateway.calls
        .filter((call) => call.kind === 'SUBMIT')
        .map((call) => call.request.unitRef.id),
    ).toEqual(['context-assemble', 'model-call']);
    expect(result.gateway.calls.at(-1)?.request).toMatchObject({
      outcome: 'FAILED',
      failure: { code: 'PROVIDER_AUTH' },
    });
    expect(result.gateway.calls.at(-1)?.request).not.toHaveProperty('reportRef');
    expect(result.persistence.writes).toHaveLength(1);
  });

  it('keeps final-call failure as the existing degraded COMPLETED path', async () => {
    const base = cycleDefinitions();
    const entry = {
      ...base,
      agent: { ...base.agent, limits: { ...base.agent.limits, maxRounds: 1 } },
    };
    const result = await runWorkflowCase({ entry, modelFailure: 'PROVIDER_AUTH' });
    expect(result.faults).toEqual([]);
    const publish = result.gateway.calls.find(
      (call) => call.kind === 'SUBMIT' && 'report' in call.request.input,
    );
    if (publish?.kind !== 'SUBMIT') throw new Error('Missing publication');
    expect(publish?.request).toMatchObject({
      input: { report: { degraded: true, wrapUp: { reason: 'ROUND_LIMIT' } } },
    });
    expect(result.gateway.calls.at(-1)?.request).toMatchObject({ outcome: 'COMPLETED' });
  });

  it.each(['NORMAL', 'WRAP_UP'] as const)(
    'hands off with budget %s using the pinned target',
    async (modelBudget) => {
      const result = await runWorkflowCase({
        entry: definitions(),
        target: cycleDefinitions(true),
        modelOutputs: [handoff, finishOutput],
        modelBudget,
      });
      expect(result.faults).toEqual([]);
      expect(result.catalog.requests).toHaveLength(2);
      const register = result.gateway.calls.filter((call) => call.kind === 'REGISTER');
      expect(register).toHaveLength(2);
      expect(register[0]?.request.agentRunId).not.toBe(register[1]?.request.agentRunId);
      const context = result.gateway.calls.filter(
        (call) => call.kind === 'SUBMIT' && call.request.unitRef.id === 'context-assemble',
      )[1];
      if (context?.kind !== 'SUBMIT') throw new Error('Missing target context');
      expect(context?.request.input).toMatchObject({
        handoff: { task: '分析缓存' },
        final: modelBudget === 'WRAP_UP',
        status: { roundsUsed: 0 },
      });
      expect(result.persistence.writes[1]).toMatchObject({
        agentRuns: [
          { ending: 'HANDOFF', roundsUsed: 1 },
          { ending: 'FINISH', roundsUsed: 1 },
        ],
      });
    },
  );

  it('fails rejected handoff end requests without registering the target', async () => {
    const result = await runWorkflowCase({
      entry: definitions(),
      target: cycleDefinitions(true),
      modelOutputs: [handoff],
      rejectEnd: true,
    });
    expect(result.gateway.calls.filter((call) => call.kind === 'REGISTER')).toHaveLength(1);
    expect(result.gateway.calls.at(-1)?.request).toMatchObject({
      outcome: 'FAILED',
      failure: { code: 'FORBIDDEN' },
    });
  });

  it('publication failure closes FAILED without another publication', async () => {
    const result = await runWorkflowCase({ failPublication: true });
    expect(result.faults).toEqual([]);
    expect(result.gateway.calls.map((call) => call.kind)).not.toContain('END');
    expect(result.gateway.calls.at(-1)?.request).toMatchObject({
      outcome: 'FAILED',
      failure: { code: 'INTERNAL' },
    });
  });

  it('fails rejected target registration before its startup Unit is submitted', async () => {
    const result = await runWorkflowCase({
      entry: definitions(),
      target: cycleDefinitions(true),
      modelOutputs: [handoff],
      rejectTargetRegistration: true,
    });
    expect(result.faults).toEqual([]);
    expect(result.gateway.calls.filter((call) => call.kind === 'REGISTER')).toHaveLength(2);
    expect(
      result.gateway.calls
        .filter((call) => call.kind === 'SUBMIT')
        .map((call) => call.request.unitRef.id),
    ).toEqual(['context-assemble', 'model-call']);
    expect(result.gateway.calls.at(-1)?.request).toMatchObject({
      outcome: 'FAILED',
      failure: { code: 'FORBIDDEN' },
    });
  });

  it('closes a record write failure and records the terminal state', async () => {
    const persistence = new MemoryPersistence();
    const original = persistence.repository.bind(persistence);
    let shouldFail = true;
    persistence.repository = <T extends { readonly id: string }>(
      namespace: PersistenceNamespace,
      workflowRunId: string,
    ): RepositoryPort<T> => {
      const repository = original<T>(namespace, workflowRunId);
      return {
        ...repository,
        put: (record) => {
          if (shouldFail) {
            shouldFail = false;
            return Promise.reject(new Error('Injected write error'));
          }
          return repository.put(record);
        },
      };
    };
    const result = await runWorkflowCase({ persistence });
    expect(result.faults).toEqual([]);
    expect(result.gateway.calls.at(-1)?.request).toMatchObject({
      outcome: 'FAILED',
      failure: { code: 'WORKFLOW_INTERNAL' },
    });
    expect(
      result.gateway.calls
        .filter((call) => call.kind === 'SUBMIT')
        .map((call) => call.request.unitRef.id),
    ).not.toContain('report-publish');
    expect(result.persistence.writes).toHaveLength(1);
  });

  it('stops requests when RunClosed arrives with a Unit still pending', async () => {
    const result = await runWorkflowCase({ closeEarly: true });
    expect(result.faults).toEqual([]);
    expect(result.gateway.calls.map((call) => call.kind)).toEqual(['REGISTER', 'SUBMIT']);
    expect(result.persistence.writes[0]).toMatchObject({
      businessState: 'CANCELLED',
      agentRuns: [{ ending: 'CLOSED' }],
      closeReason: 'CANCELLED',
    });
  });
});
