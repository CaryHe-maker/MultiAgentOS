/**
 * Workflow Module (docs/M1/Module/Workflow.md). `domain/` holds the pure reducer and business
 * rules (AnalysisAction, Validation, failurePolicy, Round and final-call, handoff, report);
 * `application/` consumes the Inbox, issues syscalls through `WorkflowGatewayPort` and writes
 * the WorkflowRunRecord.
 */
import type {
  CatalogPort,
  LifecyclePort,
  PersistencePort,
  ProtocolRegistry,
  WorkflowConfig,
  WorkflowGatewayPort,
  WorkflowInboxPort,
} from '@multiagentos/contracts';

export type { WorkflowConfig } from '@multiagentos/contracts';

/** The suggested initial values (docs/M1/Module/Workflow.md 12). */
export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = Object.freeze({
  entryAgentRef: Object.freeze({ id: 'planner', version: 'v0.1.0' }),
  regenerationLimit: 3,
  noProgressRounds: 2,
});

export interface WorkflowDeps {
  /** Workflow's only way into the Kernel. */
  readonly gateway: WorkflowGatewayPort;
  readonly catalog: CatalogPort;
  /** Workflow takes the `workflow` namespace from it. */
  readonly persistence: PersistencePort;
  /** Validates tool arguments against a tool's `parametersContract`. */
  readonly registry: ProtocolRegistry;
  readonly config: WorkflowConfig;
  readonly now?: () => Date;
}

/** `inbox` is served on the address `inbox.workflow` by the composition root. */
export interface WorkflowModule extends LifecyclePort {
  readonly inbox: WorkflowInboxPort;
}

export function createWorkflow(deps: WorkflowDeps): WorkflowModule {
  void deps;
  throw new Error('NOT_IMPLEMENTED: Workflow');
}
