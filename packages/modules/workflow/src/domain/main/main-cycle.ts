import { canonicalJson, pathDerivedId, sha256Hex, validate } from '@multiagentos/contracts';
import type {
  ArtifactRef,
  BudgetView,
  ContextAssembleInputV1,
  FailureHandling,
  ModelToolCall,
  PinnedDefinitionRef,
  ReasonCodeV1,
  SubmitUnitRequestV1,
  ThinkingEffort,
  UnitInputV1,
  UnitReportV1,
  WRAP_UP_REASONS_V1,
} from '@multiagentos/contracts';
import type { NewLogRecord } from '../../session/session-log-store.js';

/**
 * One AgentRun of main as a pure state machine (Module/Workflow 7): every step returns the log
 * records to append first and the Units to submit afterwards. The Round order is M1's:
 * context-assemble, model-call, then all tool Units of that reply.
 */
export type WrapUpReason = (typeof WRAP_UP_REASONS_V1)[number];
type Schema = Parameters<typeof validate>[0];

export interface MainUnit {
  readonly ref: PinnedDefinitionRef;
  readonly failurePolicy: Readonly<Partial<Record<string, FailureHandling>>>;
}
export interface MainTool {
  readonly modelName: string;
  readonly unit: MainUnit;
  readonly parameters: Schema;
}
export interface MainDefinitions {
  readonly label: string;
  readonly limits: { readonly maxRounds: number; readonly maxToolCallsPerRound: number };
  readonly orient?: MainUnit;
  readonly contextAssemble: MainUnit;
  readonly modelCall: MainUnit;
  readonly messagePublish: MainUnit;
  readonly tools: readonly MainTool[];
  readonly replyToolName: string;
  readonly replyParameters: Schema;
}
export interface MainConfig {
  readonly repeatedIntent: {
    readonly warnAt: number;
    readonly stopAt: number;
    readonly window: number;
  };
  readonly consecutiveErrorLimit: number;
  readonly noProgressRounds: number;
  readonly regenerationLimit: number;
}

type Pending =
  | { readonly role: 'ORIENT' | 'CONTEXT' | 'MODEL' | 'PUBLISH'; readonly unit: MainUnit }
  | {
      readonly role: 'TOOL';
      readonly unit: MainUnit;
      readonly call: ModelToolCall;
      readonly intent: string;
    };

export interface MainState {
  readonly workflowRunId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentRunId: string;
  readonly effort: ThinkingEffort;
  readonly definitions: MainDefinitions;
  readonly round: number;
  readonly final: boolean;
  readonly finalUsed: boolean;
  readonly wrapUpReason?: WrapUpReason;
  readonly budget: BudgetView;
  readonly orientPackRef?: ArtifactRef;
  readonly pending: ReadonlyMap<string, Pending>;
  readonly unitCounter: number;
  readonly succeeded: readonly string[];
  readonly intents: readonly string[];
  readonly consecutiveErrors: number;
  readonly noProgress: number;
  readonly regenerations: number;
  readonly roundHadOk: boolean;
  readonly modelOutputRef?: ArtifactRef;
}

export type MainEnding =
  | { readonly kind: 'REPLIED'; readonly messageRef?: ArtifactRef; readonly budget: BudgetView }
  | {
      readonly kind: 'DEGRADED';
      readonly reason: WrapUpReason | 'BUDGET_EXHAUSTED' | 'FINAL_CALL_INVALID';
    }
  | { readonly kind: 'FAILED'; readonly code: ReasonCodeV1 };

export interface MainTransition {
  readonly state: MainState;
  readonly records: readonly NewLogRecord[];
  readonly submissions: readonly SubmitUnitRequestV1[];
  readonly ending?: MainEnding;
}

/** The facts context-assemble needs that the log, not this machine, supplies. */
export interface MainContext {
  readonly assembleInput: (
    status: ContextAssembleInputV1['status'],
    final: boolean,
  ) => ContextAssembleInputV1;
  readonly objective: string;
}

const NORMAL_BUDGET: BudgetView = { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' };
const FEEDBACK = {
  NO_ACTION: 'Your reply contained no tool call. Call a tool to continue, or call reply to answer.',
  OUTPUT_TRUNCATED: 'Your reply was cut off before a complete tool call. Send a shorter one.',
  CONTROL_MIXED: 'reply must be the only tool call in a reply. Send it again on its own.',
  CONTROL_ARGUMENTS_INVALID: 'The arguments of reply do not match its parameters. Fix them.',
  UNKNOWN_TOOL: 'Not executed: no such tool is available to you.',
  INVALID_ARGUMENTS: 'Not executed: the arguments do not match the tool parameters.',
  TOO_MANY_TOOL_CALLS: 'Not executed: this reply has more tool calls than allowed.',
  DUPLICATE_CALL: 'Not executed: the same call already succeeded and its result is above.',
  REPEATED_INTENT: 'Not executed: this call was repeated too many times.',
} as const;
type FeedbackCode = keyof typeof FEEDBACK;

const base = (state: MainState) => ({ workflowRunId: state.workflowRunId, turnId: state.turnId });

function feedback(state: MainState, code: FeedbackCode, toolCallId?: string): NewLogRecord {
  return {
    ...base(state),
    type: 'FEEDBACK',
    agentRunId: state.agentRunId,
    code,
    message: FEEDBACK[code],
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function submission(
  state: MainState,
  unit: MainUnit,
  input: UnitInputV1,
  display: SubmitUnitRequestV1['display'],
): {
  readonly state: MainState;
  readonly request: SubmitUnitRequestV1;
  readonly record: NewLogRecord;
} {
  const counter = state.unitCounter + 1;
  const unitRunPath = `${state.agentRunId}/round-${String(state.round)}/${String(counter)}`;
  const path = `${unitRunPath}#1`;
  const requestId = pathDerivedId('req', path);
  const unitRunId = pathDerivedId('unr', unitRunPath);
  return {
    state: { ...state, unitCounter: counter },
    request: {
      requestId,
      sessionId: state.sessionId,
      workflowRunId: state.workflowRunId,
      agentRunId: state.agentRunId,
      unitRunId,
      path,
      unitRef: unit.ref,
      input,
      display,
    },
    record: {
      ...base(state),
      type: 'UNIT_SUBMITTED',
      requestId,
      path,
      agentRunId: state.agentRunId,
      unitRunId,
      unitRef: unit.ref,
      inputSource: { kind: 'STRUCTURED', input },
    },
  };
}

function one(
  state: MainState,
  role: 'ORIENT' | 'CONTEXT' | 'MODEL' | 'PUBLISH',
  unit: MainUnit,
  input: UnitInputV1,
  toolName: string,
  records: readonly NewLogRecord[] = [],
): MainTransition {
  const made = submission(state, unit, input, { toolName, argsSummary: '' });
  return {
    state: {
      ...made.state,
      pending: new Map([[made.request.requestId, { role, unit }]]),
    },
    records: [...records, made.record],
    submissions: [made.request],
  };
}

const ended = (
  state: MainState,
  ending: MainEnding,
  records: readonly NewLogRecord[] = [],
): MainTransition => ({
  state: { ...state, pending: new Map() },
  records,
  submissions: [],
  ending,
});

function nextRound(
  state: MainState,
  context: MainContext,
  records: readonly NewLogRecord[] = [],
): MainTransition {
  const exhausted = state.budget.agentRun === 'EXHAUSTED' || state.budget.turn === 'EXHAUSTED';
  if (exhausted) return ended(state, { kind: 'DEGRADED', reason: 'BUDGET_EXHAUSTED' }, records);
  const atLimit = state.round >= state.definitions.limits.maxRounds;
  const wrapUpReason = state.wrapUpReason ?? (atLimit ? 'ROUND_LIMIT' : undefined);
  const final = wrapUpReason !== undefined;
  if (final && state.finalUsed)
    return ended(state, { kind: 'DEGRADED', reason: wrapUpReason }, records);
  const next: MainState = {
    ...state,
    round: state.round + 1,
    final,
    finalUsed: state.finalUsed || final,
    roundHadOk: false,
    ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
  };
  const status: ContextAssembleInputV1['status'] = {
    round: next.round,
    maxRounds: next.definitions.limits.maxRounds,
    budget: next.budget,
    final,
    ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
  };
  return one(
    next,
    'CONTEXT',
    next.definitions.contextAssemble,
    context.assembleInput(status, final),
    'context',
    records,
  );
}

export function startMain(
  input: Pick<
    MainState,
    | 'workflowRunId'
    | 'sessionId'
    | 'turnId'
    | 'agentRunId'
    | 'effort'
    | 'definitions'
    | 'orientPackRef'
  >,
  context: MainContext,
): MainTransition {
  const state: MainState = {
    ...input,
    round: 0,
    final: false,
    finalUsed: false,
    budget: NORMAL_BUDGET,
    pending: new Map(),
    unitCounter: 0,
    succeeded: [],
    intents: [],
    consecutiveErrors: 0,
    noProgress: 0,
    regenerations: 0,
    roundHadOk: false,
  };
  const { orient } = input.definitions;
  if (orient === undefined || input.orientPackRef !== undefined) return nextRound(state, context);
  return one(state, 'ORIENT', orient, { objective: context.objective }, 'repository_orient');
}

function wrapUp(state: MainState, reason: WrapUpReason): MainState {
  return state.wrapUpReason === undefined ? { ...state, wrapUpReason: reason } : state;
}

function applyBudget(state: MainState, report: UnitReportV1): MainState {
  const next = { ...state, budget: report.budget };
  const wrapping = report.budget.agentRun !== 'NORMAL' || report.budget.turn !== 'NORMAL';
  return wrapping ? wrapUp(next, 'BUDGET_WRAP_UP') : next;
}

const handlingOf = (unit: MainUnit, code: string): FailureHandling =>
  unit.failurePolicy[code] ?? 'FATAL';

function failed(
  state: MainState,
  pending: Pending,
  code: ReasonCodeV1,
  context: MainContext,
  records: readonly NewLogRecord[] = [],
): MainTransition {
  if (code === 'LIMIT_EXCEEDED' && pending.role === 'CONTEXT')
    return state.final
      ? ended(state, { kind: 'DEGRADED', reason: 'CONTEXT_LIMIT' }, records)
      : nextRound(wrapUp(state, 'CONTEXT_LIMIT'), context, records);
  switch (handlingOf(pending.unit, code)) {
    case 'RETURN_TO_MODEL':
      return nextRound(state, context, records);
    case 'FINAL_CALL':
      return nextRound(wrapUp(state, 'BUDGET_WRAP_UP'), context, records);
    case 'DEGRADED_REPORT':
      return ended(
        state,
        { kind: 'DEGRADED', reason: state.wrapUpReason ?? 'BUDGET_WRAP_UP' },
        records,
      );
    case 'FATAL':
      return ended(state, { kind: 'FAILED', code }, records);
  }
}

const intentOf = (call: ModelToolCall): string =>
  sha256Hex(new TextEncoder().encode(canonicalJson([call.toolName, call.arguments])));

function modelTurnRecord(
  state: MainState,
  report: Extract<UnitReportV1, { status: 'OK' }>,
  calls: readonly ModelToolCall[],
): NewLogRecord {
  if (report.outputRef === undefined) throw new Error('A model report has no output reference');
  return {
    ...base(state),
    type: 'MODEL_TURN',
    requestId: report.requestId,
    outputRef: report.outputRef,
    toolCalls: calls.map((call) => ({
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      argsDigest: sha256Hex(new TextEncoder().encode(canonicalJson(call.arguments))),
    })),
    ...(report.reasoningRef === undefined ? {} : { reasoningRef: report.reasoningRef }),
    replayable: true,
  };
}

function afterTools(
  state: MainState,
  context: MainContext,
  config: MainConfig,
  records: readonly NewLogRecord[],
): MainTransition {
  const noProgress = state.roundHadOk ? 0 : state.noProgress + 1;
  const next = { ...state, noProgress };
  return nextRound(
    noProgress >= config.noProgressRounds ? wrapUp(next, 'NO_PROGRESS') : next,
    context,
    records,
  );
}

function invalidReply(
  state: MainState,
  code: FeedbackCode,
  calls: readonly ModelToolCall[],
  context: MainContext,
  config: MainConfig,
  records: readonly NewLogRecord[],
): MainTransition {
  if (state.final) return ended(state, { kind: 'DEGRADED', reason: 'FINAL_CALL_INVALID' }, records);
  const regenerations = state.regenerations + 1;
  const next =
    regenerations >= config.regenerationLimit
      ? wrapUp({ ...state, regenerations }, 'REGENERATION_LIMIT')
      : { ...state, regenerations };
  const notes =
    calls.length === 0
      ? [feedback(state, code)]
      : calls.map((call) => feedback(state, code, call.toolCallId));
  return nextRound(next, context, [...records, ...notes]);
}

function handleModel(
  state: MainState,
  report: Extract<UnitReportV1, { status: 'OK' }>,
  context: MainContext,
  config: MainConfig,
): MainTransition {
  const output = report.output as {
    readonly finishReason: string;
    readonly toolCalls: readonly ModelToolCall[];
  };
  const calls = output.toolCalls;
  const turn = modelTurnRecord(state, report, calls);
  // The output holds tool arguments, reply text included: bodies stay in the artifact.
  const complete = completion(state, report) as Extract<NewLogRecord, { type: 'UNIT_COMPLETED' }>;
  const records: NewLogRecord[] = [
    {
      ...base(state),
      type: 'UNIT_COMPLETED',
      requestId: complete.requestId,
      status: complete.status,
      budget: complete.budget,
      ...(complete.outputRef === undefined ? {} : { outputRef: complete.outputRef }),
    },
    turn,
  ];
  if (calls.length === 0) {
    return invalidReply(
      state,
      output.finishReason === 'LENGTH' ? 'OUTPUT_TRUNCATED' : 'NO_ACTION',
      calls,
      context,
      config,
      records,
    );
  }
  const reply = calls.find((call) => call.toolName === state.definitions.replyToolName);
  if (reply !== undefined) {
    if (calls.length > 1)
      return invalidReply(state, 'CONTROL_MIXED', calls, context, config, records);
    if (
      reply.arguments === null ||
      !validate(state.definitions.replyParameters, reply.arguments).ok
    )
      return invalidReply(state, 'CONTROL_ARGUMENTS_INVALID', calls, context, config, records);
    if (report.outputRef === undefined) throw new Error('A model report has no output reference');
    return one(
      { ...state, modelOutputRef: report.outputRef },
      'PUBLISH',
      state.definitions.messagePublish,
      {
        kind: 'REPLY',
        agentLabel: state.definitions.label,
        source: { modelOutputRef: report.outputRef, toolCallId: reply.toolCallId },
      },
      'reply',
      records,
    );
  }
  if (state.final) return ended(state, { kind: 'DEGRADED', reason: 'FINAL_CALL_INVALID' }, records);

  let next = state;
  const pending = new Map<string, Pending>();
  const submissions: SubmitUnitRequestV1[] = [];
  const seen = new Set<string>();
  let accepted = 0;
  for (const call of calls) {
    const tool = state.definitions.tools.find((candidate) => candidate.modelName === call.toolName);
    if (tool === undefined) {
      records.push(feedback(state, 'UNKNOWN_TOOL', call.toolCallId));
      continue;
    }
    accepted += 1;
    if (accepted > state.definitions.limits.maxToolCallsPerRound) {
      records.push(feedback(state, 'TOO_MANY_TOOL_CALLS', call.toolCallId));
      continue;
    }
    if (call.arguments === null || !validate(tool.parameters, call.arguments).ok) {
      records.push(feedback(state, 'INVALID_ARGUMENTS', call.toolCallId));
      continue;
    }
    const intent = intentOf(call);
    if (next.succeeded.includes(intent) || seen.has(intent)) {
      records.push(feedback(state, 'DUPLICATE_CALL', call.toolCallId));
      continue;
    }
    const window = [...next.intents, intent].slice(-config.repeatedIntent.window);
    const repeats = window.filter((entry) => entry === intent).length;
    next = { ...next, intents: window };
    if (repeats >= config.repeatedIntent.stopAt) {
      records.push(feedback(state, 'REPEATED_INTENT', call.toolCallId));
      next = wrapUp(next, 'REPEATED_INTENT');
      continue;
    }
    seen.add(intent);
    const made = submission(next, tool.unit, call.arguments as UnitInputV1, {
      toolName: tool.modelName,
      argsSummary: '',
    });
    next = made.state;
    pending.set(made.request.requestId, { role: 'TOOL', unit: tool.unit, call, intent });
    submissions.push(made.request);
    records.push({
      ...(made.record as Extract<NewLogRecord, { type: 'UNIT_SUBMITTED' }>),
      inputSource: {
        kind: 'TOOL_CALL',
        modelTurnRequestId: report.requestId,
        toolCallId: call.toolCallId,
      },
    });
  }
  if (submissions.length === 0) return afterTools(next, context, config, records);
  return { state: { ...next, pending }, records, submissions };
}

function handleTool(
  state: MainState,
  pending: Extract<Pending, { role: 'TOOL' }>,
  report: UnitReportV1,
  context: MainContext,
  config: MainConfig,
): MainTransition {
  const records: NewLogRecord[] = [completion(state, report)];
  const ok = report.status === 'OK';
  const consecutiveErrors = ok ? 0 : state.consecutiveErrors + 1;
  let next: MainState = {
    ...state,
    consecutiveErrors,
    roundHadOk: state.roundHadOk || ok,
    succeeded: ok ? [...state.succeeded, pending.intent] : state.succeeded,
  };
  if (consecutiveErrors >= config.consecutiveErrorLimit) next = wrapUp(next, 'CONSECUTIVE_ERRORS');
  if (!ok) {
    const handling = handlingOf(pending.unit, report.reasonCode);
    if (handling === 'FATAL')
      return ended(next, { kind: 'FAILED', code: report.reasonCode }, records);
    if (handling === 'FINAL_CALL') next = wrapUp(next, 'BUDGET_WRAP_UP');
  }
  return next.pending.size === 0
    ? afterTools(next, context, config, records)
    : { state: next, records, submissions: [] };
}

function completion(state: MainState, report: UnitReportV1): NewLogRecord {
  return {
    ...base(state),
    type: 'UNIT_COMPLETED',
    requestId: report.requestId,
    status: report.status,
    budget: report.budget,
    ...(report.status === 'OK'
      ? {
          output: report.output,
          ...(report.outputRef === undefined ? {} : { outputRef: report.outputRef }),
          ...(report.fullRef === undefined ? {} : { fullRef: report.fullRef }),
        }
      : { reasonCode: report.reasonCode }),
  };
}

export function receiveMainReport(
  current: MainState,
  report: UnitReportV1,
  context: MainContext,
  config: MainConfig,
): MainTransition {
  const pending = current.pending.get(report.requestId);
  if (pending === undefined) return { state: current, records: [], submissions: [] };
  const remaining = new Map(current.pending);
  remaining.delete(report.requestId);
  const state = applyBudget({ ...current, pending: remaining }, report);
  if (pending.role === 'TOOL') return handleTool(state, pending, report, context, config);
  const records: NewLogRecord[] = [completion(state, report)];
  if (report.status !== 'OK') {
    if (pending.role === 'MODEL')
      records.push({
        ...base(state),
        type: 'MODEL_ATTEMPT_FAILED',
        requestId: report.requestId,
        reasonCode: report.reasonCode,
      });
    if (pending.role === 'ORIENT') return nextRound(state, context, records);
    return failed(state, pending, report.reasonCode, context, records);
  }
  switch (pending.role) {
    case 'ORIENT':
      return nextRound(
        {
          ...state,
          ...(report.outputRef === undefined ? {} : { orientPackRef: report.outputRef }),
        },
        context,
        records,
      );
    case 'CONTEXT':
      if (report.outputRef === undefined) throw new Error('A context report has no reference');
      return one(
        state,
        'MODEL',
        state.definitions.modelCall,
        {
          contextPackRef: report.outputRef,
          final: state.final,
          effort: state.effort,
          ...(state.final ? { finalMode: 'AUTO' as const } : {}),
        },
        'model',
        records,
      );
    case 'MODEL':
      return handleModel(state, report, context, config);
    case 'PUBLISH':
      return ended(
        state,
        {
          kind: 'REPLIED',
          budget: report.budget,
          ...(report.outputRef === undefined ? {} : { messageRef: report.outputRef }),
        },
        records,
      );
  }
}
