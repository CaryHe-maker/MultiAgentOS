/**
 * Every rule the Interface documents state as a condition ("required when", "only for", "must equal")
 * is enforced by the Schema. Each test gives a valid value and then breaks exactly one rule.
 */
import type { TSchema } from 'typebox';
import { describe, expect, it } from 'vitest';
import { PinnedDefinitionSetSchema } from './catalog/catalog-schemas.js';
import { ContextPackSchema } from './context/context-pack.js';
import {
  ContextAssembleInputSchema,
  ContextAssembleOutputSchema,
  ContextHistoryEntrySchema,
  StatusFactsSchema,
} from './context/history-entry.js';
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
import { pathDerivedId } from './platform-common/new-id.js';
import { validate } from './platform-common/validation.js';

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
const summaryRef = ref(MEDIA_TYPES.runSummary);
const outputRef = ref(MEDIA_TYPES.modelOutput);
const unitRef = { kind: 'UNIT', id: 'file-read', version: 'v0.1.0', digest: sha };
const agentRef = { kind: 'AGENT', id: 'worker', version: 'v0.1.0', digest: sha };
const readOutput = {
  path: 'a.ts',
  startLine: 1,
  endLine: 2,
  totalLines: 2,
  contentSha256: sha,
  fileSha256: sha,
};
const budget = { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' };
const status = { round: 1, maxRounds: 3, final: false, budget };

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
    const close = {
      requestId: 'req_123456',
      sessionId: 'ses_123456',
      workflowRunId: 'wfr_123456',
      outcome: 'COMPLETED',
    };
    expectRules(
      CloseRunRequestSchema,
      { ...close, resultRef: textRef },
      { 'resultRef that is no reference': { ...close, resultRef: 'report' } },
    );
  });

  it('fixes the definition kind of every pinned reference', () => {
    const run = {
      requestId: 'req_123456',
      sessionId: 'ses_123456',
      workflowRunId: 'wfr_123456',
      agentRunId: 'agr_123456',
    };
    const register = {
      ...run,
      nodeId: 'nod_123456',
      agentRef,
      effort: 'none',
      workspaceViewId: 'main',
      requestedCapabilities: [],
      writeRoots: [],
      display: { label: 'main' },
    };
    expectRules(RegisterAgentRunRequestSchema, register, {
      'agentRef that names a unit': { ...register, agentRef: unitRef },
    });
    const unitRun = 'agr_123456/round-1/1';
    const path = `${unitRun}#1`;
    const submit = {
      ...run,
      requestId: pathDerivedId('req', path),
      unitRunId: pathDerivedId('unr', unitRun),
      path,
      unitRef,
      input: { path: 'src/a.ts' },
      display: { toolName: 'read_file', argsSummary: 'src/a.ts' },
    };
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
    const answer = { hasText: false, hasReasoning: false };
    expectRules(
      ModelCallOutputSchema,
      { ...answer, finishReason: 'TOOL_CALLS', toolCalls: [call] },
      {
        'TOOL_CALLS without a call': { ...answer, finishReason: 'TOOL_CALLS', toolCalls: [] },
        'STOP with a call': { ...answer, finishReason: 'STOP', toolCalls: [call] },
        'an answer that does not say whether it has thinking': {
          finishReason: 'TOOL_CALLS',
          toolCalls: [call],
          hasText: false,
        },
      },
    );
    expect(ok(ModelCallOutputSchema, { ...answer, finishReason: 'LENGTH', toolCalls: [] })).toBe(
      true,
    );
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
  const pack = { contextPackId: 'ctx_123456', tokenCount: 1, tokenBudget: 10 };
  const assemble = (items: object[]) => ({
    contextPackId: pack.contextPackId,
    tokenCount: pack.tokenCount,
    tokenBudget: pack.tokenBudget,
    createdAt: at,
    operation: 'ASSEMBLE',
    prefixSha256: sha,
    projectionDigest: sha,
    headDigest: sha,
    elidedEntries: [],
    items,
  });
  const history = { segment: 'HISTORY', seq: 1, category: 'NORMAL' };
  const at0 = (extra: object) => [{ ...item, ...extra }];

  it('fixes what each operation may contain', () => {
    const hit = { ...item, segment: 'SEARCH_HIT', role: 'user', provenance, score: 1 };
    const search = { ...pack, operation: 'SEARCH', snapshotId: `snp_${sha}`, items: [hit] };
    expect(ok(ContextPackSchema, search), 'a SEARCH pack').toBe(false);
    const orient = { ...pack, operation: 'ORIENT', snapshotId: `snp_${sha}`, items: [] };
    expect(ok(ContextPackSchema, orient), 'an ORIENT pack').toBe(false);
    const instructions = at0({ segment: 'INSTRUCTIONS', role: 'system' });
    expectRules(ContextPackSchema, assemble(instructions), {
      'itemId that is not contextPackId:index': assemble(
        instructions.map((entry) => ({ ...entry, itemId: 'ctx_123456:1' })),
      ),
      'ASSEMBLE without prefixSha256': without(assemble([]), 'prefixSha256'),
      'ASSEMBLE that says it was truncated': { ...assemble([]), truncated: false },
      'SEARCH_HIT item in an ASSEMBLE pack': assemble([hit]),
    });
  });

  it('fixes the role and the extra fields of each segment', () => {
    const call = { toolCallId: 'call_1', toolName: 'read_file', arguments: {} };
    const valid = [
      { segment: 'TOOLS', role: 'system', toolSpecs: [] },
      { segment: 'STATUS', role: 'user' },
      { ...history, role: 'assistant', toolCalls: [call], reasoningContent: 'hmm' },
      { ...history, role: 'assistant' },
      { ...history, role: 'tool', toolCallId: 'call_1' },
      { ...history, role: 'user' },
    ];
    for (const extra of valid)
      expect(ok(ContextPackSchema, assemble(at0(extra))), JSON.stringify(extra)).toBe(true);
    const broken = [
      { segment: 'TOOLS', role: 'system' },
      { segment: 'TOOLS', role: 'user', toolSpecs: [] },
      { segment: 'STATUS', role: 'user', toolSpecs: [] },
      { segment: 'OBJECTIVE', role: 'user' },
      { segment: 'HANDOFF', role: 'user' },
      { segment: 'ORIENT', role: 'user', provenance },
      { segment: 'INSTRUCTIONS', role: 'user' },
      { ...history, role: 'tool' },
      { ...history, role: 'user', toolCallId: 'call_1' },
      { ...history, role: 'assistant', toolCalls: [] },
      { ...history, role: 'system' },
      { segment: 'HISTORY', role: 'user' },
      { segment: 'STATUS', role: 'user', score: 1 },
    ];
    for (const extra of broken)
      expect(ok(ContextPackSchema, assemble(at0(extra))), JSON.stringify(extra)).toBe(false);
  });

  it('keeps final, status and the token budget consistent', () => {
    const input = { final: false, history: [], status };
    expectRules(ContextAssembleInputSchema, input, {
      'final that differs from status.final': { ...input, final: true },
      'an orient pack': { ...input, orientPackRef: ref(MEDIA_TYPES.contextPack) },
    });
    expectRules(StatusFactsSchema, status, {
      'a round before the first': { ...status, round: 0 },
      'a wrap-up reason that is unknown': { ...status, wrapUpReason: 'USER_DECLINED' },
    });
    const output = {
      contextPackId: 'ctx_123456',
      tokenCount: 10,
      tokenBudget: 10,
      prefixSha256: sha,
      projectionDigest: sha,
      headDigest: sha,
      elidedEntries: [],
    };
    expectRules(ContextAssembleOutputSchema, output, {
      'tokenCount above tokenBudget': { ...output, tokenCount: 11 },
    });
    const resolved = {
      final: false,
      tokenBudget: 10,
      instructions: '',
      toolSpecs: [],
      history: [],
      status,
    };
    const turn = { seq: 1, category: 'NORMAL', kind: 'MODEL_TURN', toolCalls: [] };
    expectRules(
      AssembleExecutorInputSchema,
      { ...resolved, history: [turn] },
      {
        'an entry without seq': { ...resolved, history: [without(turn, 'seq')] },
        'an orient pack': { ...resolved, orientPack: assemble([]) },
      },
    );
  });
});

describe('workflow values', () => {
  it('fixes the fields of each history entry', () => {
    const entry = { seq: 1, category: 'NORMAL' };
    const result = { ...entry, kind: 'TOOL_RESULT', toolCallId: 'c', toolName: 't' };
    expectRules(
      ContextHistoryEntrySchema,
      { ...result, status: 'OK', outputRef: textRef },
      {
        'an unknown status': { ...result, status: 'LOST' },
        'a body in place of its reference': { ...result, status: 'OK', text: 'body' },
        'an entry without seq': { ...without(result, 'seq'), status: 'OK' },
      },
    );
    const turn = { ...entry, kind: 'MODEL_TURN', modelId: 'm', outputRef, replayable: true };
    expectRules(ContextHistoryEntrySchema, turn, {
      'a turn whose output is no model output': { ...turn, outputRef: textRef },
      'a turn that does not say whether it replays': without(turn, 'replayable'),
    });
    expect(ok(ContextHistoryEntrySchema, { ...entry, kind: 'HUMAN', contentRef: textRef })).toBe(
      true,
    );
    expect(ok(ContextHistoryEntrySchema, { ...entry, kind: 'HUMAN', text: 'body' })).toBe(false);
    expect(ok(ContextHistoryEntrySchema, { ...entry, kind: 'FEEDBACK', text: 'm' })).toBe(true);
    expect(
      ok(ContextHistoryEntrySchema, { ...entry, kind: 'FEEDBACK', text: 'm', toolCallId: 'c' }),
    ).toBe(true);
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
    const close = {
      requestId: 'req_123456',
      sessionId: 'ses_123456',
      workflowRunId: 'wfr_123456',
      outcome: 'FAILED',
    };
    const byWorkflow = { code: 'PIN_FAILED', category: 'DEPENDENCY', source: 'WORKFLOW' };
    expectRules(
      CloseRunRequestSchema,
      { ...close, failure: byWorkflow },
      {
        'failure whose source is KERNEL': { ...close, failure },
        'FAILED without failure': close,
        'resultRef next to failure': { ...close, failure: byWorkflow, resultRef: textRef },
      },
    );
  });

  it('gives every closeReason exactly its own fields', () => {
    const end = { type: 'RunFinished', unknownEffects: [], runSummaryRef: summaryRef };
    const failure = { code: 'KERNEL_INTERNAL', category: 'INTERNAL', source: 'KERNEL' };
    const violation = { code: 'PATH_ESCAPE', category: 'INTEGRITY', source: 'KERNEL' };
    expectRules(
      RunFinishedSchema,
      { ...end, closeReason: 'COMPLETED', resultRef: textRef },
      {
        'COMPLETED with failure': { ...end, closeReason: 'COMPLETED', failure },
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
        'a timeout as a run end of its own': { ...end, closeReason: 'RUN_TIMEOUT' },
        'runSummaryRef that is not a RunSummary': {
          ...end,
          closeReason: 'CANCELLED',
          runSummaryRef: textRef,
        },
      },
    );
    expect(ok(RunFinishedSchema, { ...end, closeReason: 'FAILED', failure })).toBe(true);
    expect(ok(RunFinishedSchema, { ...end, closeReason: 'VIOLATION', failure: violation })).toBe(
      true,
    );
    for (const closeReason of ['COMPLETED', 'BUDGET', 'TIMEOUT', 'ENDED_BY_USER', 'SHUTDOWN'])
      expect(ok(RunFinishedSchema, { ...end, closeReason }), closeReason).toBe(true);
    const run = { sessionId: 'ses_123456', workflowRunId: 'wfr_123456' };
    expect(ok(AdmissionProjectionSchema, { ...run, runState: 'RUNNING' })).toBe(true);
    expect(ok(AdmissionProjectionSchema, { ...run, runState: 'CLOSED' })).toBe(false);
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
      sessionId: 'ses_123456',
      closeReason: 'CANCELLED',
      startedAt: at,
      closedAt: at,
      durationMs: 0,
      inputs: 1,
      agentRuns: [
        {
          agentRunId: 'agr_123456',
          agentRef,
          registeredAt: at,
          endedAt: at,
          rounds: 1,
          finalCallUsed: false,
        },
      ],
      units: { submitted: 3, ok: 1, rejected: 1, failed: 0, notDelivered: 1 },
      model: { requests: 1 },
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
      'FAILED without failure': { ...summary, closeReason: 'FAILED' },
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
          executionKind: 'MESSAGE_PUBLISH',
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
    unitRunId: 'unr_123456',
    unitRef,
    budget,
  };
  const done = { ...report, executionKind: 'FILE_READ', unitAttemptId: 'una_123456', status: 'OK' };

  it('requires an output and an attempt of everything that completed', () => {
    expectRules(
      UnitReportSchema,
      { ...done, output: readOutput, outputRef: textRef },
      {
        'OK without output': { ...done, outputRef: textRef },
        'OK without unitAttemptId': {
          ...without(done, 'unitAttemptId'),
          output: readOutput,
          outputRef: textRef,
        },
        'output that is no Unit output': { ...done, output: { command: 'rm' } },
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
        'FAILED without unitAttemptId': {
          ...without(attempt, 'unitAttemptId'),
          status: 'FAILED',
          reasonCode: 'UNIT_TIMEOUT',
        },
        'QUOTA_EXHAUSTED without quota': {
          ...without(attempt, 'unitAttemptId'),
          status: 'REJECTED',
          reasonCode: 'QUOTA_EXHAUSTED',
        },
      },
    );
    const declined = { ...report, status: 'REJECTED', reasonCode: 'USER_DECLINED' };
    expect(ok(UnitReportSchema, { ...declined, executionKind: 'REPOSITORY_SEARCH' })).toBe(true);
    expect(ok(UnitReportSchema, { ...attempt, status: 'FAILED', reasonCode: 'UNIT_TIMEOUT' })).toBe(
      true,
    );
    const event = {
      eventId: 'evt_123456',
      sessionId: 'ses_123456',
      workflowRunId: 'wfr_123456',
      seq: 1,
      occurredAt: at,
    };
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
    sessionId: 'ses_123456',
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
  const toolLimits = {
    ...limits,
    preview: { maxBytes: 1, maxLines: 1 },
    maxFullOutputBytes: 1,
  };
  const read = {
    ...ids,
    executionKind: 'FILE_READ',
    input: { path: 'a.ts' },
    scope: repository,
    limits: toolLimits,
  };

  it('fixes input, scope and limits by executionKind', () => {
    expectRules(ExecutionRequestSchema, read, {
      'scope of another kind': { ...read, scope: { kind: 'NONE' } },
      'a kind that is never dispatched': { ...read, executionKind: 'MESSAGE_PUBLISH' },
      'maxOutputTokens outside MODEL': { ...read, limits: { ...limits, maxOutputTokens: 1 } },
      'a tool without preview limits': { ...read, limits },
      'an exclusion rule the matcher cannot apply': {
        ...read,
        scope: { ...repository, exclusions: ['**/*.{pem,key}'] },
      },
    });
    const pack = {
      contextPackId: 'ctx_123456',
      operation: 'ASSEMBLE',
      tokenCount: 0,
      tokenBudget: 1,
      prefixSha256: sha,
      projectionDigest: sha,
      headDigest: sha,
      elidedEntries: [],
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
      output: { finishReason: 'STOP', toolCalls: [], hasText: true, hasReasoning: false },
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
