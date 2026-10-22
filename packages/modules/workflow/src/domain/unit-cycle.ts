import { StepRecordSchema, assertValid } from '@multiagentos/contracts';
import type {
  BudgetState,
  ContextAssembleInput,
  HandoffBrief,
  ModelToolCall,
  PinnedDefinitionSet,
  ProtocolRegistry,
  RunFailure,
  SubmitUnitRequest,
  ToolResultStep,
  UnitDefinition,
  UnitInput,
  UnitReport,
  WorkflowConfig,
  WrapUpReason,
} from '@multiagentos/contracts';
import type { AnalysisAction, InvalidActionReason } from './analysis-action.js';
import { interpretModelOutput } from './analysis-action.js';
import type { LastReportIssue } from './degraded-report.js';
import { decideUnitFailure } from './failure-decision.js';
import type { FailureDecision } from './failure-decision.js';
import { recordRegeneration, recordRoundProgress } from './progress.js';
import { applyBudgetFacts, prepareRound, roundsAfterReport } from './rounds.js';
import type { AgentRunState, WorkflowState } from './state.js';
import type { AcceptedToolCall, SuccessfulToolCall } from './validation.js';
import { validateToolCalls } from './validation.js';

interface PendingUnit {
  readonly request: SubmitUnitRequest;
  readonly unit: UnitDefinition;
  readonly tool?: AcceptedToolCall;
}

export type CycleDecision =
  | Extract<AnalysisAction, { readonly kind: 'FINISH' | 'HANDOFF' }>
  | { readonly kind: 'FAILED'; readonly failure: RunFailure }
  | {
      readonly kind: 'DEGRADED_REPORT';
      readonly reason: WrapUpReason;
      readonly lastIssue?: LastReportIssue;
    };

export interface UnitCycleState {
  readonly run: AgentRunState;
  readonly phase: 'STARTUP' | 'CONTEXT' | 'MODEL' | 'TOOLS' | 'DECIDED';
  readonly startupIndex: number;
  readonly budgetState: BudgetState;
  readonly finalCallUsed: boolean;
  readonly isFinal: boolean;
  readonly pending: ReadonlyMap<string, PendingUnit>;
  readonly successfulCalls: readonly SuccessfulToolCall[];
  readonly reads: WorkflowState['reads'];
  readonly snapshotId?: string;
  readonly hasNewOk: boolean;
  readonly failures: readonly FailureDecision[];
  readonly decision?: CycleDecision;
}

export interface CycleEnvironment {
  readonly workflowRunId: string;
  readonly goal: string;
  /** Preallocated outside this pure state machine, in the order of submissions. */
  readonly requestIds: readonly string[];
  readonly registry: ProtocolRegistry;
  readonly config: WorkflowConfig;
  readonly pinnedSets: readonly PinnedDefinitionSet[];
  readonly handoff?: HandoffBrief;
  readonly reads?: WorkflowState['reads'];
  readonly snapshotId?: string;
}

export interface CycleTransition {
  readonly state: UnitCycleState;
  readonly submissions: readonly SubmitUnitRequest[];
}

/** Model-facing guidance: what was wrong and what to send instead. */
const INVALID_ACTION_MESSAGES: Readonly<Record<InvalidActionReason, string>> = {
  NO_ACTION:
    'Your reply contained no tool call. Call a tool to continue, or call the finish tool to submit the report.',
  OUTPUT_TRUNCATED:
    'Your reply was cut off before a complete tool call. Send a shorter reply with one complete tool call.',
  CONTROL_MIXED:
    'A finish or handoff call must be the only tool call in a reply. Send it again on its own.',
  CONTROL_NOT_ALLOWED:
    'That control tool is not available to you at this point. Use your own tools or the finish tool.',
  CONTROL_ARGUMENTS_INVALID:
    'The arguments of the finish or handoff call do not match its parameters. Fix them and call it again.',
};

function modelCallFailedMessage(code: string): string {
  return `The previous model call failed (${code}). Continue from the history above.`;
}

function decide(state: UnitCycleState, decision: CycleDecision): CycleTransition {
  return { state: { ...state, phase: 'DECIDED', decision }, submissions: [] };
}

function degrade(state: UnitCycleState, lastIssue?: LastReportIssue): CycleTransition {
  return decide(state, {
    kind: 'DEGRADED_REPORT',
    reason: 'BUDGET_EXHAUSTED',
    ...(lastIssue === undefined ? {} : { lastIssue }),
  });
}

function unitOf(state: UnitCycleState, kind: UnitDefinition['executionKind']): UnitDefinition {
  const units = state.run.definitions.units.filter((unit) => unit.executionKind === kind);
  if (units.length !== 1) throw new Error(`Expected exactly one pinned Unit of kind ${kind}`);
  const unit = units[0];
  if (unit === undefined) throw new Error('Missing pinned Unit');
  return unit;
}

const BUDGET_ORDER: Readonly<Record<BudgetState, number>> = {
  NORMAL: 0,
  WRAP_UP: 1,
  EXHAUSTED: 2,
};

function submit(
  state: UnitCycleState,
  phase: UnitCycleState['phase'],
  calls: readonly {
    readonly unit: UnitDefinition;
    readonly input: UnitInput;
    readonly tool?: AcceptedToolCall;
  }[],
  environment: CycleEnvironment,
): CycleTransition {
  if (state.pending.size !== 0) throw new Error('Cannot submit while Units are still pending');
  const pending = new Map<string, PendingUnit>();
  const submissions = calls.map((call, index): SubmitUnitRequest => {
    const requestId = environment.requestIds[index];
    if (requestId === undefined || pending.has(requestId))
      throw new Error('Submission IDs must be preallocated and distinct');
    const { id, version, digest } = call.unit;
    const request: SubmitUnitRequest = {
      requestId,
      workflowRunId: environment.workflowRunId,
      agentRunId: state.run.agentRunId,
      unitRef: { kind: 'UNIT', id, version, digest },
      input: call.input,
    };
    pending.set(requestId, {
      request,
      unit: call.unit,
      ...(call.tool === undefined ? {} : { tool: call.tool }),
    });
    return request;
  });
  return {
    state: {
      ...state,
      phase,
      pending,
      run: { ...state.run, pendingRequestIds: new Set(pending.keys()) },
    },
    submissions,
  };
}

function nextRound(state: UnitCycleState, environment: CycleEnvironment): CycleTransition {
  const prepared = prepareRound(state.run, state.budgetState, state.finalCallUsed);
  if (prepared.kind === 'DEGRADED_REPORT') return decide(state, prepared);
  const next = {
    ...state,
    run: prepared.run,
    isFinal: prepared.final,
    finalCallUsed: prepared.finalCallUsed,
    failures: [],
    hasNewOk: false,
  };
  const input: ContextAssembleInput = {
    objective: environment.goal,
    final: next.isFinal,
    steps: [...next.run.steps],
    status: {
      roundsUsed: next.run.roundsUsed,
      maxRounds: next.run.definitions.agent.limits.maxRounds,
      final: next.isFinal,
      budgetState: next.budgetState,
      ...(next.run.wrapUpReason === undefined ? {} : { wrapUpReason: next.run.wrapUpReason }),
    },
    ...(next.run.orientPackRef === undefined ? {} : { orientPackRef: next.run.orientPackRef }),
    ...(environment.handoff === undefined ? {} : { handoff: environment.handoff }),
  };
  return submit(next, 'CONTEXT', [{ unit: unitOf(next, 'CONTEXT_ASSEMBLE'), input }], environment);
}

function nextStartup(state: UnitCycleState, environment: CycleEnvironment): CycleTransition {
  if (state.budgetState === 'EXHAUSTED') return degrade(state);
  const ref = state.run.definitions.agent.startUnitRefs[state.startupIndex];
  if (ref === undefined) return nextRound(state, environment);
  const unit = state.run.definitions.units.find(
    (candidate) => candidate.id === ref.id && candidate.version === ref.version,
  );
  if (unit === undefined || unit.executionKind !== 'REPOSITORY_ORIENT')
    throw new Error('The M1 startup Unit must be a pinned repository-orient');
  return submit(state, 'STARTUP', [{ unit, input: { objective: environment.goal } }], environment);
}

/** Starts the registered AgentRun; pending requests exist before any syscall is executed. */
export function startUnitCycle(
  run: AgentRunState,
  environment: CycleEnvironment,
  budgetState: BudgetState = 'NORMAL',
  finalCallUsed = false,
): CycleTransition {
  return nextStartup(
    {
      run,
      phase: 'STARTUP',
      startupIndex: 0,
      budgetState,
      finalCallUsed,
      isFinal: false,
      pending: new Map(),
      successfulCalls: [],
      reads: environment.reads ?? [],
      ...(environment.snapshotId === undefined ? {} : { snapshotId: environment.snapshotId }),
      hasNewOk: false,
      failures: [],
    },
    environment,
  );
}

function recordToolResult(state: UnitCycleState, pending: PendingUnit, report: UnitReport) {
  if (pending.tool === undefined) throw new Error('A tool report must have a pending tool call');
  const tool = pending.tool;
  const fields = {
    kind: 'TOOL_RESULT',
    round: state.run.roundsUsed,
    requestId: report.requestId,
    toolCallId: tool.call.toolCallId,
    toolName: tool.call.toolName,
    status: report.status,
    ...(report.status === 'OK'
      ? { output: report.output, outputRef: report.outputRef }
      : { reasonCode: report.reasonCode }),
  };
  const step = assertValid<ToolResultStep>(StepRecordSchema, fields);
  return {
    ...state,
    run: { ...state.run, steps: [...state.run.steps, step] },
    hasNewOk: state.hasNewOk || report.status === 'OK',
    successfulCalls:
      report.status === 'OK'
        ? [
            ...state.successfulCalls,
            {
              unitRef: pending.request.unitRef,
              argumentsCanonical: tool.argumentsCanonical,
              requestId: report.requestId,
            },
          ]
        : state.successfulCalls,
  };
}

function applyFailure(
  state: UnitCycleState,
  failure: FailureDecision,
  environment: CycleEnvironment,
): CycleTransition {
  if (failure.kind === 'FAILED') return decide(state, failure);
  if (failure.kind === 'DEGRADED_REPORT')
    return decide(state, {
      kind: failure.kind,
      reason: failure.reason,
      lastIssue: { kind: 'FAILURE', failure: failure.lastFailure },
    });
  const next =
    failure.kind === 'FINAL_CALL' && state.run.wrapUpReason === undefined
      ? { ...state, run: { ...state.run, wrapUpReason: failure.reason } }
      : state;
  return state.phase === 'STARTUP'
    ? nextStartup({ ...next, startupIndex: next.startupIndex + 1 }, environment)
    : nextRound(next, environment);
}

function completeTools(state: UnitCycleState, environment: CycleEnvironment): CycleTransition {
  const next = {
    ...state,
    run: recordRoundProgress(state.run, state.hasNewOk, environment.config.noProgressRounds),
  };
  const fatal = state.failures.find((failure) => failure.kind === 'FAILED');
  if (fatal !== undefined) return applyFailure(next, fatal, environment);
  if (state.budgetState === 'EXHAUSTED') return degrade(next);
  const degraded = state.failures.find((failure) => failure.kind === 'DEGRADED_REPORT');
  if (degraded !== undefined) return applyFailure(next, degraded, environment);
  const final = state.failures.find((failure) => failure.kind === 'FINAL_CALL');
  return final === undefined
    ? nextRound(next, environment)
    : applyFailure(next, final, environment);
}

function handleModel(
  state: UnitCycleState,
  report: Extract<UnitReport, { readonly status: 'OK'; readonly executionKind: 'MODEL' }>,
  environment: CycleEnvironment,
): CycleTransition {
  const action = interpretModelOutput(
    report.output,
    state.run.definitions,
    environment.pinnedSets,
    state.isFinal,
    environment.registry,
  );
  const next = {
    ...state,
    run: recordRegeneration(
      state.run,
      action.kind === 'INVALID',
      environment.config.regenerationLimit,
    ),
  };
  if (action.kind === 'FINISH') return decide(next, action);
  if (next.budgetState === 'EXHAUSTED')
    return degrade(
      next,
      action.kind === 'INVALID' ? { kind: 'INVALID_OUTPUT', reason: action.reason } : undefined,
    );
  if (next.isFinal) {
    if (next.run.wrapUpReason === undefined) throw new Error('Final-call has no wrap-up reason');
    return decide(next, {
      kind: 'DEGRADED_REPORT',
      reason: next.run.wrapUpReason,
      lastIssue:
        action.kind === 'INVALID'
          ? { kind: 'INVALID_OUTPUT', reason: action.reason }
          : { kind: 'NO_FINISH' },
    });
  }
  if (action.kind === 'HANDOFF') return decide(next, action);
  const turn = {
    kind: 'MODEL_TURN' as const,
    round: next.run.roundsUsed,
    requestId: report.requestId,
    toolCalls: report.output.toolCalls,
  };
  if (action.kind === 'INVALID') {
    const calls: readonly (ModelToolCall | undefined)[] =
      report.output.toolCalls.length === 0 ? [undefined] : report.output.toolCalls;
    const steps = calls.map((call) => ({
      kind: 'FEEDBACK' as const,
      round: next.run.roundsUsed,
      code: 'INVALID_ACTION' as const,
      message: INVALID_ACTION_MESSAGES[action.reason],
      ...(call === undefined ? {} : { toolCallId: call.toolCallId }),
    }));
    return nextRound(
      {
        ...next,
        run: recordRoundProgress(
          { ...next.run, steps: [...next.run.steps, turn, ...steps] },
          false,
          environment.config.noProgressRounds,
        ),
      },
      environment,
    );
  }
  const validated = validateToolCalls(action.calls, {
    definitions: next.run.definitions,
    budgetState: next.budgetState,
    successfulCalls: next.successfulCalls,
    elidedRequestIds: next.run.elidedRequestIds,
    round: next.run.roundsUsed,
    registry: environment.registry,
  });
  const tools = {
    ...next,
    hasNewOk: false,
    failures: [],
    run: { ...next.run, steps: [...next.run.steps, turn, ...validated.feedback] },
  };
  if (validated.accepted.length === 0) return completeTools(tools, environment);
  return submit(
    tools,
    'TOOLS',
    validated.accepted.map((tool) => ({
      unit: tool.unit,
      input: tool.input,
      tool,
    })),
    environment,
  );
}

/** Consumes exactly one matching report, retains arrival order, and waits for the entire batch. */
export function receiveUnitReport(
  state: UnitCycleState,
  report: UnitReport,
  environment: CycleEnvironment,
): CycleTransition {
  if (state.phase === 'DECIDED') return { state, submissions: [] };
  const request = state.pending.get(report.requestId);
  if (request === undefined) return { state, submissions: [] };
  const expected = request.request.unitRef;
  if (
    report.agentRunId !== state.run.agentRunId ||
    report.unitRef.id !== expected.id ||
    report.unitRef.version !== expected.version ||
    report.unitRef.digest !== expected.digest ||
    report.executionKind !== request.unit.executionKind
  )
    throw new Error('UnitReport does not match its pending request');
  const pending = new Map(state.pending);
  pending.delete(report.requestId);
  let next: UnitCycleState = {
    ...state,
    pending,
    budgetState:
      BUDGET_ORDER[report.budgetState] > BUDGET_ORDER[state.budgetState]
        ? report.budgetState
        : state.budgetState,
    run: {
      ...applyBudgetFacts(state.run, report.budgetState),
      roundsUsed: roundsAfterReport(state.run.roundsUsed, report),
      pendingRequestIds: new Set(pending.keys()),
    },
  };
  if (report.status === 'OK' && report.executionKind === 'FILE_READ')
    next = {
      ...next,
      reads: [...next.reads, { requestId: report.requestId, output: report.output }],
    };
  if (state.phase === 'TOOLS') {
    next = recordToolResult(next, request, report);
    if (report.status !== 'OK') {
      const failure = decideUnitFailure(request.unit, report, false, next.run.wrapUpReason);
      next = {
        ...next,
        failures: [...next.failures, failure],
        run:
          failure.kind === 'FINAL_CALL' && next.run.wrapUpReason === undefined
            ? { ...next.run, wrapUpReason: failure.reason }
            : next.run,
      };
    }
    return pending.size === 0 ? completeTools(next, environment) : { state: next, submissions: [] };
  }
  if (report.status !== 'OK') {
    const failure = decideUnitFailure(
      request.unit,
      report,
      state.phase === 'MODEL' && state.isFinal,
      next.run.wrapUpReason,
    );
    // Only a failure handed back to the model is explained in its history (Workflow 7.2);
    // a wrap-up is already stated by WRAP_UP_NOTICE and the final-call status.
    if (state.phase === 'MODEL' && failure.kind === 'RETURN_TO_MODEL')
      next = {
        ...next,
        run: {
          ...next.run,
          steps: [
            ...next.run.steps,
            {
              kind: 'FEEDBACK',
              round:
                report.status === 'REJECTED'
                  ? next.run.roundsUsed + 1
                  : Math.max(1, next.run.roundsUsed),
              code: 'MODEL_CALL_FAILED',
              message: modelCallFailedMessage(report.reasonCode),
            },
          ],
        },
      };
    return applyFailure(next, failure, environment);
  }
  if (state.phase === 'STARTUP' && report.executionKind === 'REPOSITORY_ORIENT')
    return nextStartup(
      {
        ...next,
        startupIndex: next.startupIndex + 1,
        snapshotId: report.output.snapshotId,
        run: { ...next.run, orientPackRef: report.outputRef },
      },
      environment,
    );
  if (state.phase === 'CONTEXT' && report.executionKind === 'CONTEXT_ASSEMBLE') {
    if (next.budgetState === 'EXHAUSTED') return degrade(next);
    return submit(
      { ...next, run: { ...next.run, elidedRequestIds: report.output.elidedRequestIds } },
      'MODEL',
      [
        {
          unit: unitOf(next, 'MODEL'),
          input: { contextPackRef: report.outputRef, final: next.isFinal },
        },
      ],
      environment,
    );
  }
  if (state.phase === 'MODEL' && report.executionKind === 'MODEL')
    return handleModel(next, report, environment);
  throw new Error('UnitReport arrived in an incompatible cycle phase');
}
