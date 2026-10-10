/**
 * Every rule that M1Interface states as a condition ("required when", "only for", "must equal")
 * is enforced by the Schema. Each test gives a valid value and then breaks exactly one rule.
 */
import type { TSchema } from 'typebox';
import { describe, expect, it } from 'vitest';
import { PinnedDefinitionSetSchema } from './catalog/catalog-schemas.js';
import { ContextAssembleInputSchema, ContextAssembleOutputSchema } from './context/assemble.js';
import { ContextPackSchema } from './context/context-pack.js';
import { RepositorySearchOutputSchema } from './context/repository.js';
import { FileReadInputSchema, FileReadOutputSchema } from './executor/file-read.js';
import {
  ModelCallInputSchema,
  ModelCallOutputSchema,
  TokenUsageSchema,
} from './executor/model-call.js';
import { ModelToolCallSchema } from './executor/model-tool-call.js';
import {
  AdmissionProjectionSchema,
  GatewayForwardSchema,
} from './kernel-control/gateway-forward.js';
import { RunFinishedSchema } from './kernel-control/interaction-events.js';
import { SyscallRejectedSchema } from './kernel-control/responses.js';
import { RunFailureSchema, UnknownEffectSchema } from './kernel-control/run-outcome.js';
import { RunSummarySchema } from './kernel-control/run-summary.js';
import { ExecutionFactSchema } from './kernel-execution/execution-fact.js';
import {
  AssembleExecutorInputSchema,
  ExecutionRequestSchema,
} from './kernel-execution/execution-request.js';
import { UnitReportSchema, WorkflowInboxEventSchema } from './kernel-unit/workflow-events.js';
import {
  CloseRunRequestSchema,
  RegisterAgentRunRequestSchema,
  SubmitUnitRequestSchema,
} from './kernel-unit/workflow-syscalls.js';
import { ArtifactRefSchema } from './platform-common/common-schemas.js';
import { MEDIA_TYPES } from './platform-common/media-types.js';
import { validate } from './platform-common/validation.js';
import { AnalysisReportSchema } from './workflow/report.js';
import { StatusFactsSchema, StepRecordSchema } from './workflow/step-record.js';

const sha = 'a'.repeat(64);
const at = '2026-10-09T00:00:00.000Z';
const ok = (schema: TSchema, value: unknown) => validate(schema, value).ok;
/** `valid` passes; each entry of `broken` is `valid` with one rule broken and must fail. */
function expectRules(schema: TSchema, valid: object, broken: Readonly<Record<string, object>>) {
  expect(validate(schema, valid)).toMatchObject({ ok: true });
  for (const [rule, value] of Object.entries(broken)) expect(ok(schema, value), rule).toBe(false);
}
const without = <T extends object>(value: T, key: keyof T) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const ref = (mediaType: string) => ({ artifactId: `art_${sha}`, mediaType, sha256: sha, size: 1 });
const packRef = ref(MEDIA_TYPES.contextPack);
const textRef = ref(MEDIA_TYPES.fileText);
const reportRef = ref(MEDIA_TYPES.analysisReport);
const summaryRef = ref(MEDIA_TYPES.runSummary);
const unitRef = { kind: 'UNIT', id: 'file-read', version: 'v0.1.0', digest: sha };
const agentRef = { kind: 'AGENT', id: 'planner', version: 'v0.1.0', digest: sha };
const readOutput = {
  path: 'a.ts',
  startLine: 1,
  endLine: 2,
  totalLines: 2,
  contentSha256: sha,
  fileSha256: sha,
};
const status = { roundsUsed: 0, maxRounds: 3, final: false, budgetState: 'NORMAL' };

describe('references and identifiers', () => {
  it('ties artifactId to sha256', () => {
    expectRules(ArtifactRefSchema, textRef, {
      'artifactId of another digest': { ...textRef, artifactId: `art_${'b'.repeat(64)}` },
      'artifactId that is not a digest': { ...textRef, artifactId: 'art_123456' },
    });
  });

  it('fixes the media type of every artifact a field points at', () => {
    expectRules(
      ModelCallInputSchema,
      { contextPackRef: packRef, final: false },
      { 'contextPackRef that is not a ContextPack': { contextPackRef: textRef, final: false } },
    );
    const close = { requestId: 'req_123456', workflowRunId: 'wfr_123456', outcome: 'COMPLETED' };
    expectRules(
      CloseRunRequestSchema,
      { ...close, reportRef },
      { 'reportRef that is not a report': { ...close, reportRef: textRef } },
    );
  });

  it('fixes the definition kind of every pinned reference', () => {
    const register = {
      requestId: 'req_123456',
      workflowRunId: 'wfr_123456',
      agentRunId: 'agr_123456',
      agentRef,
    };
    expectRules(RegisterAgentRunRequestSchema, register, {
      'agentRef that names a unit': { ...register, agentRef: unitRef },
    });
    const submit = { ...without(register, 'agentRef'), unitRef, input: { path: 'src/a.ts' } };
    expectRules(SubmitUnitRequestSchema, submit, {
      'unitRef that names an agent': { ...submit, unitRef: agentRef },
      'input that is no Unit input': { ...submit, input: { command: 'rm' } },
    });
    expect(
      ok(GatewayForwardSchema, { caller: 'workflow', requestType: 'submitUnit', request: submit }),
    ).toBe(true);
    expect(
      ok(GatewayForwardSchema, {
        caller: 'user-interaction',
        requestType: 'submitUnit',
        request: submit,
      }),
    ).toBe(false);
    expect(ok(PinnedDefinitionSetSchema, { handoffTargetRef: unitRef })).toBe(false);
  });
});

describe('executor values', () => {
  it('allows exactly two shapes of a tool call', () => {
    const call = { toolCallId: 'call_1', toolName: 'read_file' };
    expectRules(
      ModelToolCallSchema,
      { ...call, arguments: { path: 'a.ts' } },
      {
        'null arguments without argumentsError': { ...call, arguments: null },
        'argumentsError next to parsed arguments': {
          ...call,
          arguments: { path: 'a.ts' },
          argumentsError: 'INVALID_JSON',
        },
        'missing arguments': call,
      },
    );
    expect(
      ok(ModelToolCallSchema, { ...call, arguments: null, argumentsError: 'INVALID_JSON' }),
    ).toBe(true);
  });

  it('ties finishReason to whether tools were called', () => {
    const call = { toolCallId: 'call_1', toolName: 'read_file', arguments: {} };
    expectRules(
      ModelCallOutputSchema,
      { finishReason: 'TOOL_CALLS', toolCalls: [call], hasText: false },
      {
        'TOOL_CALLS without a call': { finishReason: 'TOOL_CALLS', toolCalls: [], hasText: false },
        'STOP with a call': { finishReason: 'STOP', toolCalls: [call], hasText: false },
      },
    );
    expect(
      ok(ModelCallOutputSchema, { finishReason: 'LENGTH', toolCalls: [], hasText: true }),
    ).toBe(true);
  });

  it('keeps line ranges and token counts consistent', () => {
    expectRules(
      FileReadInputSchema,
      { path: 'a.ts', startLine: 2, endLine: 5 },
      {
        'startLine after endLine': { path: 'a.ts', startLine: 5, endLine: 2 },
      },
    );
    expectRules(FileReadOutputSchema, readOutput, {
      'range beyond the file': { ...readOutput, endLine: 3 },
      'empty range in a file with lines': { ...readOutput, endLine: 0 },
    });
    expect(ok(FileReadOutputSchema, { ...readOutput, endLine: 0, totalLines: 0 })).toBe(true);
    expectRules(
      TokenUsageSchema,
      { inputTokens: 10, outputTokens: 1, inputCacheHitTokens: 10 },
      {
        'more cache hits than input tokens': {
          inputTokens: 10,
          outputTokens: 1,
          inputCacheHitTokens: 11,
        },
      },
    );
    const hit = { path: 'a.ts', startLine: 1, endLine: 1, score: 1, matchKind: 'TEXT' };
    expectRules(
      RepositorySearchOutputSchema,
      { snapshotId: `snp_${sha}`, hits: [hit], truncated: false },
      {
        'hit with startLine after endLine': {
          snapshotId: `snp_${sha}`,
          hits: [{ ...hit, startLine: 2 }],
          truncated: false,
        },
        'snapshotId that is not a digest': { snapshotId: 'snp_123456', hits: [], truncated: false },
      },
    );
  });
});

describe('ContextPack', () => {
  const item = {
    itemId: 'ctx_123456:0',
    content: 'x',
    contentSha256: sha,
    tokenCount: 1,
    reason: 'r',
  };
  const provenance = {
    path: 'a.ts',
    startLine: 1,
    endLine: 1,
    contentSha256: sha,
    retrieval: 'TREE',
  };
  const pack = {
    contextPackId: 'ctx_123456',
    tokenCount: 1,
    tokenBudget: 10,
    truncated: false,
    droppedCount: 0,
    createdAt: at,
  };
  const orientItem = { ...item, segment: 'ORIENT', role: 'user', provenance };
  const orient = { ...pack, operation: 'ORIENT', snapshotId: `snp_${sha}`, items: [orientItem] };
  const assemble = (items: object[]) => ({
    ...pack,
    operation: 'ASSEMBLE',
    prefixSha256: sha,
    items,
  });
  const at0 = (extra: object) => [{ ...item, ...extra }];

  it('fixes what each operation may contain', () => {
    expectRules(ContextPackSchema, orient, {
      'ORIENT without snapshotId': without(orient, 'snapshotId'),
      'ORIENT item without provenance': { ...orient, items: [without(orientItem, 'provenance')] },
      'itemId that is not contextPackId:index': {
        ...orient,
        items: [{ ...orientItem, itemId: 'ctx_123456:1' }],
      },
      'prefixSha256 on an ORIENT pack': { ...orient, prefixSha256: sha },
    });
    const hit = { ...item, segment: 'SEARCH_HIT', role: 'user', provenance, score: 1 };
    const search = { ...pack, operation: 'SEARCH', snapshotId: `snp_${sha}`, items: [hit] };
    expectRules(ContextPackSchema, search, {
      'SEARCH_HIT without score': { ...search, items: [without(hit, 'score')] },
      'ORIENT item in a SEARCH pack': { ...search, items: [orientItem] },
    });
    expectRules(ContextPackSchema, assemble(at0({ segment: 'INSTRUCTIONS', role: 'system' })), {
      'ASSEMBLE without prefixSha256': without(assemble([]), 'prefixSha256'),
      'SEARCH_HIT item in an ASSEMBLE pack': assemble([hit]),
    });
  });

  it('fixes the role and the extra fields of each segment', () => {
    const call = { toolCallId: 'call_1', toolName: 'read_file', arguments: {} };
    const valid = [
      { segment: 'TOOLS', role: 'system', toolSpecs: [] },
      { segment: 'OBJECTIVE', role: 'user' },
      { segment: 'HISTORY', role: 'assistant', toolCalls: [call] },
      { segment: 'HISTORY', role: 'assistant' },
      { segment: 'HISTORY', role: 'tool', toolCallId: 'call_1' },
      { segment: 'HISTORY', role: 'user' },
    ];
    for (const extra of valid)
      expect(ok(ContextPackSchema, assemble(at0(extra))), JSON.stringify(extra)).toBe(true);
    const broken = [
      { segment: 'TOOLS', role: 'system' },
      { segment: 'TOOLS', role: 'user', toolSpecs: [] },
      { segment: 'OBJECTIVE', role: 'user', toolSpecs: [] },
      { segment: 'INSTRUCTIONS', role: 'user' },
      { segment: 'HISTORY', role: 'tool' },
      { segment: 'HISTORY', role: 'user', toolCallId: 'call_1' },
      { segment: 'HISTORY', role: 'assistant', toolCalls: [] },
      { segment: 'HISTORY', role: 'system' },
      { segment: 'STATUS', role: 'user', score: 1 },
    ];
    for (const extra of broken)
      expect(ok(ContextPackSchema, assemble(at0(extra))), JSON.stringify(extra)).toBe(false);
  });

  it('keeps final, status and the token budget consistent', () => {
    const input = { objective: 'o', final: false, steps: [], status };
    expectRules(ContextAssembleInputSchema, input, {
      'final that differs from status.final': { ...input, final: true },
      'orientPackRef that is not a ContextPack': { ...input, orientPackRef: textRef },
    });
    expectRules(StatusFactsSchema, status, {
      'more rounds used than allowed': { ...status, roundsUsed: 4 },
    });
    const output = {
      contextPackId: 'ctx_123456',
      tokenCount: 10,
      tokenBudget: 10,
      truncated: false,
      droppedCount: 0,
      prefixSha256: sha,
      elidedRequestIds: [],
    };
    expectRules(ContextAssembleOutputSchema, output, {
      'tokenCount above tokenBudget': { ...output, tokenCount: 11 },
    });
    const resolved = {
      objective: 'o',
      final: false,
      tokenBudget: 10,
      instructions: '',
      toolSpecs: [],
      history: [],
      status,
    };
    const turn = { kind: 'MODEL_TURN', round: 1, requestId: 'req_123456', toolCalls: [] };
    expectRules(
      AssembleExecutorInputSchema,
      { ...resolved, history: [{ step: turn }] },
      {
        'outputText on a step that is no OK tool result': {
          ...resolved,
          history: [{ step: turn, outputText: 'x' }],
        },
        'orientPack that is an ASSEMBLE pack': { ...resolved, orientPack: assemble([]) },
      },
    );
  });
});

describe('workflow values', () => {
  it('fixes the fields of each StepRecord', () => {
    const result = {
      kind: 'TOOL_RESULT',
      round: 1,
      requestId: 'req_123456',
      toolCallId: 'c',
      toolName: 't',
    };
    expectRules(
      StepRecordSchema,
      { ...result, status: 'OK', output: readOutput, outputRef: textRef },
      {
        'OK without outputRef': { ...result, status: 'OK', output: readOutput },
        'file-read output with a ContextPack artifact': {
          ...result,
          status: 'OK',
          output: readOutput,
          outputRef: packRef,
        },
        'REJECTED with a FAILED reason': {
          ...result,
          status: 'REJECTED',
          reasonCode: 'UNIT_TIMEOUT',
        },
        'FAILED with a REJECTED reason': { ...result, status: 'FAILED', reasonCode: 'NOT_FOUND' },
        'reason code next to OK': {
          ...result,
          status: 'OK',
          output: readOutput,
          outputRef: textRef,
          reasonCode: 'NOT_FOUND',
        },
      },
    );
    const feedback = { kind: 'FEEDBACK', round: 1, message: 'm' };
    expectRules(
      StepRecordSchema,
      { ...feedback, code: 'UNKNOWN_TOOL', toolCallId: 'c' },
      {
        'call feedback without toolCallId': { ...feedback, code: 'UNKNOWN_TOOL' },
        'round feedback with toolCallId': { ...feedback, code: 'WRAP_UP_NOTICE', toolCallId: 'c' },
      },
    );
    expect(ok(StepRecordSchema, { ...feedback, code: 'INVALID_ACTION' })).toBe(true);
    expect(ok(StepRecordSchema, { ...feedback, code: 'INVALID_ACTION', toolCallId: 'c' })).toBe(
      true,
    );
  });

  it('separates the normal report from the degraded one', () => {
    const source = {
      path: 'a.ts',
      startLine: 1,
      endLine: 2,
      readRequestId: 'req_123456',
      readContentSha256: sha,
    };
    const report = {
      workflowRunId: 'wfr_123456',
      goal: 'g',
      summary: 's',
      conclusions: [{ statement: 'c', sources: [source] }],
      unconfirmed: [],
      readSources: [source],
      degraded: false,
      agentRounds: [],
      createdAt: at,
    };
    const degraded = {
      ...report,
      conclusions: [],
      degraded: true,
      wrapUp: { reason: 'BUDGET_EXHAUSTED' },
    };
    expectRules(AnalysisReportSchema, report, {
      'conclusion without a source': { ...report, conclusions: [{ statement: 'c', sources: [] }] },
      'source with startLine after endLine': {
        ...report,
        readSources: [{ ...source, startLine: 3 }],
      },
      'degraded without wrapUp': { ...report, conclusions: [], degraded: true },
      'degraded with conclusions': { ...degraded, conclusions: report.conclusions },
    });
    expect(ok(AnalysisReportSchema, degraded)).toBe(true);
  });
});

describe('Gateway responses and run outcomes', () => {
  it('lets each issuer use only its own reason codes', () => {
    const rejected = { requestId: 'req_123456', outcome: 'REJECTED' };
    expectRules(
      SyscallRejectedSchema,
      { ...rejected, issuer: 'CORE', reasonCode: 'FORBIDDEN' },
      {
        'a Core reason from Gateway': { ...rejected, issuer: 'GATEWAY', reasonCode: 'FORBIDDEN' },
        'a Gateway reason from Core': {
          ...rejected,
          issuer: 'CORE',
          reasonCode: 'CALLER_FORBIDDEN',
        },
        'a UnitReport reason': { ...rejected, issuer: 'CORE', reasonCode: 'NOT_FOUND' },
        'RUN_BLOCKED without closeReason': {
          ...rejected,
          issuer: 'CORE',
          reasonCode: 'RUN_BLOCKED',
        },
        'closeReason on another reason': {
          ...rejected,
          issuer: 'CORE',
          reasonCode: 'FORBIDDEN',
          closeReason: 'CANCELLED',
        },
      },
    );
    for (const issuer of ['GATEWAY', 'CORE'])
      expect(
        ok(SyscallRejectedSchema, {
          ...rejected,
          issuer,
          reasonCode: 'RUN_BLOCKED',
          closeReason: 'CANCELLED',
        }),
      ).toBe(true);
  });

  it('ties category and source of a failure to its code and place', () => {
    const failure = { code: 'KERNEL_INTERNAL', category: 'INTERNAL', source: 'KERNEL' };
    expectRules(RunFailureSchema, failure, {
      'category of another code': { ...failure, category: 'POLICY' },
    });
    const close = { requestId: 'req_123456', workflowRunId: 'wfr_123456', outcome: 'FAILED' };
    const byWorkflow = { code: 'PIN_FAILED', category: 'DEPENDENCY', source: 'WORKFLOW' };
    expectRules(
      CloseRunRequestSchema,
      { ...close, failure: byWorkflow },
      {
        'failure whose source is KERNEL': { ...close, failure },
        'FAILED without failure': close,
        'reportRef next to failure': { ...close, failure: byWorkflow, reportRef },
      },
    );
  });

  it('gives every closeReason exactly its own fields', () => {
    const end = { type: 'RunFinished', unknownEffects: [], runSummaryRef: summaryRef };
    const failure = { code: 'KERNEL_INTERNAL', category: 'INTERNAL', source: 'KERNEL' };
    const violation = { code: 'PATH_ESCAPE', category: 'INTEGRITY', source: 'KERNEL' };
    expectRules(
      RunFinishedSchema,
      { ...end, closeReason: 'COMPLETED', reportRef },
      {
        'COMPLETED without reportRef': { ...end, closeReason: 'COMPLETED' },
        'COMPLETED with failure': { ...end, closeReason: 'COMPLETED', reportRef, failure },
        'FAILED without failure': { ...end, closeReason: 'FAILED' },
        'VIOLATION with a failure that is no violation': {
          ...end,
          closeReason: 'VIOLATION',
          failure,
        },
        'VIOLATION judged by Workflow': {
          ...end,
          closeReason: 'VIOLATION',
          failure: { ...violation, source: 'WORKFLOW' },
        },
        'CANCELLED with reportRef': { ...end, closeReason: 'CANCELLED', reportRef },
        'runSummaryRef that is not a RunSummary': {
          ...end,
          closeReason: 'CANCELLED',
          runSummaryRef: reportRef,
        },
      },
    );
    expect(ok(RunFinishedSchema, { ...end, closeReason: 'FAILED', failure })).toBe(true);
    expect(ok(RunFinishedSchema, { ...end, closeReason: 'VIOLATION', failure: violation })).toBe(
      true,
    );
    expect(ok(RunFinishedSchema, { ...end, closeReason: 'RUN_TIMEOUT' })).toBe(true);
    expect(
      ok(AdmissionProjectionSchema, { workflowRunId: 'wfr_123456', runState: 'RUNNING' }),
    ).toBe(true);
    expect(ok(AdmissionProjectionSchema, { workflowRunId: 'wfr_123456', runState: 'CLOSED' })).toBe(
      false,
    );
  });

  it('delivers a summary write failure without inventing a RunSummary reference', () => {
    const base = {
      type: 'RunFinished',
      unknownEffects: [],
      finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
    };
    const failure = { code: 'PATH_ESCAPE', category: 'INTEGRITY', source: 'KERNEL' };
    expect(ok(RunFinishedSchema, { ...base, closeReason: 'CANCELLED' })).toBe(true);
    expect(ok(RunFinishedSchema, { ...base, closeReason: 'VIOLATION', failure })).toBe(true);
    expect(
      ok(RunFinishedSchema, { ...base, closeReason: 'CANCELLED', runSummaryRef: summaryRef }),
    ).toBe(false);
    expect(
      ok(RunFinishedSchema, { type: 'RunFinished', unknownEffects: [], closeReason: 'CANCELLED' }),
    ).toBe(false);
  });

  it('keeps the RunSummary consistent', () => {
    const summary = {
      workflowRunId: 'wfr_123456',
      closeReason: 'CANCELLED',
      startedAt: at,
      closedAt: at,
      durationMs: 0,
      agentRuns: [{ agentRunId: 'agr_123456', agentRef, registeredAt: at, endedAt: at, rounds: 1 }],
      units: { submitted: 3, ok: 1, rejected: 1, failed: 0, notDelivered: 1 },
      model: { requests: 1, finalCallUsed: false },
      tokens: {
        limit: 1,
        used: 0,
        unknown: 0,
        inputTokens: 0,
        outputTokens: 0,
        finalBudgetState: 'NORMAL',
      },
      unknownEffects: [],
    };
    expectRules(RunSummarySchema, summary, {
      'units that do not add up': { ...summary, units: { ...summary.units, submitted: 4 } },
      'COMPLETED without reportRef': { ...summary, closeReason: 'COMPLETED' },
      'agentRef that names a unit': {
        ...summary,
        agentRuns: [{ ...summary.agentRuns[0], agentRef: unitRef }],
      },
    });
    const effect = { unitAttemptId: 'una_123456', executionId: 'exe_123456' };
    expectRules(
      UnknownEffectSchema,
      { ...effect, executionKind: 'MODEL', effect: 'MODEL_REQUEST_UNCONFIRMED' },
      {
        'unconfirmed model request of a file read': {
          ...effect,
          executionKind: 'FILE_READ',
          effect: 'MODEL_REQUEST_UNCONFIRMED',
        },
        'unconfirmed stop of the built-in Unit': {
          ...effect,
          executionKind: 'REPORT_PUBLISH',
          effect: 'EXECUTION_STOP_UNCONFIRMED',
        },
      },
    );
  });
});

describe('UnitReport', () => {
  const report = {
    type: 'UnitReport',
    requestId: 'req_123456',
    agentRunId: 'agr_123456',
    unitRef,
    budgetState: 'NORMAL',
  };
  const done = { ...report, executionKind: 'FILE_READ', unitAttemptId: 'una_123456', status: 'OK' };

  it('ties output and artifact to the execution kind', () => {
    expectRules(
      UnitReportSchema,
      { ...done, output: readOutput, outputRef: textRef },
      {
        'OK without output': { ...done, outputRef: textRef },
        'OK without outputRef': { ...done, output: readOutput },
        'OK without unitAttemptId': {
          ...without(done, 'unitAttemptId'),
          output: readOutput,
          outputRef: textRef,
        },
        'output of another kind': {
          ...done,
          output: { conclusionCount: 0, unconfirmedCount: 0, degraded: false },
          outputRef: textRef,
        },
        'artifact of another kind': { ...done, output: readOutput, outputRef: packRef },
        'a kind M1 does not run': {
          ...done,
          executionKind: 'COMMAND',
          output: readOutput,
          outputRef: textRef,
        },
        'unitRef that names an agent': {
          ...done,
          unitRef: agentRef,
          output: readOutput,
          outputRef: textRef,
        },
      },
    );
  });

  it('ties the reason code to the status and unitAttemptId to the attempt', () => {
    const attempt = { ...report, executionKind: 'FILE_READ', unitAttemptId: 'una_123456' };
    expectRules(
      UnitReportSchema,
      { ...attempt, status: 'REJECTED', reasonCode: 'NOT_FOUND' },
      {
        'REJECTED without a reason': { ...attempt, status: 'REJECTED' },
        'REJECTED with a FAILED reason': {
          ...attempt,
          status: 'REJECTED',
          reasonCode: 'PROVIDER_ERROR',
        },
        'FAILED with a REJECTED reason': { ...attempt, status: 'FAILED', reasonCode: 'NOT_FOUND' },
        'a reason that never reaches Workflow': {
          ...attempt,
          status: 'FAILED',
          reasonCode: 'PATH_ESCAPE',
        },
        'rejection after dispatch without unitAttemptId': {
          ...without(attempt, 'unitAttemptId'),
          status: 'REJECTED',
          reasonCode: 'NOT_FOUND',
        },
        'USER_DECLINED with an attempt': {
          ...attempt,
          status: 'REJECTED',
          reasonCode: 'USER_DECLINED',
        },
      },
    );
    const declined = { ...report, status: 'REJECTED', reasonCode: 'USER_DECLINED' };
    expect(ok(UnitReportSchema, { ...declined, executionKind: 'REPOSITORY_ORIENT' })).toBe(true);
    expect(ok(UnitReportSchema, { ...declined, executionKind: 'MODEL' })).toBe(false);
    expect(ok(UnitReportSchema, { ...attempt, status: 'FAILED', reasonCode: 'UNIT_TIMEOUT' })).toBe(
      true,
    );
    const event = { eventId: 'evt_123456', workflowRunId: 'wfr_123456', seq: 1, occurredAt: at };
    expect(
      ok(WorkflowInboxEventSchema, {
        ...event,
        event: { ...declined, executionKind: 'FILE_READ' },
      }),
    ).toBe(true);
    expect(ok(WorkflowInboxEventSchema, { ...event, seq: 0, event: declined })).toBe(false);
  });
});

describe('ExecutionRequest and ExecutionFact', () => {
  const ids = {
    workflowRunId: 'wfr_123456',
    unitAttemptId: 'una_123456',
    executionId: 'exe_123456',
    runEpoch: 1,
  };
  const repository = { kind: 'REPOSITORY', repositoryRoot: '/repo', exclusions: [] };
  const model = {
    kind: 'MODEL',
    provider: 'p',
    apiModelId: 'm',
    apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
    baseUrl: 'https://example.invalid',
    thinking: 'DISABLED',
  };
  const limits = { deadline: at, maxOutputBytes: 1 };
  const read = {
    ...ids,
    executionKind: 'FILE_READ',
    input: { path: 'a.ts' },
    scope: repository,
    limits,
  };

  it('fixes input, scope and limits by executionKind', () => {
    expectRules(ExecutionRequestSchema, read, {
      'scope of another kind': { ...read, scope: { kind: 'NONE' } },
      'a kind that is never dispatched': { ...read, executionKind: 'REPORT_PUBLISH' },
      'maxOutputTokens outside MODEL': { ...read, limits: { ...limits, maxOutputTokens: 1 } },
    });
    const orient = {
      ...read,
      executionKind: 'REPOSITORY_ORIENT',
      input: { objective: 'o', tokenBudget: 1 },
    };
    expect(ok(ExecutionRequestSchema, orient)).toBe(false);
    expect(ok(ExecutionRequestSchema, { ...orient, limits: { ...limits, maxFiles: 1 } })).toBe(
      true,
    );
    const pack = {
      contextPackId: 'ctx_123456',
      operation: 'ASSEMBLE',
      tokenCount: 0,
      tokenBudget: 1,
      truncated: false,
      droppedCount: 0,
      prefixSha256: sha,
      items: [],
      createdAt: at,
    };
    const call = {
      ...ids,
      executionKind: 'MODEL',
      input: { contextPack: pack, final: false },
      scope: model,
      limits: { ...limits, maxOutputTokens: 1 },
    };
    expectRules(ExecutionRequestSchema, call, {
      'MODEL without maxOutputTokens': { ...call, limits },
      'thinkingEffort while thinking is DISABLED': {
        ...call,
        scope: { ...model, thinkingEffort: 'high' },
      },
      'ENABLED thinking without an effort': { ...call, scope: { ...model, thinking: 'ENABLED' } },
      'baseUrl that is not https': {
        ...call,
        scope: { ...model, baseUrl: 'http://example.invalid' },
      },
    });
  });

  it('fixes the result, the reason codes and the model fields of a fact', () => {
    const fact = { ...ids, executionKind: 'FILE_READ', startedAt: at, endedAt: at };
    const result = { output: readOutput, artifact: { mediaType: MEDIA_TYPES.fileText, text: 'x' } };
    expectRules(
      ExecutionFactSchema,
      { ...fact, outcome: 'COMPLETED', result },
      {
        'COMPLETED without a result': { ...fact, outcome: 'COMPLETED' },
        'a fact without executionKind': {
          ...without(fact, 'executionKind'),
          outcome: 'COMPLETED',
          result,
        },
        'result without an artifact': {
          ...fact,
          outcome: 'COMPLETED',
          result: { output: readOutput },
        },
        'artifact of another media type': {
          ...fact,
          outcome: 'COMPLETED',
          result: {
            output: readOutput,
            artifact: { mediaType: MEDIA_TYPES.contextPack, text: 'x' },
          },
        },
        'result of another kind': {
          ...fact,
          executionKind: 'REPOSITORY_SEARCH',
          outcome: 'COMPLETED',
          result,
        },
        'requestState outside MODEL': {
          ...fact,
          outcome: 'COMPLETED',
          result,
          requestState: 'SENT',
        },
        'FAILED without retryable': { ...fact, outcome: 'FAILED', reasonCode: 'INTERNAL' },
        'REJECTED with a FAILED reason': { ...fact, outcome: 'REJECTED', reasonCode: 'INTERNAL' },
        'VIOLATION with a reason that is no violation': {
          ...fact,
          outcome: 'VIOLATION',
          reasonCode: 'NOT_FOUND',
        },
        'TERMINATED with another reason': {
          ...fact,
          outcome: 'TERMINATED',
          reasonCode: 'INTERNAL',
        },
        'REJECTED that never started': {
          ...without(fact, 'startedAt'),
          outcome: 'REJECTED',
          reasonCode: 'NOT_FOUND',
        },
      },
    );
    expect(
      ok(ExecutionFactSchema, {
        ...without(fact, 'startedAt'),
        outcome: 'TERMINATED',
        reasonCode: 'EXECUTION_CANCELLED',
      }),
    ).toBe(true);
    expect(
      ok(ExecutionFactSchema, { ...fact, outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' }),
    ).toBe(true);
    expect(
      ok(ExecutionFactSchema, { ...fact, outcome: 'STOP_UNCONFIRMED', reasonCode: 'UNIT_TIMEOUT' }),
    ).toBe(true);

    const modelFact = { ...fact, executionKind: 'MODEL' };
    const failed = {
      ...modelFact,
      outcome: 'FAILED',
      reasonCode: 'PROVIDER_ERROR',
      retryable: false,
    };
    expectRules(
      ExecutionFactSchema,
      { ...failed, requestState: 'UNKNOWN' },
      {
        'MODEL fact without requestState': failed,
      },
    );
    const answer = {
      output: { finishReason: 'STOP', toolCalls: [], hasText: true },
      artifact: { mediaType: MEDIA_TYPES.modelOutput, text: '{}' },
    };
    const completed = { ...modelFact, outcome: 'COMPLETED', result: answer };
    expectRules(
      ExecutionFactSchema,
      { ...completed, requestState: 'SENT' },
      {
        'completed MODEL that was not SENT': { ...completed, requestState: 'UNKNOWN' },
      },
    );
  });
});
