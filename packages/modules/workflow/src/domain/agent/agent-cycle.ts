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
 * One AgentRun as a pure state machine, the same for every Agent (Module/Workflow 7): every step returns the log
 * records to append first and the Units to submit afterwards. The Round order is M1's:
 * context-assemble, model-call, then all tool Units of that reply.
 */
export type WrapUpReason = (typeof WRAP_UP_REASONS_V1)[number];
type Schema = Parameters<typeof validate>[0];

export interface AgentUnit {
  readonly ref: PinnedDefinitionRef;
  readonly failurePolicy: Readonly<Partial<Record<string, FailureHandling>>>;
}
export interface AgentTool {
  readonly modelName: string;
  readonly unit: AgentUnit;
  readonly parameters: Schema;
}
export interface AgentDefinitions {
  readonly label: string;
  readonly limits: { readonly maxRounds: number; readonly maxToolCallsPerRound: number };
  readonly orient?: AgentUnit;
  readonly contextAssemble: AgentUnit;
  readonly modelCall: AgentUnit;
  /** message-publish for a reply, report-publish for a report. */
  readonly publish: AgentUnit;
  readonly tools: readonly AgentTool[];
  readonly finish: {
    readonly kind: 'REPLY' | 'REPORT';
    readonly toolName: string;
    readonly parameters: Schema;
  };
  readonly handoff?: { readonly toolName: string; readonly parameters: Schema };
}
export interface AgentConfig {
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
  | {
      readonly role: 'ORIENT' | 'CONTEXT' | 'MODEL' | 'PUBLISH' | 'DEGRADED' | 'REPORT';
      readonly unit: AgentUnit;
    }
  | {
      readonly role: 'TOOL';
      readonly unit: AgentUnit;
      readonly call: ModelToolCall;
      readonly intent: string;
    };

export interface AgentState {
  readonly workflowRunId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentRunId: string;
  readonly effort: ThinkingEffort;
  readonly definitions: AgentDefinitions;
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
  readonly degradedReason?: Extract<AgentEnding, { kind: 'DEGRADED' }>['reason'];
}

export type AgentEnding =
  | { readonly kind: 'REPLIED'; readonly messageRef?: ArtifactRef; readonly budget: BudgetView }
  | {
      readonly kind: 'DEGRADED';
      readonly reason: WrapUpReason | 'BUDGET_EXHAUSTED' | 'FINAL_CALL_INVALID';
    }
  | {
      /** A valid finish or handoff: Workflow decides what follows from the arguments. */
      readonly kind: 'FINISHED' | 'HANDED_OFF';
      readonly arguments: unknown;
      readonly source: ControlSource;
    }
  | { readonly kind: 'REPORTED'; readonly reportRef?: ArtifactRef; readonly budget: BudgetView }
  | { readonly kind: 'FAILED'; readonly code: ReasonCodeV1 };

/** Where a control call's arguments live; bodies stay in the model output artifact. */
export interface ControlSource {
  readonly modelTurnRequestId: string;
  readonly modelOutputRef: ArtifactRef;
  readonly toolCallId: string;
}

export interface AgentTransition {
  readonly state: AgentState;
  readonly records: readonly NewLogRecord[];
  readonly submissions: readonly SubmitUnitRequestV1[];
  readonly ending?: AgentEnding;
}

/** The facts context-assemble needs that the log, not this machine, supplies. */
export interface AgentContext {
  readonly assembleInput: (
    status: ContextAssembleInputV1['status'],
    final: boolean,
  ) => ContextAssembleInputV1;
  /** The first prompt of the run: no event or log record carries its text. */
  readonly objectiveRef: ArtifactRef;
}

const NORMAL_BUDGET: BudgetView = { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' };
const FEEDBACK = {
  NO_ACTION: 'Your reply contained no tool call. Call a tool to continue, or finish.',
  OUTPUT_TRUNCATED: 'Your reply was cut off before a complete tool call. Send a shorter one.',
  CONTROL_MIXED: 'A finishing call must be the only tool call in a reply. Send it on its own.',
  CONTROL_NOT_ALLOWED: 'That control tool is not available at this point.',
  CONTROL_ARGUMENTS_INVALID: 'The arguments of the finishing call do not match its parameters.',
  UNKNOWN_TOOL: 'Not executed: no such tool is available to you.',
  INVALID_ARGUMENTS: 'Not executed: the arguments do not match the tool parameters.',
  TOO_MANY_TOOL_CALLS: 'Not executed: this reply has more tool calls than allowed.',
  DUPLICATE_CALL: 'Not executed: the same call already succeeded and its result is above.',
  REPEATED_INTENT: 'Not executed: this call was repeated too many times.',
} as const;
type FeedbackCode = keyof typeof FEEDBACK;

const base = (state: AgentState) => ({ workflowRunId: state.workflowRunId, turnId: state.turnId });

function feedback(state: AgentState, code: FeedbackCode, toolCallId?: string): NewLogRecord {
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
  state: AgentState,
  unit: AgentUnit,
  input: UnitInputV1,
  display: SubmitUnitRequestV1['display'],
): {
  readonly state: AgentState;
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
  state: AgentState,
  role: 'ORIENT' | 'CONTEXT' | 'MODEL' | 'PUBLISH' | 'DEGRADED' | 'REPORT',
  unit: AgentUnit,
  input: UnitInputV1,
  toolName: string,
  records: readonly NewLogRecord[] = [],
): AgentTransition {
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
  state: AgentState,
  ending: AgentEnding,
  records: readonly NewLogRecord[] = [],
): AgentTransition => ({
  state: { ...state, pending: new Map() },
  records,
  submissions: [],
  ending,
});

/** The reason reaches the user as a message; ending the AgentRun waits for its report. */
function degrade(
  state: AgentState,
  reason: Extract<AgentEnding, { kind: 'DEGRADED' }>['reason'],
  records: readonly NewLogRecord[],
): AgentTransition {
  // A report has its own degraded form, which Workflow builds from the ending.
  if (state.definitions.finish.kind === 'REPORT')
    return ended(state, { kind: 'DEGRADED', reason }, records);
  return one(
    { ...state, degradedReason: reason },
    'DEGRADED',
    state.definitions.publish,
    { kind: 'DEGRADED_REPLY', agentLabel: state.definitions.label, reason },
    'reply',
    records,
  );
}

function nextRound(
  state: AgentState,
  context: AgentContext,
  records: readonly NewLogRecord[] = [],
): AgentTransition {
  const exhausted = state.budget.agentRun === 'EXHAUSTED' || state.budget.turn === 'EXHAUSTED';
  if (exhausted) return degrade(state, 'BUDGET_EXHAUSTED', records);
  const atLimit = state.round >= state.definitions.limits.maxRounds;
  const wrapUpReason = state.wrapUpReason ?? (atLimit ? 'ROUND_LIMIT' : undefined);
  const final = wrapUpReason !== undefined;
  if (final && state.finalUsed) return degrade(state, wrapUpReason, records);
  const next: AgentState = {
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

export function startAgent(
  input: Pick<
    AgentState,
    | 'workflowRunId'
    | 'sessionId'
    | 'turnId'
    | 'agentRunId'
    | 'effort'
    | 'definitions'
    | 'orientPackRef'
  >,
  context: AgentContext,
): AgentTransition {
  const state: AgentState = {
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
  return one(state, 'ORIENT', orient, { objectiveRef: context.objectiveRef }, 'repository_orient');
}

function wrapUp(state: AgentState, reason: WrapUpReason): AgentState {
  return state.wrapUpReason === undefined ? { ...state, wrapUpReason: reason } : state;
}

function applyBudget(state: AgentState, report: UnitReportV1): AgentState {
  const next = { ...state, budget: report.budget };
  const wrapping = report.budget.agentRun !== 'NORMAL' || report.budget.turn !== 'NORMAL';
  return wrapping ? wrapUp(next, 'BUDGET_WRAP_UP') : next;
}

const handlingOf = (unit: AgentUnit, code: string): FailureHandling =>
  unit.failurePolicy[code] ?? 'FATAL';

function failed(
  state: AgentState,
  pending: Pending,
  code: ReasonCodeV1,
  context: AgentContext,
  records: readonly NewLogRecord[] = [],
): AgentTransition {
  if (code === 'LIMIT_EXCEEDED' && pending.role === 'CONTEXT')
    return state.final
      ? degrade(state, 'CONTEXT_LIMIT', records)
      : nextRound(wrapUp(state, 'CONTEXT_LIMIT'), context, records);
  switch (handlingOf(pending.unit, code)) {
    case 'RETURN_TO_MODEL':
      return nextRound(state, context, records);
    case 'FINAL_CALL':
      return nextRound(wrapUp(state, 'BUDGET_WRAP_UP'), context, records);
    case 'DEGRADED_REPORT':
      return degrade(state, state.wrapUpReason ?? 'BUDGET_WRAP_UP', records);
    case 'FATAL':
      return ended(state, { kind: 'FAILED', code }, records);
  }
}

const intentOf = (call: ModelToolCall): string =>
  sha256Hex(new TextEncoder().encode(canonicalJson([call.toolName, call.arguments])));

function modelTurnRecord(
  state: AgentState,
  report: Extract<UnitReportV1, { status: 'OK' }>,
  calls: readonly ModelToolCall[],
): NewLogRecord {
  if (report.outputRef === undefined) throw new Error('A model report has no output reference');
  return {
    ...base(state),
    type: 'MODEL_TURN',
    requestId: report.requestId,
    agentRunId: state.agentRunId,
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
  state: AgentState,
  context: AgentContext,
  config: AgentConfig,
  records: readonly NewLogRecord[],
): AgentTransition {
  const noProgress = state.roundHadOk ? 0 : state.noProgress + 1;
  const next = { ...state, noProgress };
  return nextRound(
    noProgress >= config.noProgressRounds ? wrapUp(next, 'NO_PROGRESS') : next,
    context,
    records,
  );
}

function invalidReply(
  state: AgentState,
  code: FeedbackCode,
  calls: readonly ModelToolCall[],
  context: AgentContext,
  config: AgentConfig,
  records: readonly NewLogRecord[],
): AgentTransition {
  if (state.final) return degrade(state, 'FINAL_CALL_INVALID', records);
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
  state: AgentState,
  report: Extract<UnitReportV1, { status: 'OK' }>,
  context: AgentContext,
  config: AgentConfig,
): AgentTransition {
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
  const { finish, handoff } = state.definitions;
  const control = calls.find(
    (call) => call.toolName === finish.toolName || call.toolName === handoff?.toolName,
  );
  if (control !== undefined) {
    if (calls.length > 1)
      return invalidReply(state, 'CONTROL_MIXED', calls, context, config, records);
    const isHandoff = control.toolName === handoff?.toolName;
    if (isHandoff && state.final)
      return invalidReply(state, 'CONTROL_NOT_ALLOWED', calls, context, config, records);
    const parameters = isHandoff ? handoff.parameters : finish.parameters;
    if (control.arguments === null || !validate(parameters, control.arguments).ok)
      return invalidReply(state, 'CONTROL_ARGUMENTS_INVALID', calls, context, config, records);
    if (report.outputRef === undefined) throw new Error('A model report has no output reference');
    if (!isHandoff && finish.kind === 'REPLY')
      return one(
        { ...state, modelOutputRef: report.outputRef },
        'PUBLISH',
        state.definitions.publish,
        {
          kind: 'REPLY',
          agentLabel: state.definitions.label,
          source: { modelOutputRef: report.outputRef, toolCallId: control.toolCallId },
        },
        finish.toolName,
        records,
      );
    return ended(
      state,
      {
        kind: isHandoff ? 'HANDED_OFF' : 'FINISHED',
        arguments: control.arguments,
        source: {
          modelTurnRequestId: report.requestId,
          modelOutputRef: report.outputRef,
          toolCallId: control.toolCallId,
        },
      },
      records,
    );
  }
  if (state.final) return degrade(state, 'FINAL_CALL_INVALID', records);

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
  state: AgentState,
  pending: Extract<Pending, { role: 'TOOL' }>,
  report: UnitReportV1,
  context: AgentContext,
  config: AgentConfig,
): AgentTransition {
  const records: NewLogRecord[] = [completion(state, report)];
  const ok = report.status === 'OK';
  const consecutiveErrors = ok ? 0 : state.consecutiveErrors + 1;
  let next: AgentState = {
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

function completion(state: AgentState, report: UnitReportV1): NewLogRecord {
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

/** Publishes the report of a finished AgentRun; `source` keeps its text out of the log. */
export function publishReport(
  state: AgentState,
  input: UnitInputV1,
  source: ControlSource | undefined,
): AgentTransition {
  const made = one(state, 'REPORT', state.definitions.publish, input, 'report');
  if (source === undefined) return made;
  return {
    ...made,
    records: made.records.map((record) =>
      record.type === 'UNIT_SUBMITTED'
        ? {
            ...record,
            inputSource: {
              kind: 'TOOL_CALL',
              modelTurnRequestId: source.modelTurnRequestId,
              toolCallId: source.toolCallId,
            },
          }
        : record,
    ),
  };
}

export function receiveAgentReport(
  current: AgentState,
  report: UnitReportV1,
  context: AgentContext,
  config: AgentConfig,
): AgentTransition {
  const pending = current.pending.get(report.requestId);
  if (pending === undefined) return { state: current, records: [], submissions: [] };
  const remaining = new Map(current.pending);
  remaining.delete(report.requestId);
  const state = applyBudget({ ...current, pending: remaining }, report);
  if (pending.role === 'TOOL') return handleTool(state, pending, report, context, config);
  if (pending.role === 'DEGRADED')
    return ended(state, { kind: 'DEGRADED', reason: state.degradedReason ?? 'BUDGET_EXHAUSTED' }, [
      completion(state, report),
    ]);
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
    case 'REPORT':
      return ended(
        state,
        {
          kind: 'REPORTED',
          budget: report.budget,
          ...(report.outputRef === undefined ? {} : { reportRef: report.outputRef }),
        },
        records,
      );
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
