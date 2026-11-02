/**
 * Workflow Module (Module/Workflow). `session/` runs one open Session from its log: the runner
 * consumes the three event sequences and acts through `WorkflowGatewayPort`; `domain/` holds the
 * pure AgentRun cycle, the context projection and the TaskGraph.
 */
import type {
  HealthStatus,
  LifecyclePort,
  SessionPersistencePort,
  TemplateDefinition,
  WorkflowConfigV1,
  WorkflowGatewayPortV1,
} from '@multiagentos/contracts';
import { SessionLogStore } from './session/session-log-store.js';
import { SessionRunner, type AgentBinding } from './session/session-runner.js';

export type {
  AgentConfig,
  AgentDefinitions,
  AgentTool,
  AgentUnit,
  DegradedAction,
  EndAction,
  EndTool,
} from './domain/agent/agent-cycle.js';
export { projectHistory } from './domain/context/history-projection.js';
export { SessionLogStore, SessionStoreFailure } from './session/session-log-store.js';
export { settleStaleRecords } from './session/settle-stale.js';
export { agentBindingOf } from './session/agent-binding.js';
export {
  SessionRunner,
  type AgentBinding,
  type SessionRunnerDeps,
} from './session/session-runner.js';

/** Module/Workflow 11. */
export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfigV1 = Object.freeze({
  regenerationLimit: 3,
  noProgressRounds: 2,
  repeatedIntent: Object.freeze({ window: 20, warnAt: 3, stopAt: 5 }),
  consecutiveErrorLimit: 5,
});

export interface WorkflowDeps {
  /** Workflow's only entry into the Kernel. */
  readonly gateway: WorkflowGatewayPortV1;
  /** Only the `workflow` namespace may be used. */
  readonly persistence: SessionPersistencePort;
  /** Built-in Agents by id, and templates by id (Module/Workflow 4). */
  readonly agents: ReadonlyMap<string, AgentBinding>;
  readonly templates: ReadonlyMap<string, TemplateDefinition>;
  /** What `SESSION_STARTED` records of the definitions, and what `OPEN` compares. */
  readonly definitionsDigest: string;
  readonly definitionVersions: readonly string[];
  readonly config: WorkflowConfigV1;
  readonly now?: () => Date;
}

/** The composition root serves the runner's three handlers at `inbox.workflow`. */
export interface WorkflowModule extends LifecyclePort {
  readonly runner: SessionRunner;
}

export function createWorkflow(deps: WorkflowDeps): WorkflowModule {
  const now = deps.now ?? (() => new Date());
  const runner = new SessionRunner({
    gateway: deps.gateway,
    store: new SessionLogStore(deps.persistence, now),
    agents: deps.agents,
    templates: deps.templates,
    definitionsDigest: deps.definitionsDigest,
    definitionVersions: deps.definitionVersions,
    config: deps.config,
    // M2 has no sandbox yet (M2Design 5); the date is the process's local date.
    runtime: () => ({ sandbox: 'none', currentDate: now().toISOString().slice(0, 10) }),
    now,
  });
  let running = false;
  return {
    runner,
    manifest: {
      moduleId: 'workflow',
      version: '0.2.0',
      dependencies: ['gateway', 'persistence'],
    },
    start: () => {
      running = true;
      return Promise.resolve();
    },
    stop: () => {
      running = false;
      return Promise.resolve();
    },
    health: (): Promise<HealthStatus> =>
      Promise.resolve({
        status: running ? 'UP' : 'DOWN',
        checkedAt: now().toISOString(),
        details: [],
      }),
  };
}
