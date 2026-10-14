/**
 * Workflow Module (docs/M1/Module/Workflow.md). domain holds the pure reducer and rules;
 * application consumes the Inbox and executes actions through WorkflowGatewayPort.
 */
import type {
  CatalogPort,
  LifecyclePort,
  PersistencePort,
  ProtocolRegistry,
  SystemFaultReporter,
  WorkflowConfig,
  WorkflowGatewayPort,
  WorkflowInboxPort,
} from '@multiagentos/contracts';
import { createWorkflowRunner } from './application/workflow-runner.js';

export type { WorkflowConfig } from '@multiagentos/contracts';

/** Suggested initial configuration (docs/M1/Module/Workflow.md section 12). */
export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = Object.freeze({
  entryAgentRef: Object.freeze({ id: 'planner', version: 'v0.1.0' }),
  regenerationLimit: 3,
  noProgressRounds: 2,
});

export interface WorkflowDeps {
  /** Workflow's only entry into the Kernel. */
  readonly gateway: WorkflowGatewayPort;
  readonly catalog: CatalogPort;
  /** Only the workflow namespace may be used. */
  readonly persistence: PersistencePort;
  /** Validates arguments against the tool's parametersContract. */
  readonly registry: ProtocolRegistry;
  readonly config: WorkflowConfig;
  /**
   * Escalates through the Inbox failure observer if closeRun(FAILED, WORKFLOW_INTERNAL) fails
   * (docs/M1/Module/Workflow.md section 11.1).
   */
  readonly reportSystemFault?: SystemFaultReporter;
  readonly now?: () => Date;
}

/** The composition root serves inbox at inbox.workflow. */
export interface WorkflowModule extends LifecyclePort {
  readonly inbox: WorkflowInboxPort;
}

export function createWorkflow(deps: WorkflowDeps): WorkflowModule {
  return createWorkflowRunner(deps);
}
