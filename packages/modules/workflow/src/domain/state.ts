import type {
  ArtifactRef,
  AnalysisReport,
  BudgetState,
  FileReadOutput,
  HandoffBrief,
  PinnedDefinitionSet,
  RunClosed,
  RunFailure,
  StepRecord,
  SubmitUnitRequest,
  WrapUpReason,
} from '@multiagentos/contracts';
import type { UnitCycleState } from './unit-cycle.js';

export interface AgentRunState {
  readonly agentRunId: string;
  readonly definitions: PinnedDefinitionSet;
  readonly roundsUsed: number;
  readonly regenerationCount: number;
  readonly noProgressCount: number;
  readonly wrapUpReason?: WrapUpReason;
  readonly steps: readonly StepRecord[];
  readonly orientPackRef?: ArtifactRef;
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly elidedRequestIds: readonly string[];
}

/** The reducer owns run state; the application only consumes actions and results. */
export interface WorkflowState {
  readonly workflowRunId: string;
  readonly goal: string;
  readonly phase:
    | 'PINNING_ENTRY'
    | 'PINNING_TARGET'
    | 'REGISTERING'
    | 'RUNNING'
    | 'SAVING_REPORT'
    | 'PUBLISHING'
    | 'ENDING'
    | 'CLOSING';
  readonly entry?: PinnedDefinitionSet;
  readonly target?: PinnedDefinitionSet;
  readonly currentAgentRun?: AgentRunState;
  readonly agentRuns: readonly {
    readonly run: AgentRunState;
    readonly ending: 'HANDOFF' | 'FINISH' | 'DEGRADED' | 'FAILED' | 'CLOSED';
  }[];
  readonly cycle?: UnitCycleState;
  readonly finalCallUsed: boolean;
  readonly handoff?: HandoffBrief;
  readonly afterEnd?: 'HANDOFF' | 'CLOSE_COMPLETED';
  readonly snapshotId?: string;
  readonly report?: AnalysisReport;
  readonly reportRef?: ArtifactRef;
  readonly pendingPublish?: SubmitUnitRequest;
  readonly budgetState: BudgetState;
  readonly reads: readonly { readonly requestId: string; readonly output: FileReadOutput }[];
  readonly businessState: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'STOPPED';
  readonly failure?: RunFailure;
  readonly closed?: RunClosed;
}
