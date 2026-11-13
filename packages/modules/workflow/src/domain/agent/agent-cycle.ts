import {
  WRITE_KINDS,
  canonicalJson,
  normalizeRequestPath,
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
  /** The Unit reads outside the workspace (`external.read`): its failures are the user's to judge. */
  readonly external?: true;
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
  /** The Unit that publishes what an ended AgentRun leaves behind; a SubAgent has none. */
  readonly publish?: AgentUnit;
  readonly tools: readonly AgentTool[];
  /** How this Agent may end: a tool it does not declare cannot end it. */
  readonly endTools: readonly EndTool[];
  /** What is published when no end tool was called validly. */
  readonly onDegraded: DegradedAction;
  readonly todoTool?: { readonly toolName: string; readonly parameters: Schema };
  /** `run_subagents`: a control tool whose call the task graph answers, instead of ending the AgentRun. */
  readonly spawnTool?: { readonly toolName: string; readonly parameters: Schema };
  /** `sub_mission`: a part of the work handed to a pre-orchestrated template (Orchestration 3.9). */
  readonly subMissionTool?: { readonly toolName: string; readonly parameters: Schema };
  /** `ask_user`: the same shape, answered by the user through a HUMAN node (M2Design 3.4). */
  readonly askTool?: { readonly toolName: string; readonly parameters: Schema };
  /** `sleep`: ends the segment; the runner checks what it waits for (Orchestration 4.1). */
  readonly sleepTool?: { readonly toolName: string; readonly parameters: Schema };
  /** `send_message`: answered by the runner at once, after it routed the message (Orchestration 5). */
  readonly messageTool?: { readonly toolName: string; readonly parameters: Schema };
  /** `view_tasks`: answered by the runner with the tree as it is now (Orchestration 3.7). */
  readonly viewTasksTool?: { readonly toolName: string; readonly parameters: Schema };
  /** `stop_subagents`: answered by the runner once it stopped them (Orchestration 5.1). */
  readonly stopTool?: { readonly toolName: string; readonly parameters: Schema };
  /** `job_output`, `job_list`, `job_kill`: answered by the runner (Orchestration 6.2). */
  readonly jobTools?: readonly {
    readonly action: JobAction;
    readonly toolName: string;
    readonly parameters: Schema;
  }[];
}
export type JobAction = 'OUTPUT' | 'LIST' | 'KILL';
/** What follows an end tool; only the runner reads it, never this machine. */
export type EndAction = 'PUBLISH_REPLY' | 'PUBLISH_REPORT' | 'HANDOFF' | 'FINISH_SUBAGENT';
export type DegradedAction = 'PUBLISH_NOTICE' | 'PUBLISH_REPORT' | 'RETURN_PARTIAL';
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
  readonly maxNestedInstructions: number;
  readonly maxSubagentsPerCall: number;
  readonly maxDependencyDepth: number;
  readonly maxTasks: number;
  readonly maxSpawnCalls: number;
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
      /** The model output the call came from: a resubmission after a pause cites it again. */
      readonly modelTurnRequestId: string;
    }
  /**
   * A call that the task graph answers, not a Unit: `run_subagents`. It is one more tool call that
   * has not come back, and the round goes on when it has (keyed by its tool call id, M2Design 3.6).
   */
  | { readonly role: 'DELEGATED' };

export interface DeferredWrite {
  readonly tool: AgentTool;
  readonly call: ModelToolCall;
  readonly intent: string;
  readonly modelTurnRequestId: string;
}

/**
 * A Unit a pause cancelled and the cycle will submit again when the run goes on (M2Design 4.4).
 * A tool is submitted as it was; the others are made again from the log as it stands then, which
 * is how a note added while continuing reaches the model.
 */
export type Held =
  | { readonly kind: 'TOOL'; readonly planned: DeferredWrite }
  | { readonly kind: 'ORIENT' }
  | { readonly kind: 'ASSEMBLE' };

export interface AgentState {
  readonly workflowRunId: string;
  readonly sessionId: string;
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
  /** How many times in a row the model was refused for the size of the context (Core 6a). */
  readonly overflows: number;
  readonly roundHadOk: boolean;
  /** A call of this round failed and was counted: the other calls of a batch do not count again. */
  readonly roundErrored: boolean;
  /** Rounds in a row that only kept the todo list: the first is not judged by progress. */
  readonly todoOnlyRounds: number;
  /**
   * Writes of this reply to a path another of its writes has: each needs what the one before it
   * left, so they are submitted one at a time (Module/Workflow 7, item 10).
   */
  readonly deferred: readonly DeferredWrite[];
  /** Tools the user rejected in this AgentRun; they are not submitted again. */
  readonly declinedTools: readonly string[];
  /** Calls of `run_subagents` refused one after the other; two take the tool away. */
  readonly invalidSpawns: number;
  readonly spawnWithdrawn: boolean;
  /** What a pause cancelled, until `resumeAfterPause`. */
  readonly held: readonly Held[];
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
      /**
       * The finishing call of the last round, which was refused for its form: what it said is kept,
       * and the caller reads it as written with the reason it was refused.
       */
      readonly unfinished?: { readonly source: ControlSource; readonly why: string };
    }
  | { readonly kind: 'FAILED'; readonly code: ReasonCode }
  /** `run_subagents` was called validly in form; the runner validates the tasks. */
  | {
      readonly kind: 'SPAWN';
      readonly arguments: unknown;
      readonly source: ControlSource;
      /** A `sub_mission` call: one task, the root of a pre-orchestrated template (3.9). */
      readonly submission?: true;
    }
  /** `ask_user` was called validly in form; the runner checks what it points at. */
  | { readonly kind: 'ASK'; readonly arguments: unknown; readonly source: ControlSource }
  /** `sleep` was called validly in form; the runner checks it can be woken, then ends the segment. */
  | { readonly kind: 'SLEEP'; readonly arguments: unknown; readonly source: ControlSource }
  /** `send_message` was called validly in form; the runner routes it and answers the call. */
  | { readonly kind: 'MESSAGE'; readonly arguments: unknown; readonly source: ControlSource }
  /** `view_tasks`: the runner answers with the tree. */
  | { readonly kind: 'VIEW_TASKS'; readonly arguments: unknown; readonly source: ControlSource }
  /** `stop_subagents`: the runner stops them and answers. */
  | { readonly kind: 'STOP'; readonly arguments: unknown; readonly source: ControlSource }
  /** A job tool: the runner reads, lists or stops the task's background commands. */
  | {
      readonly kind: 'JOB';
      readonly action: JobAction;
      readonly arguments: unknown;
      readonly source: ControlSource;
    }
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
  /**
   * Control calls that came with other tool calls and do not end the round (`send_message`,
   * `view_tasks`, the job tools): the runner answers each, and the round goes on when they and the
   * Units of the round have all come back.
   */
  readonly controls?: readonly AgentEnding[];
  /** The todo progress for the interface, once the records are durable (WorkflowKernel 2.5). */
  readonly activity?: UpdateActivityRequest['todos'];
}

/** The facts context-assemble needs that the log, not this machine, supplies. */
export interface AgentContext {
  readonly assembleInput: (
    status: ContextAssembleInput['status'],
    final: boolean,
    withdrawnTools: readonly string[],
  ) => ContextAssembleInput;
  /** The first prompt of the run: no event or log record carries its text. */
  readonly objectiveRef: ArtifactRef;
  /**
   * What the log adds to a tool's arguments and the model cannot give. Undefined leaves them as
   * they are, and a refusal is a tool result for the model.
   */
  readonly toolInput?: (
    kind: ExecutionKind,
    args: unknown,
    notYetInLog?: readonly NewLogRecord[],
  ) => ToolInput;
  /**
   * Why this reply is refused because requests read before are still not answered in it
   * (Orchestration 5.3); `answered` are the ids its `send_message` replies name.
   */
  readonly owedReplies?: (agentRunId: string, answered: ReadonlySet<string>) => string | undefined;
}

export type ToolInput =
  | {
      readonly ok: true;
      readonly input: UnitInput;
      readonly workflowFields?: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Kinds that change the workspace: what was read before them is no longer what is there. A
 * command may change it as well, but it names no path, so it only clears the "already read" memory.
 */
const WRITES: ReadonlySet<ExecutionKind> = new Set(WRITE_KINDS);
/** Core's refusals of the call itself: never the Unit's failurePolicy, and never fatal. */
const CORE_REFUSALS: ReadonlySet<string> = new Set([
  'CAPABILITY_NOT_GRANTED',
  'ADMISSION_CHECK_FAILED',
  'ARTIFACT_EXPIRED',
  // A write into what the task lent to a subtask (Orchestration 8.2): it writes elsewhere.
  'WRITE_SCOPE_DELEGATED',
]);

const NORMAL_BUDGET: BudgetView = { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' };
const FEEDBACK = {
  NO_ACTION:
    'Your message contained no tool call, so nothing in it was shown to anyone or used: text outside a tool call is discarded.',
  OUTPUT_TRUNCATED: 'Your reply was cut off before a complete tool call. Send a shorter one.',
  CONTROL_MIXED:
    'Not executed: a call that must be alone (finishing, starting tasks, waiting) came with other calls; none of them ran.',
  CONTROL_NOT_ALLOWED: 'That control tool is not available at this point.',
  CONTROL_ARGUMENTS_INVALID: 'The arguments of the finishing call do not match its parameters.',
  UNKNOWN_TOOL: 'Not executed: no such tool is available to you.',
  REPLY_OWED:
    'Not executed: a request you read before is still not answered; answer it with send_message kind reply.',
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

/**
 * What the model is told to do next, where it did not call anything it can use: the Agent's own
 * end tools are named, since only a call of one of them reaches the reader (the user reads
 * `reply`, nothing else), and writing an answer as plain text delivers nothing.
 */
function nextStep(state: AgentState, code: FeedbackCode): string {
  if (code !== 'NO_ACTION' && code !== 'UNKNOWN_TOOL') return '';
  const ends = state.definitions.endTools.map((tool) => tool.toolName).join(' or ');
  const finish = ends.length === 0 ? 'the finishing tool' : ends;
  return code === 'NO_ACTION'
    ? ` If that was your answer, send the same answer again inside a call of ${finish}; to keep working, call a tool.`
    : ` Call one of the tools you have, or finish with a call of ${finish}.`;
}

const withdrawnOf = (state: AgentState): readonly string[] =>
  state.spawnWithdrawn && state.definitions.spawnTool !== undefined
    ? [state.definitions.spawnTool.toolName]
    : [];

/**
 * Why a call's arguments were refused, so the model corrects them instead of guessing. `lead` is
 * what the refusal says first: that the call did not run, or that it was not taken.
 */
function invalidArgumentsText(
  lead: string,
  checked: ReturnType<typeof validate> | undefined,
  notJson: boolean,
): string {
  if (notJson) return `${lead}: they are not valid JSON.`;
  if (checked === undefined || checked.ok) return `${lead}.`;
  const text = `${lead}: ${checked.issues.slice(0, 3).join('; ')}`;
  return text.length <= 600 ? text : `${text.slice(0, 599)}…`;
}

const NOT_EXECUTED = 'Not executed: the arguments do not match the tool parameters';
const NOT_TAKEN = 'The arguments of the call do not match its parameters';

const base = (state: AgentState) => ({ workflowRunId: state.workflowRunId });

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
      message ??
      (code === 'TOOL_REJECTED' || code === 'TODOS_UPDATED'
        ? ''
        : `${FEEDBACK[code]}${nextStep(state, code)}`),
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
  state: { ...state, pending: new Map(), held: [] },
  records,
  submissions: [],
  ending,
});

function degrade(
  state: AgentState,
  reason: Extract<AgentEnding, { kind: 'DEGRADED' }>['reason'],
  records: readonly NewLogRecord[],
  unfinished?: { readonly source: ControlSource; readonly why: string },
): AgentTransition {
  return ended(
    state,
    { kind: 'DEGRADED', reason, ...(unfinished === undefined ? {} : { unfinished }) },
    records,
  );
}

/**
 * The finishing call of a last round that was refused, so that what it said is not lost: it is in
 * the model output the round's MODEL_TURN record points at.
 */
function unfinishedOf(
  state: AgentState,
  calls: readonly ModelToolCall[],
  records: readonly NewLogRecord[],
  why: string,
): { readonly source: ControlSource; readonly why: string } | undefined {
  const call = calls.find((each) =>
    state.definitions.endTools.some((tool) => tool.toolName === each.toolName),
  );
  const turn = [...records].reverse().find((record) => record.type === 'MODEL_TURN');
  if (call === undefined || turn?.type !== 'MODEL_TURN') return undefined;
  return {
    source: {
      modelTurnRequestId: turn.requestId,
      modelOutputRef: turn.outputRef,
      toolCallId: call.toolCallId,
    },
    why,
  };
}

function nextRound(
  state: AgentState,
  context: AgentContext,
  records: readonly NewLogRecord[] = [],
): AgentTransition {
  const exhausted = state.budget.agentRun === 'EXHAUSTED' || state.budget.input === 'EXHAUSTED';
  if (exhausted) return degrade(state, 'BUDGET_EXHAUSTED', records);
  // `maxRounds` counts the final round too: the round after `maxRounds - 1` is the final call, so a
  // model never gets more calls than the limit says. One working round is always left.
  const atLimit = state.round >= Math.max(state.definitions.limits.maxRounds - 1, 1);
  const wrapUpReason = state.wrapUpReason ?? (atLimit ? 'ROUND_LIMIT' : undefined);
  const final = wrapUpReason !== undefined;
  if (final && state.finalUsed) return degrade(state, wrapUpReason, records);
  const next: AgentState = {
    ...state,
    round: state.round + 1,
    final,
    finalUsed: state.finalUsed || final,
    roundHadOk: false,
    roundErrored: false,
    ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
  };
  const status: ContextAssembleInput['status'] = {
    round: next.round,
    maxRounds: next.definitions.limits.maxRounds,
    budget: next.budget,
    final,
    ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
  };
  const wrapUpRecords: readonly NewLogRecord[] =
    wrapUpReason === undefined
      ? []
      : [
          {
            ...base(next),
            type: 'AGENT_WRAP_UP',
            agentRunId: next.agentRunId,
            reason: wrapUpReason,
            round: next.round,
          },
        ];
  return one(
    next,
    'CONTEXT',
    next.definitions.contextAssemble,
    context.assembleInput(status, final, withdrawnOf(next)),
    'context',
    [...records, ...wrapUpRecords],
  );
}

export function startAgent(
  input: Pick<
    AgentState,
    'workflowRunId' | 'sessionId' | 'agentRunId' | 'definitions' | 'orientPackRef'
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
    deferred: [],
    declinedTools: [],
    invalidSpawns: 0,
    spawnWithdrawn: false,
    held: [],
    intents: [],
    consecutiveErrors: 0,
    noProgress: 0,
    regenerations: 0,
    overflows: 0,
    roundHadOk: false,
    roundErrored: false,
    todoOnlyRounds: 0,
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
  const wrapping = report.budget.agentRun !== 'NORMAL' || report.budget.input !== 'NORMAL';
  return wrapping ? wrapUp(next, 'BUDGET_WRAP_UP') : next;
}

const handlingOf = (unit: AgentUnit, code: string): FailureHandling =>
  unit.failurePolicy[code] ?? 'FATAL';

/**
 * The same round's context is assembled again (Module/Workflow 8.4): Kernel compacted
 * what the last assembly was made of, or the model was refused for its size. No round is spent,
 * and nothing is counted as an error: it is not the model's doing.
 */
function reassemble(
  state: AgentState,
  context: AgentContext,
  records: readonly NewLogRecord[],
): AgentTransition {
  const status: ContextAssembleInput['status'] = {
    round: state.round,
    maxRounds: state.definitions.limits.maxRounds,
    budget: state.budget,
    final: state.final,
    ...(state.wrapUpReason === undefined ? {} : { wrapUpReason: state.wrapUpReason }),
  };
  return one(
    state,
    'CONTEXT',
    state.definitions.contextAssemble,
    context.assembleInput(status, state.final, withdrawnOf(state)),
    'context',
    records,
  );
}

/**
 * The model was refused this many times in a row for the size: the compaction cannot help. Kernel
 * compacts after each of the first three (`KernelConfig.compaction.overflowTargets`), so the
 * fourth refusal is the one that ends the round's work.
 */
const OVERFLOW_LIMIT = 4;

function failed(
  state: AgentState,
  pending: Exclude<Pending, { readonly role: 'DELEGATED' }>,
  code: ReasonCode,
  context: AgentContext,
  records: readonly NewLogRecord[] = [],
): AgentTransition {
  if (code === 'CONTEXT_COMPACTED' && pending.role === 'CONTEXT')
    return reassemble(state, context, records);
  if (code === 'CONTEXT_OVERFLOW' && pending.role === 'MODEL') {
    const overflows = state.overflows + 1;
    if (overflows < OVERFLOW_LIMIT) return reassemble({ ...state, overflows }, context, records);
    return state.final
      ? degrade({ ...state, overflows }, 'CONTEXT_LIMIT', records)
      : nextRound(wrapUp({ ...state, overflows: 0 }, 'CONTEXT_LIMIT'), context, records);
  }
  if (code === 'LIMIT_EXCEEDED' && (pending.role === 'CONTEXT' || pending.role === 'MODEL'))
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
    ...(report.usage === undefined ? {} : { usage: report.usage }),
  };
}

function afterTools(
  state: AgentState,
  context: AgentContext,
  config: AgentConfig,
  records: readonly NewLogRecord[],
  /** False when the round is not judged by progress, such as a refused run_subagents. */
  judged = true,
): AgentTransition {
  const noProgress = !judged ? state.noProgress : state.roundHadOk ? 0 : state.noProgress + 1;
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
  /** What is wrong, when the model can act on it; otherwise the fixed text of the code. */
  detail?: string,
): AgentTransition {
  // Every call gets its answer here, also when the AgentRun ends: the history must stay valid.
  const notes =
    calls.length === 0
      ? [feedback(state, code)]
      : calls.map((call) => feedback(state, code, call.toolCallId, detail));
  if (state.final)
    return degrade(
      state,
      'FINAL_CALL_INVALID',
      [...records, ...notes],
      unfinishedOf(state, calls, records, detail ?? code),
    );
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
  let refusedTodos = false;
  if (todoTool !== undefined)
    for (const call of calls.filter(isTodo)) {
      const args =
        call.arguments === null ? undefined : validate(todoTool.parameters, call.arguments);
      if (args === undefined || !args.ok) {
        records.push(
          feedback(
            state,
            'INVALID_ARGUMENTS',
            call.toolCallId,
            invalidArgumentsText(NOT_EXECUTED, args, call.arguments === null),
          ),
        );
        refusedTodos = true;
        continue;
      }
      const { todos } = call.arguments as unknown as UpdateTodosArgs;
      const countOf = (status: UpdateTodosArgs['todos'][number]['status']) =>
        todos.filter((todo) => todo.status === status).length;
      const counts = {
        total: todos.length,
        pending: countOf('pending'),
        inProgress: countOf('in_progress'),
        completed: countOf('completed'),
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
          `Todos: ${String(counts.total)} items, ${String(counts.completed)} completed, ${String(counts.inProgress)} in progress.`,
        ),
      );
      const current = todos.find((todo) => todo.status === 'in_progress')?.content.slice(0, 80);
      activity = {
        total: counts.total,
        completed: counts.completed,
        ...(current === undefined ? {} : { current }),
      };
    }
  const acting = calls.filter((call) => !isTodo(call));
  // Writing the plan first is fair: a round of only todos is not judged by progress, but a second
  // one in a row is (M2Design 3.5).
  const todoOnlyRounds = acting.length === 0 ? state.todoOnlyRounds + 1 : 0;
  const transition =
    acting.length === 0
      ? afterTools(
          { ...state, todoOnlyRounds },
          context,
          config,
          records,
          todoOnlyRounds > 1 && !refusedTodos,
        )
      : actOn({ ...state, todoOnlyRounds }, report, acting, context, config, records);
  return activity === undefined ? transition : { ...transition, activity };
}

/**
 * A control call that must come alone: it ends the AgentRun, or suspends it until its tasks have
 * ended (M2Design 3.5). Both are checked the same way; only the parameters, the final call and
 * what follows differ.
 */
interface SoleControl {
  readonly call: ModelToolCall;
  readonly parameters: Schema;
  readonly allowedInFinal: boolean;
  readonly ending: (source: ControlSource) => AgentEnding;
  /** Answered at once without ending the round: it may come with other tool calls. */
  readonly inline?: boolean;
}

function soleControlOf(
  state: AgentState,
  calls: readonly ModelToolCall[],
): SoleControl | undefined {
  const spawn = state.spawnWithdrawn ? undefined : state.definitions.spawnTool;
  for (const call of calls) {
    const tool = state.definitions.endTools.find((each) => each.toolName === call.toolName);
    if (tool !== undefined)
      return {
        call,
        parameters: tool.parameters,
        allowedInFinal: tool.allowedInFinal,
        ending: (source) => ({ kind: 'ENDED', tool, arguments: call.arguments, source }),
      };
    if (spawn !== undefined && call.toolName === spawn.toolName)
      return {
        call,
        parameters: spawn.parameters,
        allowedInFinal: false,
        ending: (source) => ({ kind: 'SPAWN', arguments: call.arguments, source }),
      };
    const subMission = state.spawnWithdrawn ? undefined : state.definitions.subMissionTool;
    if (subMission !== undefined && call.toolName === subMission.toolName)
      return {
        call,
        parameters: subMission.parameters,
        allowedInFinal: false,
        ending: (source) => ({
          kind: 'SPAWN',
          arguments: call.arguments,
          source,
          submission: true,
        }),
      };
    const ask = state.definitions.askTool;
    if (ask !== undefined && call.toolName === ask.toolName)
      return {
        call,
        parameters: ask.parameters,
        allowedInFinal: false,
        ending: (source) => ({ kind: 'ASK', arguments: call.arguments, source }),
      };
    const sleep = state.definitions.sleepTool;
    if (sleep !== undefined && call.toolName === sleep.toolName)
      return {
        call,
        parameters: sleep.parameters,
        allowedInFinal: false,
        ending: (source) => ({ kind: 'SLEEP', arguments: call.arguments, source }),
      };
    const message = state.definitions.messageTool;
    if (message !== undefined && call.toolName === message.toolName)
      return {
        call,
        parameters: message.parameters,
        allowedInFinal: false,
        ending: (source) => ({ kind: 'MESSAGE', arguments: call.arguments, source }),
        inline: true,
      };
    const view = state.definitions.viewTasksTool;
    if (view !== undefined && call.toolName === view.toolName)
      return {
        call,
        parameters: view.parameters,
        allowedInFinal: false,
        ending: (source) => ({ kind: 'VIEW_TASKS', arguments: call.arguments, source }),
        inline: true,
      };
    const stop = state.definitions.stopTool;
    if (stop !== undefined && call.toolName === stop.toolName)
      return {
        call,
        parameters: stop.parameters,
        allowedInFinal: false,
        ending: (source) => ({ kind: 'STOP', arguments: call.arguments, source }),
      };
    const job = state.definitions.jobTools?.find((each) => each.toolName === call.toolName);
    if (job !== undefined)
      return {
        call,
        parameters: job.parameters,
        allowedInFinal: false,
        ending: (source) => ({
          kind: 'JOB',
          action: job.action,
          arguments: call.arguments,
          source,
        }),
        inline: true,
      };
  }
  return undefined;
}

/** The refusal for requests still not answered, unless this reply answers them (or is the last). */
function repliesOwed(
  state: AgentState,
  calls: readonly ModelToolCall[],
  context: AgentContext,
): string | undefined {
  const message = state.definitions.messageTool;
  if (state.final || message === undefined || context.owedReplies === undefined) return undefined;
  const answered = new Set(
    calls.flatMap((call) => {
      if (call.toolName !== message.toolName) return [];
      const args = call.arguments as { readonly kind?: unknown; readonly replyTo?: unknown } | null;
      return args?.kind === 'reply' && typeof args.replyTo === 'string' ? [args.replyTo] : [];
    }),
  );
  return context.owedReplies(state.agentRunId, answered);
}

/**
 * A call that must be alone came with others: it is named, and so is what happened to the
 * others, because a model that thinks a part of its reply ran goes on as if it had (a message
 * thought sent was never sent again).
 */
function mixedText(sole: ModelToolCall, calls: readonly ModelToolCall[]): string {
  const others = calls.filter((each) => each !== sole).map((each) => each.toolName);
  return `Not executed: ${sole.toolName} must be the only tool call in its reply, and this reply also had ${others.join(', ')}. None of the ${String(calls.length)} calls of this reply ran, ${sole.toolName} included: send ${sole.toolName} on its own, then the others again.`;
}

/** Why a sole control call is not taken, if it is not: with the reason the model can act on. */
function soleRefusal(
  state: AgentState,
  calls: readonly ModelToolCall[],
  { call, parameters, allowedInFinal }: SoleControl,
): { readonly code: FeedbackCode; readonly detail?: string } | undefined {
  if (calls.length > 1) return { code: 'CONTROL_MIXED', detail: mixedText(call, calls) };
  if (state.final && !allowedInFinal) return { code: 'CONTROL_NOT_ALLOWED' };
  const checked = call.arguments === null ? undefined : validate(parameters, call.arguments);
  if (checked !== undefined && checked.ok) return undefined;
  return {
    code: 'CONTROL_ARGUMENTS_INVALID',
    detail: invalidArgumentsText(NOT_TAKEN, checked, call.arguments === null),
  };
}

function actOn(
  state: AgentState,
  report: Extract<UnitReport, { status: 'OK' }>,
  calls: readonly ModelToolCall[],
  context: AgentContext,
  config: AgentConfig,
  records: NewLogRecord[],
): AgentTransition {
  // A request read in an earlier round and still not answered: the reply is refused as a whole.
  const owed = repliesOwed(state, calls, context);
  if (owed !== undefined)
    return invalidReply(state, 'REPLY_OWED', calls, context, config, records, owed);
  // A call that ends the round, starts tasks or waits must be alone; one that is answered at once
  // (a message, the task tree, a job) may come with ordinary tool calls (Orchestration 5.3).
  const controls = calls.flatMap((call) => soleControlOf(state, [call]) ?? []);
  const sole =
    controls.find((control) => control.inline !== true) ??
    (calls.length === 1 ? controls[0] : undefined);
  if (sole !== undefined) {
    const refusal = soleRefusal(state, calls, sole);
    if (refusal !== undefined)
      return invalidReply(state, refusal.code, calls, context, config, records, refusal.detail);
    if (report.outputRef === undefined) throw new Error('A model report has no output reference');
    const ending = sole.ending({
      modelTurnRequestId: report.requestId,
      modelOutputRef: report.outputRef,
      toolCallId: sole.call.toolCallId,
    });
    const transition = ended(state, ending, records);
    // A delegated call is pending until the graph answers it; any other control call ends the run.
    return ending.kind === 'SPAWN' ||
      ending.kind === 'ASK' ||
      ending.kind === 'MESSAGE' ||
      ending.kind === 'VIEW_TASKS' ||
      ending.kind === 'STOP' ||
      ending.kind === 'JOB'
      ? {
          ...transition,
          state: {
            ...transition.state,
            pending: new Map([[sole.call.toolCallId, { role: 'DELEGATED' } as const]]),
          },
        }
      : transition;
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
  const writtenPaths = new Set<string>();
  let accepted = 0;
  const inline = new Set(controls.map((control) => control.call.toolCallId));
  const answered: AgentEnding[] = [];
  for (const control of controls) {
    const checked =
      control.call.arguments === null
        ? undefined
        : validate(control.parameters, control.call.arguments);
    if (checked === undefined || !checked.ok) {
      records.push(
        feedback(
          state,
          'CONTROL_ARGUMENTS_INVALID',
          control.call.toolCallId,
          invalidArgumentsText(NOT_TAKEN, checked, control.call.arguments === null),
        ),
      );
      continue;
    }
    if (report.outputRef === undefined) throw new Error('A model report has no output reference');
    pending.set(control.call.toolCallId, { role: 'DELEGATED' });
    answered.push(
      control.ending({
        modelTurnRequestId: report.requestId,
        modelOutputRef: report.outputRef,
        toolCallId: control.call.toolCallId,
      }),
    );
  }
  for (const call of calls) {
    if (inline.has(call.toolCallId)) continue;
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
    const checked = call.arguments === null ? undefined : validate(tool.parameters, call.arguments);
    if (checked === undefined || !checked.ok) {
      records.push(
        feedback(
          state,
          'INVALID_ARGUMENTS',
          call.toolCallId,
          invalidArgumentsText(NOT_EXECUTED, checked, call.arguments === null),
        ),
      );
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
    const planned = { tool, call, intent, modelTurnRequestId: report.requestId };
    if (WRITES.has(tool.executionKind)) {
      const path = writePathOf(call);
      if (writtenPaths.has(path)) {
        next = { ...next, deferred: [...next.deferred, planned] };
        continue;
      }
      writtenPaths.add(path);
    }
    const started = startTool(next, planned, context, records);
    next = started.state;
    if (started.pending === undefined) continue;
    pending.set(started.pending[0], started.pending[1]);
    submissions.push(started.pending[2]);
  }
  next = { ...next, pending };
  // The control calls are answered by the runner; the round waits for them like for its Units.
  if (answered.length > 0) return { state: next, records, submissions, controls: answered };
  if (submissions.length === 0) {
    const released = releaseDeferred(next, context, records);
    if (released.submissions.length > 0) return { ...released, records };
    return afterTools(released.state, context, config, records);
  }
  return { state: next, records, submissions };
}

const writePathOf = (call: ModelToolCall): string => {
  const { path } = call.arguments as { readonly path: string };
  return normalizeRequestPath(path) ?? path;
};

/** Makes the Unit of a tool call, or answers the call when the log says it cannot run. */
function startTool(
  state: AgentState,
  planned: DeferredWrite,
  context: AgentContext,
  records: NewLogRecord[],
): {
  readonly state: AgentState;
  readonly pending?: readonly [string, Pending, SubmitUnitRequest];
} {
  const { tool, call, intent, modelTurnRequestId } = planned;
  const completed: ToolInput = context.toolInput?.(tool.executionKind, call.arguments, records) ?? {
    ok: true,
    input: call.arguments as UnitInput,
  };
  if (!completed.ok) {
    records.push(feedback(state, 'TOOL_INPUT_REFUSED', call.toolCallId, completed.message));
    return { state };
  }
  const made = submission(state, tool.unit, completed.input, {
    toolName: tool.modelName,
    argsSummary: '',
  });
  records.push({
    ...(made.record as Extract<NewLogRecord, { type: 'UNIT_SUBMITTED' }>),
    inputSource: {
      kind: 'TOOL_CALL',
      modelTurnRequestId,
      toolCallId: call.toolCallId,
      ...(completed.workflowFields === undefined
        ? {}
        : { workflowFields: { ...completed.workflowFields } }),
    },
  });
  return {
    state: made.state,
    pending: [
      made.request.requestId,
      { role: 'TOOL', unit: tool.unit, call, intent, modelTurnRequestId },
      made.request,
    ],
  };
}

/** The next deferred write that can run; every call still gets its one answer. */
function releaseDeferred(
  state: AgentState,
  context: AgentContext,
  records: NewLogRecord[],
): { readonly state: AgentState; readonly submissions: readonly SubmitUnitRequest[] } {
  let next = state;
  while (next.deferred.length > 0) {
    const [planned, ...rest] = next.deferred;
    if (planned === undefined) break;
    next = { ...next, deferred: rest };
    if (next.fatal !== undefined || next.wrapUpReason !== undefined) {
      records.push(feedback(next, 'NOT_EXECUTED', planned.call.toolCallId));
      continue;
    }
    if (next.declinedTools.includes(planned.tool.modelName)) {
      const text = rejectedText(planned.tool.modelName);
      records.push(feedback(next, 'TOOL_REJECTED', planned.call.toolCallId, text));
      continue;
    }
    const started = startTool(next, planned, context, records);
    next = started.state;
    if (started.pending === undefined) continue;
    const [requestId, pending, request] = started.pending;
    return {
      state: { ...next, pending: new Map([...next.pending, [requestId, pending]]) },
      submissions: [request],
    };
  }
  return { state: next, submissions: [] };
}

/** A report that says how the Unit went; an interruption is handled apart. */
type OutcomeReport = Exclude<UnitReport, { status: 'INTERRUPTED' }>;

function handleTool(
  state: AgentState,
  pending: Extract<Pending, { role: 'TOOL' }>,
  report: OutcomeReport,
  context: AgentContext,
  config: AgentConfig,
): AgentTransition {
  const records: NewLogRecord[] = [completion(state, report)];
  const ok = report.status === 'OK';
  const declined = report.status === 'REJECTED' && report.reasonCode === 'USER_DECLINED';
  // A failed read outside the workspace is not counted either: two of them in a row pause the run
  // for the user, who decides whether the Agent was right to try (Kernel/Core 5h).
  const external = !ok && pending.unit.external === true;
  // A refusal is the user's decision, not a mistake of the model. The failures of one batch are one
  // mistake: ten writes sent together and refused together do not wrap the run up.
  const counted = !ok && !declined && !external && !state.roundErrored;
  const consecutiveErrors = ok
    ? 0
    : counted
      ? state.consecutiveErrors + 1
      : state.consecutiveErrors;
  let next: AgentState = {
    ...state,
    consecutiveErrors,
    roundErrored: state.roundErrored || counted,
    roundHadOk: state.roundHadOk || ok || external,
    // After a write nothing read before it may be answered with "the result is above".
    succeeded: !ok
      ? state.succeeded
      : WRITES.has(report.executionKind) || report.executionKind === 'COMMAND'
        ? []
        : [...state.succeeded, pending.intent],
  };
  if (consecutiveErrors >= config.consecutiveErrorLimit) next = wrapUp(next, 'CONSECUTIVE_ERRORS');
  // Kernel's refusals have fixed meanings, not the Unit's failurePolicy (Module/Workflow 7): a quota
  // names the wrap-up, and a declined authorization is a tool result the model reads.
  if (report.status === 'REJECTED' && report.reasonCode === 'QUOTA_EXHAUSTED') {
    next = wrapUp(
      next,
      report.quota === 'TOOL_UNITS'
        ? 'TOOL_UNIT_LIMIT'
        : report.quota === 'MEMORY'
          ? 'MEMORY_LIMIT'
          : 'WALL_CLOCK_LIMIT',
    );
  } else if (declined) {
    const { toolName } = pending.call;
    if (!next.declinedTools.includes(toolName))
      next = { ...next, declinedTools: [...next.declinedTools, toolName] };
  } else if (!ok && !CORE_REFUSALS.has(report.reasonCode)) {
    const handling = handlingOf(pending.unit, report.reasonCode);
    if (handling === 'FATAL') next = { ...next, fatal: next.fatal ?? report.reasonCode };
    if (handling === 'FINAL_CALL') next = wrapUp(next, 'BUDGET_WRAP_UP');
  }
  if (next.pending.size === 0 && next.deferred.length > 0) {
    const released = releaseDeferred(next, context, records);
    next = released.state;
    if (released.submissions.length > 0)
      return { state: next, records, submissions: released.submissions };
  }
  // The batch finishes first, so every call of this reply has its result in the log.
  if (next.fatal !== undefined && next.pending.size === 0)
    return ended(next, { kind: 'FAILED', code: next.fatal }, records);
  // A paused batch is not finished: what the pause cancelled is submitted again on resume.
  return next.pending.size === 0 && next.held.length === 0
    ? afterTools(next, context, config, records)
    : { state: next, records, submissions: [] };
}

function assembled(state: AgentState, report: Extract<UnitReport, { status: 'OK' }>): NewLogRecord {
  const { projectionDigest, headDigest, elidedEntries, tokenCount, tokenBudget } =
    report.output as ContextAssembleOutput;
  return {
    ...base(state),
    type: 'CONTEXT_ASSEMBLED',
    requestId: report.requestId,
    projectionDigest,
    headDigest,
    ...(elidedEntries.length === 0 ? {} : { elidedEntries }),
    tokenCount,
    tokenBudget,
  };
}

function completion(state: AgentState, report: OutcomeReport): NewLogRecord {
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
          ...(report.changedFiles === undefined || report.changedFiles.length === 0
            ? {}
            : { changedFiles: report.changedFiles.slice(0, 1000) }),
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
  const { publish } = state.definitions;
  if (publish === undefined) throw new Error('This Agent has no publishing Unit');
  const made = one(state, 'CLOSING', publish, input, 'publish');
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
  if (pending === undefined || pending.role === 'DELEGATED')
    return { state: current, records: [], submissions: [] };
  const remaining = new Map(current.pending);
  remaining.delete(report.requestId);
  const state = applyBudget({ ...current, pending: remaining }, report);
  if (report.status === 'INTERRUPTED')
    return handleInterrupted(state, pending, report, context, config);
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
      return handleModel({ ...state, overflows: 0 }, report, context, config);
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

const WRITE_AND_EXEC: ReadonlySet<ExecutionKind> = new Set([...WRITE_KINDS, 'COMMAND']);

/**
 * A Unit that was cancelled by a pause or an abort (M2Design 4.4, 4.5). No Round is spent, no
 * attempt failed, and nothing enters the history but the answer a tool call must have:
 *  - paused: a read, a model call and the assembly of its context are submitted again on resume;
 *    a command or a write is not (it may have gone half way), so the model reads that it was
 *    interrupted and decides;
 *  - aborted: nothing is submitted again, every call just gets its answer.
 */
function handleInterrupted(
  state: AgentState,
  pending: Exclude<Pending, { readonly role: 'DELEGATED' }>,
  report: Extract<UnitReport, { status: 'INTERRUPTED' }>,
  context: AgentContext,
  config: AgentConfig,
): AgentTransition {
  const records: NewLogRecord[] = [
    {
      ...base(state),
      type: 'UNIT_INTERRUPTED',
      requestId: report.requestId,
      reason: report.interruptedBy,
    },
  ];
  let next = state;
  if (pending.role === 'TOOL') {
    const { call } = pending;
    const paused = report.interruptedBy === 'PAUSED';
    if (paused && !WRITE_AND_EXEC.has(report.executionKind)) {
      const tool = state.definitions.tools.find((each) => each.modelName === call.toolName);
      if (tool !== undefined)
        next = {
          ...next,
          held: [
            ...next.held,
            {
              kind: 'TOOL',
              planned: {
                tool,
                call,
                intent: pending.intent,
                modelTurnRequestId: pending.modelTurnRequestId,
              },
            },
          ],
        };
    } else {
      records.push(
        answerRecord(
          state,
          'UNIT_INTERRUPTED',
          call.toolCallId,
          paused
            ? 'Interrupted by a pause: the command may not have finished. Run it again if you still need it.'
            : 'Interrupted: this call was stopped before it finished (the run was stopped, or this task was stopped or interrupted).',
        ),
      );
    }
  } else if (report.interruptedBy === 'PAUSED') {
    next = {
      ...next,
      held: [...next.held, { kind: pending.role === 'ORIENT' ? 'ORIENT' : 'ASSEMBLE' }],
    };
  }
  // After an abort nothing goes on here: Workflow ends the AgentRun with what it has.
  if (report.interruptedBy === 'ABORTED' || next.pending.size > 0 || next.held.length > 0)
    return { state: next, records, submissions: [] };
  return afterTools(next, context, config, records);
}

/**
 * The run was continued: what the pause cancelled is submitted again, and a model call or its
 * context assembly is made again from the log as it is now, so a note added meanwhile is in it.
 */
export function resumeAfterPause(
  state: AgentState,
  context: AgentContext,
  config: AgentConfig,
): AgentTransition {
  if (state.held.length === 0) return { state, records: [], submissions: [] };
  const records: NewLogRecord[] = [];
  let next: AgentState = { ...state, held: [] };
  const restart = state.held.find((held) => held.kind !== 'TOOL');
  if (restart?.kind === 'ORIENT' && next.definitions.orient !== undefined)
    return one(
      next,
      'ORIENT',
      next.definitions.orient,
      { objectiveRef: context.objectiveRef },
      'repository_orient',
    );
  if (restart?.kind === 'ASSEMBLE') {
    const status: ContextAssembleInput['status'] = {
      round: next.round,
      maxRounds: next.definitions.limits.maxRounds,
      budget: next.budget,
      final: next.final,
      ...(next.wrapUpReason === undefined ? {} : { wrapUpReason: next.wrapUpReason }),
    };
    return one(
      next,
      'CONTEXT',
      next.definitions.contextAssemble,
      context.assembleInput(status, next.final, withdrawnOf(next)),
      'context',
    );
  }
  const pending = new Map(next.pending);
  const submissions: SubmitUnitRequest[] = [];
  for (const held of state.held) {
    if (held.kind !== 'TOOL') continue;
    const started = startTool(next, held.planned, context, records);
    next = started.state;
    if (started.pending === undefined) continue;
    pending.set(started.pending[0], started.pending[1]);
    submissions.push(started.pending[2]);
  }
  next = { ...next, pending };
  if (submissions.length === 0 && next.pending.size === 0)
    return afterTools(next, context, config, records);
  return { state: next, records, submissions };
}

/** An answer to a call that is not a Unit: the model reads it as the result of the call. */
export function answerRecord(
  state: AgentState,
  code: string,
  toolCallId: string,
  message: string,
): NewLogRecord {
  return {
    ...base(state),
    type: 'FEEDBACK',
    agentRunId: state.agentRunId,
    code,
    message,
    toolCallId,
  };
}

/** The AgentRun goes on after a finishing call was sent back: that is no progress (M2Design 3.7). */
export function resumeAfterRefusal(
  state: AgentState,
  records: readonly NewLogRecord[],
  context: AgentContext,
  config: AgentConfig,
): AgentTransition {
  return afterTools({ ...state, roundHadOk: false, roundErrored: false }, context, config, records);
}

/**
 * A call the task graph answers has its answer: it was refused (`refused`), or what it dispatched
 * has ended and the graph says so. The round goes on as it does when any other call comes back. A
 * refused call is no progress; for `run_subagents` two in a row take the tool away (M2Design 3.6).
 */
export function answerDelegatedCall(
  state: AgentState,
  toolCallId: string,
  outcome: {
    readonly refused: boolean;
    /** The call was `run_subagents`, whose refusals are counted; `ask_user` has no such limit. */
    readonly spawn: boolean;
    /** The tool is taken away at once: a limit was reached. */
    readonly withdraw?: boolean;
    readonly records: readonly NewLogRecord[];
  },
  context: AgentContext,
  config: AgentConfig,
): AgentTransition {
  const invalidSpawns = !outcome.spawn
    ? state.invalidSpawns
    : outcome.refused
      ? state.invalidSpawns + 1
      : 0;
  const pending = new Map(state.pending);
  pending.delete(toolCallId);
  let next: AgentState = {
    ...state,
    pending,
    invalidSpawns,
    spawnWithdrawn: state.spawnWithdrawn || invalidSpawns >= 2 || outcome.withdraw === true,
    roundHadOk: state.roundHadOk || !outcome.refused,
  };
  // Other calls of the round (its Units, other control calls) are not all back yet.
  if (next.pending.size > 0 || next.held.length > 0)
    return { state: next, records: outcome.records, submissions: [] };
  if (next.deferred.length > 0) {
    const records = [...outcome.records];
    const released = releaseDeferred(next, context, records);
    if (released.submissions.length > 0)
      return { state: released.state, records, submissions: released.submissions };
    next = released.state;
    if (next.fatal !== undefined) return ended(next, { kind: 'FAILED', code: next.fatal }, records);
    return afterTools(next, context, config, records, !outcome.refused);
  }
  // A Unit of the round failed fatally while this call was still out: the batch is finished now.
  if (next.fatal !== undefined)
    return ended(next, { kind: 'FAILED', code: next.fatal }, outcome.records);
  // A refused call has its own limit (two take the tool away); it does not also end the AgentRun.
  return afterTools(next, context, config, outcome.records, !outcome.refused);
}
