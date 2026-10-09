/**
 * Kernel Module (docs/M1/Module/Kernel.md). The package holds three communication subjects:
 * the Kernel core (core, execution, monitor, scheduler, driven by run-actor), the Gateway and
 * the Supervisor. This entry exposes only their factories and `KernelConfig` to the
 * composition root; component internals stay private to their directories.
 */
export { DEFAULT_KERNEL_CONFIG, type BudgetConfig, type KernelConfig } from './interfaces/index.js';
export { createGateway, type GatewayDeps } from './gateway/index.js';
export { createKernelCore, type KernelCoreDeps } from './kernel-core.js';
export {
  createSupervisor,
  type ModuleHostControl,
  type SupervisorDeps,
  type SupervisorModule,
} from './supervisor/index.js';
