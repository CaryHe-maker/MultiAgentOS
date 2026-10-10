import type {
  ArtifactStorePort,
  CatalogPort,
  FabricPort,
  LifecyclePort,
  PersistencePort,
  ProtocolRegistry,
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
  readonly now?: () => Date;
}

/**
 * Builds the Kernel core: Core, Execution, Monitor and Scheduler wired through the run actor.
 * Each component receives only the interfaces of `interfaces/` (Interaction 3.2).
 */
export function createKernelCore(deps: KernelCoreDeps): LifecyclePort {
  void deps;
  throw new Error('NOT_IMPLEMENTED: Kernel core');
}
