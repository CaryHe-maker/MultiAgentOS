import type {
  ArtifactStorePort,
  CatalogPort,
  FabricPort,
  LifecyclePort,
  PersistencePort,
  ProtocolRegistry,
  SystemFaultReporter,
} from '@multiagentos/contracts';
import type { KernelConfig } from './interfaces/index.js';

export interface KernelCoreDeps {
  /** The Fabric client whose producer is `kernel-core`. */
  readonly fabric: FabricPort;
  readonly catalog: CatalogPort;
  /** Used by Execution only. */
  readonly artifacts: ArtifactStorePort;
  /** Core takes the `kernel-core` namespace from it. */
  readonly persistence: PersistencePort;
  readonly registry: ProtocolRegistry;
  readonly config: KernelConfig;
  /** System data directory; `createRun` rejects a repository that contains or is inside it. */
  readonly dataDir: string;
  /**
   * Where the Kernel core escalates a fault it can no longer handle as a run fault, such as an
   * error thrown while a run is already converging. A plain function, not a Fabric message.
   */
  readonly reportSystemFault?: SystemFaultReporter;
  readonly now?: () => Date;
}

export interface AbortAllRunsRequest {
  /** Correlates the audit entries and the `failure.detail` of the runs with the fault. */
  readonly faultId: string;
  /** How long the caller waits; the Kernel core must not rely on being awaited longer. */
  readonly deadlineMs: number;
}

/**
 * `abortAllRuns` is the controlled maintenance entry of the composition root (Interaction 8):
 * it blocks new runs and puts `KERNEL_FAULT` on the control channel of every run that is not
 * CLOSED, so a RUNNING run converges as `FAILED(KERNEL_INTERNAL)`. It resolves once every run
 * is CLOSED and its Outbox is drained. It does not stop any module.
 */
export interface KernelCoreModule extends LifecyclePort {
  abortAllRuns(request: AbortAllRunsRequest): Promise<void>;
}

/**
 * Builds the Kernel core: Core, Execution, Monitor and Scheduler wired through the run actor.
 * Each component receives only the interfaces of `interfaces/` (Interaction 3.2).
 */
export function createKernelCore(deps: KernelCoreDeps): KernelCoreModule {
  void deps;
  throw new Error('NOT_IMPLEMENTED: Kernel core');
}
