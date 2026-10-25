import type { WorkflowState } from './state.js';

/** Private to Workflow: never sent to other modules and never contains repository text. */
export function workflowRunRecord(state: WorkflowState, updatedAt: string) {
  const runs = [...state.agentRuns];
  const current = state.currentAgentRun;
  if (current !== undefined && !runs.some(({ run }) => run.agentRunId === current.agentRunId))
    runs.push({
      run: current,
      ending:
        state.failure !== undefined || state.closed?.closeReason === 'FAILED'
          ? 'FAILED'
          : state.report !== undefined
            ? state.report.degraded
              ? 'DEGRADED'
              : 'FINISH'
            : 'CLOSED',
    });
  const agentRuns = runs.map(({ run, ending }) => ({
    agentRunId: run.agentRunId,
    agentRef: {
      kind: 'AGENT' as const,
      id: run.definitions.agent.id,
      version: run.definitions.agent.version,
      digest: run.definitions.agent.digest,
    },
    roundsUsed: run.roundsUsed,
    maxRounds: run.definitions.agent.limits.maxRounds,
    ending,
    ...(run.wrapUpReason === undefined ? {} : { wrapUpReason: run.wrapUpReason }),
  }));
  const stopped =
    state.closed?.closeReason === 'RUN_TIMEOUT' || state.closed?.closeReason === 'VIOLATION';
  return {
    id: state.workflowRunId,
    goal: state.goal,
    businessState: stopped ? `STOPPED(${state.closed?.closeReason})` : state.businessState,
    agentRuns,
    stepCount: runs.reduce((total, { run }) => total + run.steps.length, 0),
    reads: state.reads.map((read) => ({ requestId: read.requestId, output: { ...read.output } })),
    ...(state.reportRef === undefined ? {} : { reportRef: state.reportRef }),
    ...(state.failure === undefined ? {} : { failure: state.failure }),
    ...(state.closed === undefined
      ? {}
      : {
          closeReason: state.closed.closeReason,
          unknownEffects: state.closed.unknownEffects,
        }),
    updatedAt,
  };
}
