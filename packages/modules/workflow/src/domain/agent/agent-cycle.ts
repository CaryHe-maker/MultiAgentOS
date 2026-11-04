import {
  WRITE_KINDS,
  canonicalJson,
  pathDerivedId,
  sha256Hex,
  validate,
} from '@multiagentos/contracts';
import type {
  ArtifactRef,
  BudgetView,
  ContextAssembleInput,
  ContextAssembleOutput,
  ExecutionKind,
  FailureHandling,
  ModelToolCall,
  PinnedDefinitionRef,
  ReasonCode,
  SubmitUnitRequest,
  UnitInput,
  UnitReport,
  UpdateActivityRequest,
  UpdateTodosArgs,
  WrapUpReason,
} from '@multiagentos/contracts';
import type { NewLogRecord } from '../../session/session-log-store.js';

/**
 * One AgentRun as a pure state machine, the same for every Agent (Module/Workflow 7): every step returns the log
 * records to append first and the Units to submit afterwards. The Round order is
 * context-assemble, model-call, then all tool Units of that reply.
 */
type Schema = Parameters<typeof validate>[0];

export interface AgentUnit {
  readonly ref: PinnedDefinitionRef;
  readonly failurePolicy: Readonly<Partial<Record<string, FailureHandling>>>;
}
export interface AgentTool {
  readonly modelName: string;
  readonly executionKind: ExecutionKind;
  readonly unit: AgentUnit;
  readonly parameters: Schema;
}
export interface AgentDefinitions {
  readonly label: string;
  readonly limits: { readonly maxRounds: number; readonly maxToolCallsPerRound: number };
  readonly orient?: AgentUnit;
  readonly contextAssemble: AgentUnit;
  readonly modelCall: AgentUnit;
  /** The Unit that publishes what an ended AgentRun leaves behind. */
  readonly publish: AgentUnit;
  readonly tools: readonly AgentTool[];
  /** How this Agent may end: a tool it does not declare cannot end it. */
  readonly endTools: readonly EndTool[];
  /** What is published when no end tool was called validly. */
  readonly onDegraded: DegradedAction;
  readonly todoTool?: { readonly toolName: string; readonly parameters: Schema };
}
/** What follows an end tool; only the runner reads it, never this machine. */
export type EndAction = 'PUBLISH_REPLY' | 'PUBLISH_REPORT' | 'HANDOFF';
export type DegradedAction = 'PUBLISH_NOTICE' | 'PUBLISH_REPORT';
export interface EndTool {
  readonly toolName: string;
  readonly parameters: Schema;
  readonly allowedInFinal: boolean;
  readonly action: EndAction;
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
      readonly role: 'ORIENT' | 'CONTEXT' | 'MODEL' | 'CLOSING';
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
  /** Tools the user rejected in this AgentRun; they are not submitted again. */
  readonly declinedTools: readonly string[];
  readonly fatal?: ReasonCode;
}

/**
 * How an AgentRun ends, the same for every Agent. ENDED says only that a declared end tool was
 * called validly; what follows comes from the definition. CLOSED follows `closeAgent`.
 */
export type AgentEnding =
  | {
      readonly kind: 'ENDED';
      readonly tool: EndTool;
      readonly arguments: unknown;
      readonly source: ControlSource;
    }
  | {
      readonly kind: 'DEGRADED';
      readonly reason: WrapUpReason | 'BUDGET_EXHAUSTED' | 'FINAL_CALL_INVALID';
    }
  | { readonly kind: 'FAILED'; readonly code: ReasonCode }
  | { readonly kind: 'CLOSED'; readonly outputRef?: ArtifactRef; readonly budget: BudgetView };

/** Where a control call's arguments live; bodies stay in the model output artifact. */
export interface ControlSource {
  readonly modelTurnRequestId: string;
  readonly modelOutputRef: ArtifactRef;
  readonly toolCallId: string;
}

export interface AgentTransition {
  readonly state: AgentState;
  readonly records: readonly NewLogRecord[];
  readonly submissions: readonly SubmitUnitRequest[];
  readonly ending?: AgentEnding;
  /** The todo progress for the interface, once the records are durable (WorkflowKernel 2.5). */
  readonly activity?: UpdateActivityRequest['todos'];
}

/** The facts context-assemble needs that the log, not this machine, supplies. */
export interface AgentContext {
  readonly assembleInput: (
    status: ContextAssembleInput['status'],
    final: boolean,
  ) => ContextAssembleInput;
  /** The first prompt of the run: no event or log record carries its text. */
  readonly objectiveRef: ArtifactRef;
  /**
   * What the log adds to a tool's arguments and the model cannot give. Undefined leaves them as
   * they are, and a refusal is a tool result for the model.
   */
  readonly toolInput?: (kind: ExecutionKind, args: unknown) => ToolInput;
}

export type ToolInput =
  | {
      readonly ok: true;
      readonly input: UnitInput;
      readonly workflowFields?: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly message: string };

/** Kinds that change the workspace: what was read before them is no longer what is there. */
const WRITES: ReadonlySet<ExecutionKind> = new Set(WRITE_KINDS);
/** Core's refusals of the call itself: never the Unit's failurePolicy, and never fatal. */
const CORE_REFUSALS: ReadonlySet<string> = new Set([
  'CAPABILITY_NOT_GRANTED',
  'ADMISSION_CHECK_FAILED',
]);

const NORMAL_BUDGET: BudgetView = { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' };
const FEEDBACK = {
  NO_ACTION: 'Your reply contained no tool call. Call a tool to continue, or finish.',
  OUTPUT_TRUNCATED: 'Your reply was cut off before a complete tool call. Send a shorter one.',
  CONTROL_MIXED: 'A finishing call must be the only tool call in a reply. Send it on its own.',
  CONTROL_NOT_ALLOWED: 'That control tool is not available at this point.',
  CONTROL_ARGUMENTS_INVALID: 'The arguments of the finishing call do not match its parameters.',
  UNKNOWN_TOOL: 'Not executed: no such tool is available to you.',
  INVALID_ARGUMENTS: 'Not executed: the arguments do not match the tool parameters.',
  TOOL_INPUT_REFUSED: 'Not executed.',
  TOO_MANY_TOOL_CALLS: 'Not executed: this reply has more tool calls than allowed.',
  DUPLICATE_CALL: 'Not executed: the same call already succeeded and its result is above.',
  REPEATED_INTENT: 'Not executed: this call was repeated too many times.',
  NOT_EXECUTED: 'Not executed: only the finishing call is available now.',
} as const;
/** Word for word the tool result of the refusal itself (M2Design 5.3). */
const rejectedText = (toolName: string): string => `the user rejected tool "${toolName}"`;
type FeedbackCode = keyof typeof FEEDBACK;

const base = (state: AgentState) => ({ workflowRunId: state.workflowRunId, turnId: state.turnId });

function feedback(
  state: AgentState,
  code: FeedbackCode | 'TOOL_REJECTED' | 'TODOS_UPDATED',
  toolCallId?: string,
  message?: string,
): NewLogRecord {
  return {
    ...base(state),
    type: 'FEEDBACK',
    agentRunId: state.agentRunId,
    code,
    message:
      message ?? (code === 'TOOL_REJECTED' || code === 'TODOS_UPDATED' ? '' : FEEDBACK[code]),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function submission(
  state: AgentState,
  unit: AgentUnit,
  input: UnitInput,
  display: SubmitUnitRequest['display'],
): {
  readonly state: AgentState;
  readonly request: SubmitUnitRequest;
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
  role: 'ORIENT' | 'CONTEXT' | 'MODEL' | 'CLOSING',
  unit: AgentUnit,
  input: UnitInput,
  toolName: string,
  records: readonly NewLogRecord[] = [],
): AgentTransition {
  const made = submission(state, unit, input, { toolName, argsSummary: '' });
  // The assembly input is the projection of this very log: recording it would repeat the history.
  const record =
    role === 'CONTEXT' && made.record.type === 'UNIT_SUBMITTED'
      ? {
          ...made.record,
          inputSource: { kind: 'STRUCTURED' as const, input: { final: state.final } },
        }
      : made.record;
  return {
    state: {
      ...made.state,
      pending: new Map([[made.request.requestId, { role, unit }]]),
    },
    records: [...records, record],
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

function degrade(
  state: AgentState,
  reason: Extract<AgentEnding, { kind: 'DEGRADED' }>['reason'],
  records: readonly NewLogRecord[],
): AgentTransition {
  return ended(state, { kind: 'DEGRADED', reason }, records);
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
  const status: ContextAssembleInput['status'] = {
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
    'workflowRunId' | 'sessionId' | 'turnId' | 'agentRunId' | 'definitions' | 'orientPackRef'
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
    declinedTools: [],
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

function applyBudget(state: AgentState, report: UnitReport): AgentState {
  const next = { ...state, budget: report.budget };
  const wrapping = report.budget.agentRun !== 'NORMAL' || report.budget.turn !== 'NORMAL';
  return wrapping ? wrapUp(next, 'BUDGET_WRAP_UP') : next;
}

const handlingOf = (unit: AgentUnit, code: string): FailureHandling =>
  unit.failurePolicy[code] ?? 'FATAL';

function failed(
  state: AgentState,
  pending: Pending,
  code: ReasonCode,
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
  report: Extract<UnitReport, { status: 'OK' }>,
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
  // Every call gets its answer here, also when the AgentRun ends: the history must stay valid.
  const notes =
    calls.length === 0
      ? [feedback(state, code)]
      : calls.map((call) => feedback(state, code, call.toolCallId));
  if (state.final) return degrade(state, 'FINAL_CALL_INVALID', [...records, ...notes]);
  const regenerations = state.regenerations + 1;
  const next =
    regenerations >= config.regenerationLimit
      ? wrapUp({ ...state, regenerations }, 'REGENERATION_LIMIT')
      : { ...state, regenerations };
  return nextRound(next, context, [...records, ...notes]);
}

function handleModel(
  state: AgentState,
  report: Extract<UnitReport, { status: 'OK' }>,
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
  // The one control tool that goes with anything else, and it is handled first (M2Design 3.5).
  const todoTool = state.final ? undefined : state.definitions.todoTool;
  const isTodo = (call: ModelToolCall) => call.toolName === todoTool?.toolName;
  let activity: AgentTransition['activity'];
  if (todoTool !== undefined)
    for (const call of calls.filter(isTodo)) {
      const args =
        call.arguments === null ? undefined : validate(todoTool.parameters, call.arguments);
      if (args === undefined || !args.ok) {
        records.push(feedback(state, 'INVALID_ARGUMENTS', call.toolCallId));
        continue;
      }
      const { todos } = call.arguments as unknown as UpdateTodosArgs;
      const countOf = (status: UpdateTodosArgs['todos'][number]['status']) =>
        todos.filter((todo) => todo.status === status).length;
      const counts = {
        total: todos.length,
        pending: countOf('pending'),
        inProgress: countOf('in_progress'),
        done: countOf('done'),
        cancelled: countOf('cancelled'),
      };
      records.push(
        {
          ...base(state),
          type: 'TODOS_UPDATED',
          agentRunId: state.agentRunId,
          source: { modelTurnRequestId: report.requestId, toolCallId: call.toolCallId },
          counts,
        },
        feedback(
          state,
          'TODOS_UPDATED',
          call.toolCallId,
          `Todos: ${String(counts.total)} items, ${String(counts.done)} done, ${String(counts.inProgress)} in progress.`,
        ),
      );
      const current = todos.find((todo) => todo.status === 'in_progress')?.content.slice(0, 80);
      activity = {
        total: counts.total,
        done: counts.done,
        ...(current === undefined ? {} : { current }),
      };
    }
  const acting = calls.filter((call) => !isTodo(call));
  const transition =
    acting.length === 0
      ? afterTools(state, context, config, records)
      : actOn(state, report, acting, context, config, records);
  return activity === undefined ? transition : { ...transition, activity };
}

function actOn(
  state: AgentState,
  report: Extract<UnitReport, { status: 'OK' }>,
  calls: readonly ModelToolCall[],
  context: AgentContext,
  config: AgentConfig,
  records: NewLogRecord[],
): AgentTransition {
  const endTool = (call: ModelToolCall) =>
    state.definitions.endTools.find((tool) => tool.toolName === call.toolName);
  const control = calls.find((call) => endTool(call) !== undefined);
  const tool = control === undefined ? undefined : endTool(control);
  if (control !== undefined && tool !== undefined) {
    if (calls.length > 1)
      return invalidReply(state, 'CONTROL_MIXED', calls, context, config, records);
    if (state.final && !tool.allowedInFinal)
      return invalidReply(state, 'CONTROL_NOT_ALLOWED', calls, context, config, records);
    if (control.arguments === null || !validate(tool.parameters, control.arguments).ok)
      return invalidReply(state, 'CONTROL_ARGUMENTS_INVALID', calls, context, config, records);
    if (report.outputRef === undefined) throw new Error('A model report has no output reference');
    return ended(
      state,
      {
        kind: 'ENDED',
        tool,
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
  if (state.final)
    return degrade(state, 'FINAL_CALL_INVALID', [
      ...records,
      ...calls.map((call) => feedback(state, 'NOT_EXECUTED', call.toolCallId)),
    ]);

  let next = state;
  const pending = new Map<string, Pending>();
  const submissions: SubmitUnitRequest[] = [];
  const seen = new Set<string>();
  let accepted = 0;
  for (const call of calls) {
    const tool = state.definitions.tools.find((candidate) => candidate.modelName === call.toolName);
    if (tool === undefined) {
      records.push(feedback(state, 'UNKNOWN_TOOL', call.toolCallId));
      continue;
    }
    accepted += 1;
    if (next.declinedTools.includes(tool.modelName)) {
      records.push(feedback(state, 'TOOL_REJECTED', call.toolCallId, rejectedText(tool.modelName)));
      continue;
    }
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
    const completed: ToolInput = context.toolInput?.(tool.executionKind, call.arguments) ?? {
      ok: true,
      input: call.arguments as UnitInput,
    };
    if (!completed.ok) {
      records.push(feedback(state, 'TOOL_INPUT_REFUSED', call.toolCallId, completed.message));
      continue;
    }
    const made = submission(next, tool.unit, completed.input, {
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
        ...(completed.workflowFields === undefined
          ? {}
          : { workflowFields: { ...completed.workflowFields } }),
      },
    });
  }
  if (submissions.length === 0) return afterTools(next, context, config, records);
  return { state: { ...next, pending }, records, submissions };
}

function handleTool(
  state: AgentState,
  pending: Extract<Pending, { role: 'TOOL' }>,
  report: UnitReport,
  context: AgentContext,
  config: AgentConfig,
): AgentTransition {
  const records: NewLogRecord[] = [completion(state, report)];
  const ok = report.status === 'OK';
  const declined = report.status === 'REJECTED' && report.reasonCode === 'USER_DECLINED';
  // A refusal is the user's decision, not a mistake of the model.
  const consecutiveErrors = ok
    ? 0
    : declined
      ? state.consecutiveErrors
      : state.consecutiveErrors + 1;
  let next: AgentState = {
    ...state,
    consecutiveErrors,
    roundHadOk: state.roundHadOk || ok,
    // After a write nothing read before it may be answered with "the result is above".
    succeeded: !ok
      ? state.succeeded
      : WRITES.has(report.executionKind)
        ? []
        : [...state.succeeded, pending.intent],
  };
  if (consecutiveErrors >= config.consecutiveErrorLimit) next = wrapUp(next, 'CONSECUTIVE_ERRORS');
  // Kernel's refusals have fixed meanings, not the Unit's failurePolicy (Module/Workflow 7): a quota
  // names the wrap-up, and a declined authorization is a tool result the model reads.
  if (report.status === 'REJECTED' && report.reasonCode === 'QUOTA_EXHAUSTED') {
    next = wrapUp(next, report.quota === 'TOOL_UNITS' ? 'TOOL_UNIT_LIMIT' : 'WALL_CLOCK_LIMIT');
  } else if (declined) {
    const { toolName } = pending.call;
    if (!next.declinedTools.includes(toolName))
      next = { ...next, declinedTools: [...next.declinedTools, toolName] };
  } else if (!ok && !CORE_REFUSALS.has(report.reasonCode)) {
    const handling = handlingOf(pending.unit, report.reasonCode);
    if (handling === 'FATAL') next = { ...next, fatal: next.fatal ?? report.reasonCode };
    if (handling === 'FINAL_CALL') next = wrapUp(next, 'BUDGET_WRAP_UP');
  }
  // The batch finishes first, so every call of this reply has its result in the log.
  if (next.fatal !== undefined && next.pending.size === 0)
    return ended(next, { kind: 'FAILED', code: next.fatal }, records);
  return next.pending.size === 0
    ? afterTools(next, context, config, records)
    : { state: next, records, submissions: [] };
}

function assembled(state: AgentState, report: Extract<UnitReport, { status: 'OK' }>): NewLogRecord {
  const { projectionDigest, headDigest, elidedEntries } = report.output as ContextAssembleOutput;
  return {
    ...base(state),
    type: 'CONTEXT_ASSEMBLED',
    requestId: report.requestId,
    projectionDigest,
    headDigest,
    ...(elidedEntries.length === 0 ? {} : { elidedEntries }),
  };
}

function completion(state: AgentState, report: UnitReport): NewLogRecord {
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

/**
 * Submits the last Unit of an ended AgentRun; its report ends the cycle with CLOSED. `source`
 * keeps text the model wrote out of the log.
 */
export function closeAgent(
  state: AgentState,
  input: UnitInput,
  source: ControlSource | undefined,
): AgentTransition {
  const made = one(state, 'CLOSING', state.definitions.publish, input, 'publish');
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
  report: UnitReport,
  context: AgentContext,
  config: AgentConfig,
): AgentTransition {
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
    if (pending.role === 'CLOSING')
      return ended(state, { kind: 'FAILED', code: report.reasonCode }, records);
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
      records.push(assembled(state, report));
      return one(
        state,
        'MODEL',
        state.definitions.modelCall,
        {
          contextPackRef: report.outputRef,
          final: state.final,
          ...(state.final ? { finalMode: 'AUTO' as const } : {}),
        },
        'model',
        records,
      );
    case 'MODEL':
      return handleModel(state, report, context, config);
    case 'CLOSING':
      return ended(
        state,
        {
          kind: 'CLOSED',
          budget: report.budget,
          ...(report.outputRef === undefined ? {} : { outputRef: report.outputRef }),
        },
        records,
      );
  }
}
