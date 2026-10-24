import type { PinnedDefinitionSet, RunFailure, UnitDefinition } from '@multiagentos/contracts';
import { createDegradedReport } from './degraded-report.js';
import { failureFromCode } from './failure-policy.js';
import { createNormalReport } from './normal-report.js';
import type { ReducerEnvironment, WorkflowTransition } from './reducer.js';
import { reportSources } from './report-sources.js';
import { workflowRunRecord } from './run-record.js';
import type { WorkflowState } from './state.js';
import { startUnitCycle } from './unit-cycle.js';
import type { CycleEnvironment, CycleTransition } from './unit-cycle.js';

export function failWorkflow(
  state: WorkflowState,
  failure: RunFailure,
  environment: ReducerEnvironment,
): WorkflowTransition {
  return {
    state: { ...state, phase: 'CLOSING', failure },
    actions: [
      {
        kind: 'CLOSE',
        request: {
          requestId: environment.requestId,
          workflowRunId: state.workflowRunId,
          outcome: 'FAILED',
          failure,
        },
      },
    ],
  };
}

export function cycleEnvironment(
  state: WorkflowState,
  environment: ReducerEnvironment,
): CycleEnvironment {
  return {
    workflowRunId: state.workflowRunId,
    goal: state.goal,
    requestIds: environment.requestIds,
    config: environment.config,
    registry: environment.registry,
    pinnedSets: [state.entry, state.target].filter((set) => set !== undefined),
    reads: state.reads,
    ...(state.handoff === undefined ? {} : { handoff: state.handoff }),
    ...(state.snapshotId === undefined ? {} : { snapshotId: state.snapshotId }),
  };
}

export function registerWorkflow(
  state: WorkflowState,
  definitions: PinnedDefinitionSet,
  environment: ReducerEnvironment,
): WorkflowTransition {
  const agent = definitions.agent;
  const wrapUpReason =
    state.handoff !== undefined && state.budgetState === 'WRAP_UP'
      ? ('BUDGET_WRAP_UP' as const)
      : undefined;
  return {
    state: {
      ...state,
      phase: 'REGISTERING',
      currentAgentRun: {
        agentRunId: environment.agentRunId,
        definitions,
        roundsUsed: 0,
        regenerationCount: 0,
        noProgressCount: 0,
        steps: [],
        pendingRequestIds: new Set(),
        elidedRequestIds: [],
        ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
      },
    },
    actions: [
      {
        kind: 'REGISTER',
        request: {
          requestId: environment.requestId,
          workflowRunId: state.workflowRunId,
          agentRunId: environment.agentRunId,
          agentRef: { kind: 'AGENT', id: agent.id, version: agent.version, digest: agent.digest },
        },
      },
    ],
  };
}

export function beginCycle(
  state: WorkflowState,
  environment: ReducerEnvironment,
): WorkflowTransition {
  if (state.currentAgentRun === undefined) throw new Error('No registered AgentRun');
  return applyCycle(
    state,
    startUnitCycle(
      state.currentAgentRun,
      cycleEnvironment(state, environment),
      state.budgetState,
      state.finalCallUsed,
    ),
    environment,
  );
}

export function applyCycle(
  state: WorkflowState,
  transition: CycleTransition,
  environment: ReducerEnvironment,
): WorkflowTransition {
  const cycle = transition.state;
  const next: WorkflowState = {
    ...state,
    cycle,
    currentAgentRun: cycle.run,
    budgetState: cycle.budgetState,
    finalCallUsed: cycle.finalCallUsed,
    reads: cycle.reads,
    ...(cycle.snapshotId === undefined ? {} : { snapshotId: cycle.snapshotId }),
  };
  if (cycle.decision === undefined)
    return {
      state: { ...next, phase: 'RUNNING' },
      actions: transition.submissions.map((request) => ({ kind: 'SUBMIT', request })),
    };
  const decision = cycle.decision;
  if (decision.kind === 'FAILED') return failWorkflow(next, decision.failure, environment);
  if (decision.kind === 'HANDOFF') {
    if (next.target === undefined)
      return failWorkflow(next, failureFromCode('PIN_FAILED'), environment);
    return {
      state: { ...next, phase: 'ENDING', handoff: decision.brief, afterEnd: 'HANDOFF' },
      actions: [
        {
          kind: 'END',
          request: {
            requestId: environment.requestId,
            workflowRunId: next.workflowRunId,
            agentRunId: cycle.run.agentRunId,
          },
        },
      ],
    };
  }
  const record = workflowRunRecord(next, environment.createdAt);
  const agentRounds = record.agentRuns.map(({ agentRef, agentRunId, roundsUsed, maxRounds }) => ({
    agentId: agentRef.id,
    agentRunId,
    roundsUsed,
    maxRounds,
  }));
  const metadata = {
    workflowRunId: next.workflowRunId,
    goal: next.goal,
    agentRounds,
    createdAt: environment.createdAt,
    ...(next.snapshotId === undefined ? {} : { snapshotId: next.snapshotId }),
  };
  const report =
    decision.kind === 'FINISH'
      ? createNormalReport({
          ...metadata,
          draft: decision.draft,
          reads: next.reads,
          ...(cycle.run.wrapUpReason === undefined ? {} : { wrapUpReason: cycle.run.wrapUpReason }),
        })
      : createDegradedReport({
          ...metadata,
          ...reportSources(next.reads),
          reason: decision.reason,
          ...(decision.lastIssue === undefined ? {} : { lastIssue: decision.lastIssue }),
        });
  const units = cycle.run.definitions.units.filter(
    (unit) => unit.executionKind === 'REPORT_PUBLISH',
  );
  const unit: UnitDefinition | undefined = units.length === 1 ? units[0] : undefined;
  if (unit === undefined) throw new Error('Expected exactly one pinned report-publish Unit');
  const pendingPublish = {
    requestId: environment.requestId,
    workflowRunId: next.workflowRunId,
    agentRunId: cycle.run.agentRunId,
    unitRef: { kind: 'UNIT' as const, id: unit.id, version: unit.version, digest: unit.digest },
    input: { report },
  };
  const publishing: WorkflowState = { ...next, report, pendingPublish, phase: 'SAVING_REPORT' };
  return {
    state: publishing,
    actions: [
      { kind: 'WRITE_RECORD', record: workflowRunRecord(publishing, environment.createdAt) },
    ],
  };
}

export function afterAgentEnd(
  state: WorkflowState,
  environment: ReducerEnvironment,
): WorkflowTransition {
  const run = state.currentAgentRun;
  if (run === undefined) throw new Error('Cannot end an absent AgentRun');
  if (state.afterEnd === 'HANDOFF') {
    if (state.target === undefined) throw new Error('Missing pinned handoff target');
    return registerWorkflow(
      { ...state, agentRuns: [...state.agentRuns, { run, ending: 'HANDOFF' }] },
      state.target,
      environment,
    );
  }
  if (state.reportRef === undefined) throw new Error('Cannot complete without a published report');
  return {
    state: {
      ...state,
      phase: 'CLOSING',
      agentRuns: [
        ...state.agentRuns,
        { run, ending: state.report?.degraded === true ? 'DEGRADED' : 'FINISH' },
      ],
    },
    actions: [
      {
        kind: 'CLOSE',
        request: {
          requestId: environment.requestId,
          workflowRunId: state.workflowRunId,
          outcome: 'COMPLETED',
          reportRef: state.reportRef,
        },
      },
    ],
  };
}
