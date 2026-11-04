/**
 * Kernel Module (Module/Kernel). The package holds three communication subjects: the Kernel
 * core (Session management, the Session actor and per run Core, Execution, Monitor and
 * Scheduler under `session/`), the Gateway and the Supervisor. This entry exposes their
 * factories and the helpers the composition root needs; component internals stay private.
 */
export { DEFAULT_KERNEL_CONFIG } from './interfaces/index.js';
export {
  createSubprocessRunner,
  createSupervisor,
  type ModuleHostControl,
  type SupervisorDeps,
  type SupervisorModule,
  type TrackedSubprocessRunner,
} from './supervisor/index.js';
export {
  createSessionGatewayModule,
  createSessionKernelCore,
  type SessionKernelCoreModule,
  type SessionKernelDeps,
} from './session-kernel.js';
export {
  pinAgentFrom,
  pinnedAgentOf,
  type AgentCatalog,
  type PinFailure,
} from './session/pinned-agent.js';
export type { PinnedAgent } from './session/run-attempts.js';
export { minShare, type AgentBudget } from './monitor/index.js';
export { WorkspaceSnapshots } from './session/workspace-snapshots.js';
