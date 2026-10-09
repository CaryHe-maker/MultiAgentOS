/**
 * Kernel.Supervisor (docs/M1/Kernel/Supervisor.md): system lifecycle, Executor dispatch,
 * deadlines, cancellation and execution facts. A separate communication subject that works with
 * the Kernel core only through `SupervisorPort` and `ExecutionFactSink`. The `SubprocessRunner`
 * here is the only code allowed to import `node:child_process`.
 */
import type {
  ExecutorRegistry,
  FabricPort,
  LifecyclePort,
  ProviderCredentials,
} from '@multiagentos/contracts';
import type { KernelConfig } from '../interfaces/index.js';

/** The part of ModuleHost the Supervisor drives; the composition root registers the modules. */
export interface ModuleHostControl {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SupervisorDeps {
  /** The Fabric client whose producer is `supervisor`. */
  readonly fabric: FabricPort;
  readonly executors: ExecutorRegistry;
  readonly credentials: ProviderCredentials;
  readonly moduleHost: ModuleHostControl;
  readonly config: KernelConfig;
  /** System data directory; the Supervisor empties `<dataDir>/tmp/` before anything starts. */
  readonly dataDir: string;
  readonly now?: () => Date;
}

/**
 * The first module to start and the last to stop. `start()` boots every other module through
 * ModuleHost; `whenStopped()` resolves after a `shutdown` request has stopped them all.
 */
export interface SupervisorModule extends LifecyclePort {
  whenStopped(): Promise<void>;
}

export function createSupervisor(deps: SupervisorDeps): SupervisorModule {
  void deps;
  throw new Error('NOT_IMPLEMENTED: Kernel.Supervisor');
}
