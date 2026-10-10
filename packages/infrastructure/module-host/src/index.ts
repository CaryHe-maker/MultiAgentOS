import type { HealthStatus, LifecyclePort, ModuleId } from '@multiagentos/contracts';

/** A module could not be registered or ordered. */
export class ModuleHostError extends Error {
  public constructor(
    public readonly code: 'DUPLICATE_MODULE' | 'MISSING_DEPENDENCY' | 'DEPENDENCY_CYCLE',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ModuleHostError';
  }
}

/**
 * Assembly and lifecycle mechanism (docs/M1/Infrastructure/ModuleHost.md). The Supervisor
 * drives it: modules start in dependency order and stop in the reverse order. When a start
 * fails, the modules already started are stopped again and the error is rethrown, so the
 * system never opens the Gateway half-started.
 */
export class ModuleHost {
  readonly #modules = new Map<ModuleId, LifecyclePort>();
  #started: LifecyclePort[] = [];

  register(module: LifecyclePort): void {
    const { moduleId } = module.manifest;
    if (this.#modules.has(moduleId)) throw new ModuleHostError('DUPLICATE_MODULE', moduleId);
    this.#modules.set(moduleId, module);
  }

  /** Dependency order; modules without an order between them keep their registration order. */
  startOrder(): readonly ModuleId[] {
    const order: ModuleId[] = [];
    const visiting = new Set<ModuleId>();
    const visit = (moduleId: ModuleId, path: readonly ModuleId[]): void => {
      if (order.includes(moduleId)) return;
      if (visiting.has(moduleId))
        throw new ModuleHostError('DEPENDENCY_CYCLE', [...path, moduleId].join(' -> '));
      const module = this.#modules.get(moduleId);
      if (module === undefined) throw new ModuleHostError('MISSING_DEPENDENCY', moduleId);
      visiting.add(moduleId);
      for (const dependency of module.manifest.dependencies) visit(dependency, [...path, moduleId]);
      visiting.delete(moduleId);
      order.push(moduleId);
    };
    for (const moduleId of this.#modules.keys()) visit(moduleId, []);
    return order;
  }

  async start(): Promise<void> {
    for (const moduleId of this.startOrder()) {
      const module = this.#modules.get(moduleId);
      if (module === undefined) continue;
      try {
        await module.start();
      } catch (error) {
        await this.stop();
        throw error;
      }
      this.#started.push(module);
    }
  }

  /** Stops what was started, last started first. One failing stop does not skip the others. */
  async stop(): Promise<void> {
    const started = this.#started;
    this.#started = [];
    const errors: unknown[] = [];
    for (const module of [...started].reverse()) {
      try {
        await module.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Some modules failed to stop');
  }

  async health(): Promise<ReadonlyMap<ModuleId, HealthStatus>> {
    const result = new Map<ModuleId, HealthStatus>();
    for (const [moduleId, module] of this.#modules) result.set(moduleId, await module.health());
    return result;
  }
}
