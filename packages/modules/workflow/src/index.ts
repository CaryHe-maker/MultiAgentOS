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
  WorkflowConfig,
  WorkflowGatewayPort,
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
export { compileTemplate } from './domain/graph/session-graph.js';
export { callResultsOf } from './domain/spawn/spawn-graph.js';
export { SessionLogStore, SessionStoreFailure } from './session/session-log-store.js';
export { settleStaleRecords } from './session/settle-stale.js';
export { agentBindingOf } from './session/agent-binding.js';
export {
  SessionRunner,
  type AgentBinding,
  type SessionRunnerDeps,
} from './session/session-runner.js';

/** Module/Workflow 11. */
export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = Object.freeze({
  regenerationLimit: 3,
  noProgressRounds: 2,
  repeatedIntent: Object.freeze({ window: 20, warnAt: 3, stopAt: 5 }),
  consecutiveErrorLimit: 5,
  maxNestedInstructions: 8,
  maxSubagentsPerCall: 8,
  maxDependencyDepth: 2,
  maxTasks: 12,
  maxSpawnCalls: 4,
});

export interface WorkflowDeps {
  /** Workflow's only entry into the Kernel. */
  readonly gateway: WorkflowGatewayPort;
  /** Only the `workflow` namespace may be used. */
  readonly persistence: SessionPersistencePort;
  /** Built-in Agents by id, and templates by id (Module/Workflow 4). */
  readonly agents: ReadonlyMap<string, AgentBinding>;
  readonly templates: ReadonlyMap<string, TemplateDefinition>;
  /** What `SESSION_STARTED` records of the definitions, and what `OPEN` compares. */
  readonly definitionsDigest: string;
  readonly definitionVersions: readonly string[];
  readonly config: WorkflowConfig;
  /** What the sandbox probe found; the model is told, and `SESSION_STARTED` records it. */
  readonly sandbox?: {
    readonly state: 'ISOLATED' | 'UNISOLATED' | 'UNAVAILABLE';
    readonly reason?: 'NO_BWRAP' | 'USERNS_DENIED' | 'PROFILE_FAILED';
  };
  readonly now?: () => Date;
  /**
   * Whether the repository lies in a git work tree, as the composition root found it: when it does
   * not, git_inspect is not offered, since every call of it could only fail.
   */
  readonly git?: boolean;
  /** False turns off `context: inherit` of playbook phases (D35), for comparing the two. */
  readonly inheritContext?: boolean;
}

/** The composition root serves the runner's three handlers at `inbox.workflow`. */
export interface WorkflowModule extends LifecyclePort {
  readonly runner: SessionRunner;
}

/** What the runtime context tells the model about commands; the log keeps it: 64 characters at most. */
const SANDBOX_TEXT = {
  ISOLATED: 'bwrap (isolated: no network, secrets hidden)',
  UNISOLATED: 'none (not isolated: each command is asked)',
  UNAVAILABLE: 'none (commands cannot be run)',
} as const;

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
    ...(deps.sandbox === undefined ? {} : { sandbox: deps.sandbox }),
    // The date is the process's local date.
    runtime: () => ({
      sandbox: SANDBOX_TEXT[deps.sandbox?.state ?? 'UNAVAILABLE'],
      currentDate: now().toISOString().slice(0, 10),
      ...(deps.git === undefined ? {} : { git: deps.git }),
    }),
    now,
    ...(deps.inheritContext === undefined ? {} : { inheritContext: deps.inheritContext }),
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
