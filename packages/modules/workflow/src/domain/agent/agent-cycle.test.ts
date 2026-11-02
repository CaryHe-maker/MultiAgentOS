import {
  ReplyArgsSchema,
  RepositoryListInputSchema,
  newId,
  validate,
  SubmitUnitRequestV1Schema,
  type ArtifactRef,
  type BudgetView,
  type ModelToolCall,
  type UnitReportV1,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import {
  closeAgent,
  receiveAgentReport,
  startAgent,
  type AgentConfig,
  type AgentContext,
  type AgentDefinitions,
  type AgentState,
  type AgentTransition,
  type AgentUnit,
} from './agent-cycle.js';

const digest = 'a'.repeat(64);
const ref = (digit: string): ArtifactRef => {
  const sha256 = digit.repeat(64);
  return { artifactId: `art_${sha256}`, sha256, size: 1, mediaType: 'application/x' };
};
const packRef: ArtifactRef = {
  ...ref('1'),
  mediaType: 'application/vnd.multiagentos.context-pack+json',
};
const assembledOutput = {
  ok: { projectionDigest: digest, headDigest: digest, elidedEntries: [] },
  ref: packRef,
};
const modelRef: ArtifactRef = {
  ...ref('2'),
  mediaType: 'application/vnd.multiagentos.model-output+json',
};
const unit = (id: string, failurePolicy: AgentUnit['failurePolicy'] = {}): AgentUnit => ({
  ref: { kind: 'UNIT', id, version: 'v1.0.0', digest },
  failurePolicy,
});
const definitions: AgentDefinitions = {
  label: 'main',
  limits: { maxRounds: 4, maxToolCallsPerRound: 2 },
  orient: unit('repository-orient'),
  contextAssemble: unit('context-assemble'),
  modelCall: unit('model-call', { PROVIDER_ERROR: 'RETURN_TO_MODEL', PROVIDER_AUTH: 'FATAL' }),
  publish: unit('message-publish'),
  tools: [
    {
      modelName: 'list_files',
      unit: unit('repository-list', { NOT_FOUND: 'RETURN_TO_MODEL', LIMIT_EXCEEDED: 'FINAL_CALL' }),
      parameters: RepositoryListInputSchema,
    },
  ],
  endTools: [
    {
      toolName: 'reply',
      parameters: ReplyArgsSchema,
      allowedInFinal: true,
      action: 'PUBLISH_REPLY',
    },
    { toolName: 'handoff', parameters: ReplyArgsSchema, allowedInFinal: false, action: 'HANDOFF' },
  ],
  onDegraded: 'PUBLISH_NOTICE',
};
const config: AgentConfig = {
  repeatedIntent: { warnAt: 3, stopAt: 5, window: 20 },
  consecutiveErrorLimit: 5,
  noProgressRounds: 2,
  regenerationLimit: 3,
};
const context: AgentContext = {
  objectiveRef: ref('9'),
  assembleInput: (status, final) => ({ final, history: [], status }),
};
const start = (overrides: Partial<AgentDefinitions> = {}) =>
  startAgent(
    {
      workflowRunId: newId('wfr'),
      sessionId: newId('ses'),
      turnId: newId('trn'),
      agentRunId: 'agr_01ABCDEFGH',
      definitions: { ...definitions, ...overrides },
    },
    context,
  );

const NORMAL: BudgetView = { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' };
function report(
  state: AgentState,
  requestId: string,
  result:
    | { ok: unknown; ref?: ArtifactRef; reasoningRef?: ArtifactRef; fullRef?: ArtifactRef }
    | { reject: string }
    | { fail: string },
  budget: BudgetView = NORMAL,
): UnitReportV1 {
  const common = {
    type: 'UnitReport',
    requestId,
    agentRunId: state.agentRunId,
    unitRunId: `unr_${'b'.repeat(32)}`,
    unitRef: unit('x').ref,
    executionKind: 'MODEL',
    budget,
  };
  if ('ok' in result)
    return {
      ...common,
      unitAttemptId: newId('una'),
      status: 'OK',
      output: result.ok,
      ...(result.ref === undefined ? {} : { outputRef: result.ref }),
      ...(result.reasoningRef === undefined ? {} : { reasoningRef: result.reasoningRef }),
      ...(result.fullRef === undefined ? {} : { fullRef: result.fullRef }),
    } as UnitReportV1;
  return 'reject' in result
    ? ({ ...common, status: 'REJECTED', reasonCode: result.reject } as UnitReportV1)
    : ({
        ...common,
        unitAttemptId: newId('una'),
        status: 'FAILED',
        reasonCode: result.fail,
      } as UnitReportV1);
}
const receive = (from: AgentTransition, r: UnitReportV1, cfg = config) =>
  receiveAgentReport(from.state, r, context, cfg);
const only = (t: AgentTransition): string => {
  const request = t.submissions[0];
  if (request === undefined) throw new Error('nothing submitted');
  return request.requestId;
};
const unitId = (t: AgentTransition) => t.submissions.map((s) => s.unitRef.id);
const types = (t: AgentTransition) => t.records.map((r) => r.type);

const call = (toolName: string, args: unknown, toolCallId = 'call_1'): ModelToolCall =>
  ({ toolCallId, toolName, arguments: args }) as ModelToolCall;
const modelOutput = (
  calls: readonly ModelToolCall[],
  finishReason = calls.length > 0 ? 'TOOL_CALLS' : 'STOP',
) => ({
  ok: { finishReason, toolCalls: calls, hasText: false, hasReasoning: false },
  ref: modelRef,
});

/** Runs orient and context, leaving the cycle waiting for the model. */
function atModel(overrides: Partial<AgentDefinitions> = {}): AgentTransition {
  const started = start(overrides);
  const assembled = receive(started, report(started.state, only(started), assembledOutput));
  return receive(assembled, report(assembled.state, only(assembled), assembledOutput));
}
const replied = (
  from: AgentTransition,
  calls: readonly ModelToolCall[],
  result?: Parameters<typeof report>[2],
) => receive(from, report(from.state, only(from), result ?? modelOutput(calls)));
const reassemble = (from: AgentTransition, budget: BudgetView = NORMAL) =>
  receive(from, report(from.state, only(from), assembledOutput, budget));

function expectDegraded(from: AgentTransition, reason: string): void {
  expect(from.ending).toEqual({ kind: 'DEGRADED', reason });
}

describe('startup', () => {
  it('orients first, once per run', () => {
    expect(unitId(start())).toEqual(['repository-orient']);
    const again = startAgent(
      {
        workflowRunId: newId('wfr'),
        sessionId: newId('ses'),
        turnId: newId('trn'),
        agentRunId: newId('agr'),
        definitions,
        orientPackRef: packRef,
      },
      context,
    );
    expect(unitId(again)).toEqual(['context-assemble']);
  });

  it('writes the log before it submits, with IDs derived from the path', () => {
    const started = start();
    expect(types(started)).toEqual(['UNIT_SUBMITTED']);
    const request = started.submissions[0];
    expect(validate(SubmitUnitRequestV1Schema, request).ok).toBe(true);
    expect(request?.path).toBe('agr_01ABCDEFGH/round-0/1#1');
  });

  it('goes on without the overview when orient fails', () => {
    const started = start();
    const next = receive(started, report(started.state, only(started), { fail: 'PROVIDER_ERROR' }));
    expect(unitId(next)).toEqual(['context-assemble']);
  });
});

describe('ending', () => {
  it('says only which declared tool ended it, whatever the tool is', () => {
    for (const toolName of ['reply', 'handoff']) {
      const done = replied(atModel(), [call(toolName, { text: 'hi' })]);
      expect(done.ending).toMatchObject({
        kind: 'ENDED',
        tool: { toolName },
        arguments: { text: 'hi' },
        source: { modelOutputRef: modelRef, toolCallId: 'call_1' },
      });
      expect(types(done)).toEqual(['UNIT_COMPLETED', 'MODEL_TURN']);
      expect(done.submissions).toEqual([]);
    }
  });

  it('keeps the text of an ending out of the log', () => {
    const done = replied(atModel(), [call('reply', { text: 'secret reply body' })]);
    expect(JSON.stringify(done.records)).not.toContain('secret reply body');
  });

  it('cannot end with a tool the Agent does not declare', () => {
    const done = replied(atModel({ endTools: [] }), [call('reply', { text: 'hi' })]);
    expect(done.ending).toBeUndefined();
    expect(done.records.find((r) => r.type === 'FEEDBACK')).toMatchObject({ code: 'UNKNOWN_TOOL' });
  });

  it.each([
    ['mixed with a tool', [call('reply', { text: 'x' }), call('list_files', {}, 'call_2')], 2],
    ['with bad arguments', [call('reply', { wrong: 1 })], 1],
  ])('gives feedback when reply comes %s', (_name, calls, feedbackCount) => {
    const next = replied(atModel(), calls);
    expect(types(next).filter((t) => t === 'FEEDBACK')).toHaveLength(feedbackCount);
    expect(unitId(next)).toEqual(['context-assemble']);
  });

  it('asks again when the reply has no action, and says when it was cut off', () => {
    const none = replied(atModel(), []);
    expect(none.records.find((r) => r.type === 'FEEDBACK')).toMatchObject({ code: 'NO_ACTION' });
    const cut = replied(atModel(), [], modelOutput([], 'LENGTH'));
    expect(cut.records.find((r) => r.type === 'FEEDBACK')).toMatchObject({
      code: 'OUTPUT_TRUNCATED',
    });
  });

  it('closes with the last Unit and logs it by its source', () => {
    const done = replied(atModel(), [call('reply', { text: 'hi' })]);
    if (done.ending?.kind !== 'ENDED') throw new Error('not ended');
    const input = { goalRef: ref('9'), report: { summary: 'secret summary' } };
    const closing = closeAgent(done.state, input, done.ending.source);
    expect(unitId(closing)).toEqual(['message-publish']);
    expect(closing.submissions[0]?.input).toEqual(input);
    expect(JSON.stringify(closing.records)).not.toContain('secret summary');
    const low = { ...NORMAL, run: 'WRAP_UP' } as const;
    const closed = receive(
      closing,
      report(closing.state, only(closing), { ok: {}, ref: ref('3') }, low),
    );
    expect(closed.ending).toEqual({ kind: 'CLOSED', outputRef: ref('3'), budget: low });
  });

  it('fails when the closing Unit fails', () => {
    const done = replied(atModel(), [call('reply', { text: 'hi' })]);
    const closing = closeAgent(done.state, { goalRef: ref('9'), report: {} }, undefined);
    const closed = receive(closing, report(closing.state, only(closing), { fail: 'INTERNAL' }));
    expect(closed.ending).toEqual({ kind: 'FAILED', code: 'INTERNAL' });
  });
});

describe('tools', () => {
  it('submits a round together and continues after the last result', () => {
    const tools = replied(atModel(), [
      call('list_files', { path: 'a' }, 'one'),
      call('list_files', { path: 'b' }, 'two'),
    ]);
    expect(tools.submissions).toHaveLength(2);
    expect(tools.records.filter((r) => r.type === 'UNIT_SUBMITTED')).toMatchObject([
      { inputSource: { kind: 'TOOL_CALL', toolCallId: 'one' } },
      { inputSource: { kind: 'TOOL_CALL', toolCallId: 'two' } },
    ]);
    const [first, second] = tools.submissions;
    if (first === undefined || second === undefined) throw new Error('two expected');
    const waiting = receive(tools, report(tools.state, first.requestId, { ok: {}, ref: ref('4') }));
    expect(waiting.submissions).toEqual([]);
    const next = receive(
      waiting,
      report(waiting.state, second.requestId, { ok: {}, ref: ref('5') }),
    );
    expect(unitId(next)).toEqual(['context-assemble']);
  });

  it('records the preview and the full output reference', () => {
    const tools = replied(atModel(), [call('list_files', {})]);
    const next = receive(
      tools,
      report(tools.state, only(tools), { ok: {}, ref: ref('4'), fullRef: ref('5') }),
    );
    expect(next.records[0]).toMatchObject({
      type: 'UNIT_COMPLETED',
      outputRef: ref('4'),
      fullRef: ref('5'),
    });
  });

  it('answers every call that does not run', () => {
    const next = replied(atModel(), [
      call('unknown_tool', {}, 'a'),
      call('list_files', { depth: 99 }, 'b'),
      { toolCallId: 'c', toolName: 'list_files', arguments: null, argumentsError: 'INVALID_JSON' },
    ]);
    expect(next.records.filter((r) => r.type === 'FEEDBACK')).toMatchObject([
      { code: 'UNKNOWN_TOOL', toolCallId: 'a' },
      { code: 'INVALID_ARGUMENTS', toolCallId: 'b' },
      { code: 'INVALID_ARGUMENTS', toolCallId: 'c' },
    ]);
    expect(unitId(next)).toEqual(['context-assemble']);
  });

  it('limits tool calls per round', () => {
    const next = replied(atModel(), [
      call('list_files', { path: 'a' }, 'a'),
      call('list_files', { path: 'b' }, 'b'),
      call('list_files', { path: 'c' }, 'c'),
    ]);
    expect(next.submissions).toHaveLength(2);
    expect(next.records.find((r) => r.type === 'FEEDBACK')).toMatchObject({
      code: 'TOO_MANY_TOOL_CALLS',
      toolCallId: 'c',
    });
  });

  it('refuses a call that already succeeded, and a repeat in the same reply', () => {
    const same = replied(atModel(), [
      call('list_files', { path: 'a' }, 'a'),
      call('list_files', { path: 'a' }, 'b'),
    ]);
    expect(same.submissions).toHaveLength(1);
    expect(same.records.find((r) => r.type === 'FEEDBACK')).toMatchObject({
      code: 'DUPLICATE_CALL',
    });
    const done = receive(same, report(same.state, only(same), { ok: {}, ref: ref('4') }));
    const model = reassemble(done);
    const repeat = replied(model, [call('list_files', { path: 'a' }, 'c')]);
    expect(repeat.submissions.map((s) => s.unitRef.id)).toEqual(['context-assemble']);
    expect(repeat.records.find((r) => r.type === 'FEEDBACK')).toMatchObject({
      code: 'DUPLICATE_CALL',
    });
  });

  it('returns a failed tool to the model and ends on a fatal one', () => {
    const tools = replied(atModel(), [call('list_files', {})]);
    expect(
      unitId(receive(tools, report(tools.state, only(tools), { reject: 'NOT_FOUND' }))),
    ).toEqual(['context-assemble']);
    const fatal = receive(tools, report(tools.state, only(tools), { fail: 'INTERNAL' }));
    expect(fatal.ending).toEqual({ kind: 'FAILED', code: 'INTERNAL' });
  });

  it.each([
    ['TOOL_UNITS', 'TOOL_UNIT_LIMIT'],
    ['WALL_CLOCK', 'WALL_CLOCK_LIMIT'],
  ] as const)('wraps up on %s whatever the failurePolicy says', (quota, reason) => {
    const tools = replied(atModel(), [call('list_files', {})]);
    const refused = {
      ...report(tools.state, only(tools), { reject: 'QUOTA_EXHAUSTED' }),
      quota,
    } as UnitReportV1;
    const next = receive(tools, refused);
    expect(next.ending).toBeUndefined();
    expect(next.state.wrapUpReason).toBe(reason);
    expect(unitId(next)).toEqual(['context-assemble']);
  });

  it('returns a declined authorization to the model whatever the failurePolicy says', () => {
    const tools = replied(atModel(), [call('list_files', {})]);
    const next = receive(tools, report(tools.state, only(tools), { reject: 'USER_DECLINED' }));
    expect(next.ending).toBeUndefined();
    expect(next.state.wrapUpReason).toBeUndefined();
    expect(unitId(next)).toEqual(['context-assemble']);
  });

  it('wraps up when the model comes back to what the user declined', () => {
    const decline = (from: AgentTransition) =>
      receive(from, report(from.state, only(from), { reject: 'USER_DECLINED' }));
    const first = decline(replied(atModel(), [call('list_files', {})]));
    const told = reassemble(first);
    const second = decline(replied(told, [call('list_files', { path: 'src' })]));
    expect(second.state.wrapUpReason).toBe('AUTHORIZATION_DECLINED');
  });

  it('does not count calls of one reply as coming back, nor as errors', () => {
    const tools = replied(atModel(), [
      call('list_files', { path: 'a' }, 'call_1'),
      call('list_files', { path: 'b' }, 'call_2'),
    ]);
    const [one, two] = tools.submissions;
    if (one === undefined || two === undefined) throw new Error('two calls expected');
    const firstReply = receive(
      tools,
      report(tools.state, one.requestId, { reject: 'USER_DECLINED' }),
    );
    const both = receive(
      firstReply,
      report(firstReply.state, two.requestId, { reject: 'USER_DECLINED' }),
    );
    expect(both.state.wrapUpReason).toBeUndefined();
    expect(both.state.consecutiveErrors).toBe(0);
  });

  it('ignores a report it is not waiting for', () => {
    const tools = replied(atModel(), [call('list_files', {})]);
    expect(receive(tools, report(tools.state, newId('req'), { ok: {} })).records).toEqual([]);
  });
});

describe('wrap-up', () => {
  it('turns the next round into the final call when a ledger is low', () => {
    const tools = replied(atModel(), [call('list_files', {})]);
    const low = { ...NORMAL, turn: 'WRAP_UP' } as const;
    const next = receive(tools, report(tools.state, only(tools), { ok: {}, ref: ref('4') }, low));
    expect(next.state).toMatchObject({ final: true, wrapUpReason: 'BUDGET_WRAP_UP' });
    expect(next.submissions[0]?.input).toMatchObject({
      final: true,
      status: { wrapUpReason: 'BUDGET_WRAP_UP' },
    });
  });

  it('ends degraded when a ledger is exhausted', () => {
    const tools = replied(atModel(), [call('list_files', {})]);
    const empty = { ...NORMAL, agentRun: 'EXHAUSTED' } as const;
    expectDegraded(
      receive(tools, report(tools.state, only(tools), { ok: {}, ref: ref('4') }, empty)),
      'BUDGET_EXHAUSTED',
    );
  });

  it('ends degraded when the final call does not reply', () => {
    const tools = replied(atModel(), [call('list_files', {})]);
    const low = { ...NORMAL, turn: 'WRAP_UP' } as const;
    const context_ = receive(
      tools,
      report(tools.state, only(tools), { ok: {}, ref: ref('4') }, low),
    );
    const model = reassemble(context_, low);
    expect(model.submissions[0]?.input).toMatchObject({ final: true, finalMode: 'AUTO' });
    expectDegraded(replied(model, [call('list_files', { path: 'z' })]), 'FINAL_CALL_INVALID');
  });

  it('still lets the final call reply', () => {
    const tools = replied(atModel(), [call('list_files', {})]);
    const low = { ...NORMAL, turn: 'WRAP_UP' } as const;
    const context_ = receive(
      tools,
      report(tools.state, only(tools), { ok: {}, ref: ref('4') }, low),
    );
    const model = reassemble(context_, low);
    expect(replied(model, [call('reply', { text: 'done' })]).ending).toMatchObject({
      kind: 'ENDED',
    });
  });

  it('wraps up at maxRounds', () => {
    let current = atModel({ limits: { maxRounds: 1, maxToolCallsPerRound: 2 } });
    current = replied(current, [call('list_files', {})]);
    current = receive(current, report(current.state, only(current), { ok: {}, ref: ref('4') }));
    expect(current.state.final).toBe(true);
  });

  it('wraps up a context over the limit, and degrades when the final call is too', () => {
    const started = start();
    const assembling = receive(started, report(started.state, only(started), assembledOutput));
    const final = receive(
      assembling,
      report(assembling.state, only(assembling), { reject: 'LIMIT_EXCEEDED' }),
    );
    expect(final.state).toMatchObject({ final: true, wrapUpReason: 'CONTEXT_LIMIT' });
    expectDegraded(
      receive(final, report(final.state, only(final), { reject: 'LIMIT_EXCEEDED' })),
      'CONTEXT_LIMIT',
    );
  });

  it('wraps up after rounds without progress', () => {
    const roomy = { limits: { maxRounds: 20, maxToolCallsPerRound: 2 } };
    let current = atModel(roomy);
    for (const path of ['a', 'b']) {
      current = replied(current, [call('list_files', { path })]);
      current = receive(current, report(current.state, only(current), { reject: 'NOT_FOUND' }));
      if (path === 'a') current = reassemble(current);
    }
    expect(current.state).toMatchObject({ final: true, wrapUpReason: 'NO_PROGRESS' });
  });

  it('wraps up after consecutive errors', () => {
    const roomy = { limits: { maxRounds: 20, maxToolCallsPerRound: 2 } };
    const strict = { ...config, consecutiveErrorLimit: 2, noProgressRounds: 99 };
    let current = atModel(roomy);
    for (const path of ['a', 'b']) {
      current = replied(current, [call('list_files', { path })]);
      current = receive(
        current,
        report(current.state, only(current), { reject: 'NOT_FOUND' }),
        strict,
      );
      if (path === 'a')
        current = receive(current, report(current.state, only(current), assembledOutput), strict);
    }
    expect(current.state).toMatchObject({ final: true, wrapUpReason: 'CONSECUTIVE_ERRORS' });
  });

  it('stops a repeated intent at the limit', () => {
    const roomy = { limits: { maxRounds: 20, maxToolCallsPerRound: 2 } };
    const strict = {
      ...config,
      repeatedIntent: { warnAt: 1, stopAt: 2, window: 20 },
      noProgressRounds: 99,
    };
    let current = atModel(roomy);
    current = receive(
      current,
      report(current.state, only(current), modelOutput([call('list_files', {})])),
      strict,
    );
    current = receive(
      current,
      report(current.state, only(current), { reject: 'NOT_FOUND' }),
      strict,
    );
    current = receive(current, report(current.state, only(current), assembledOutput), strict);
    current = receive(
      current,
      report(current.state, only(current), modelOutput([call('list_files', {})])),
      strict,
    );
    expect(current.records.find((r) => r.type === 'FEEDBACK')).toMatchObject({
      code: 'REPEATED_INTENT',
    });
    expect(current.state).toMatchObject({ final: true, wrapUpReason: 'REPEATED_INTENT' });
  });

  it('stops regenerating after the limit', () => {
    const roomy = { limits: { maxRounds: 20, maxToolCallsPerRound: 2 } };
    let current = atModel(roomy);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      current = replied(current, []);
      if (attempt < 2) current = reassemble(current);
    }
    expect(current.state.wrapUpReason).toBe('REGENERATION_LIMIT');
  });
});

describe('model failures', () => {
  it('records the failed attempt and returns to the model', () => {
    const failed = replied(atModel(), [], { fail: 'PROVIDER_ERROR' });
    expect(types(failed)).toContain('MODEL_ATTEMPT_FAILED');
    expect(unitId(failed)).toEqual(['context-assemble']);
  });

  it('ends on a fatal failure', () => {
    expect(replied(atModel(), [], { fail: 'PROVIDER_AUTH' }).ending).toEqual({
      kind: 'FAILED',
      code: 'PROVIDER_AUTH',
    });
  });
});

describe('the final call', () => {
  it('refuses an end tool that is not allowed in it', () => {
    const tools = replied(atModel(), [call('list_files', {})]);
    const low = { ...NORMAL, turn: 'WRAP_UP' } as const;
    const final = reassemble(
      receive(tools, report(tools.state, only(tools), { ok: {}, ref: ref('4') }, low)),
      low,
    );
    expectDegraded(replied(final, [call('handoff', { text: 'brief' })]), 'FINAL_CALL_INVALID');
  });
});

describe('every tool call gets an answer', () => {
  const answered = (t: AgentTransition) =>
    t.records.flatMap((r) =>
      r.type === 'FEEDBACK' && r.toolCallId !== undefined ? [r.toolCallId] : [],
    );
  const atFinal = () => {
    const tools = replied(atModel(), [call('list_files', {})]);
    const low = { ...NORMAL, turn: 'WRAP_UP' } as const;
    return reassemble(
      receive(tools, report(tools.state, only(tools), { ok: {}, ref: ref('4') }, low)),
      low,
    );
  };

  it('when the final call asks for a tool', () => {
    const done = replied(atFinal(), [call('list_files', { path: 'x' }, 'late')]);
    expect(done.ending).toMatchObject({ kind: 'DEGRADED' });
    expect(answered(done)).toEqual(['late']);
  });

  it('when the final call misuses an end tool', () => {
    const done = replied(atFinal(), [call('handoff', { text: 'x' }, 'late')]);
    expect(answered(done)).toEqual(['late']);
  });

  it('when one tool of a batch fails fatally', () => {
    const tools = replied(atModel(), [
      call('list_files', { path: 'a' }, 'a'),
      call('list_files', { path: 'b' }, 'b'),
    ]);
    const [first, second] = tools.submissions;
    if (first === undefined || second === undefined) throw new Error('two expected');
    const waiting = receive(tools, report(tools.state, first.requestId, { fail: 'INTERNAL' }));
    expect(waiting.ending).toBeUndefined();
    const done = receive(
      waiting,
      report(waiting.state, second.requestId, { ok: {}, ref: ref('4') }),
    );
    expect(done.ending).toEqual({ kind: 'FAILED', code: 'INTERNAL' });
    expect(types(done)).toEqual(['UNIT_COMPLETED']);
  });
});

describe('what the log keeps of an assembly', () => {
  it('records the digests, and not the history it can rebuild', () => {
    const started = start();
    const assembling = receive(started, report(started.state, only(started), assembledOutput));
    const secret = 'history that must not repeat';
    const withHistory: AgentContext = {
      ...context,
      assembleInput: (status, final) => ({
        final,
        history: [{ seq: 1, category: 'NORMAL', kind: 'NOTE', text: secret }],
        status,
      }),
    };
    const next = receiveAgentReport(
      assembling.state,
      report(assembling.state, only(assembling), assembledOutput),
      withHistory,
      config,
    );
    expect(types(next)).toEqual(['UNIT_COMPLETED', 'CONTEXT_ASSEMBLED', 'UNIT_SUBMITTED']);
    const tools = replied(next, [call('list_files', {})]);
    const after = receiveAgentReport(
      tools.state,
      report(tools.state, only(tools), { ok: {}, ref: ref('4') }),
      withHistory,
      config,
    );
    expect(after.submissions[0]?.input).toMatchObject({ history: [{ text: secret }] });
    expect(JSON.stringify(after.records)).not.toContain(secret);
  });
});
