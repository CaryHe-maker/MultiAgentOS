import type { HealthStatus, LifecyclePort } from '@multiagentos/contracts';

export class ModuleHost {
  readonly #modules = new Map<string, LifecyclePort>();
  readonly #started: LifecyclePort[] = [];
  register(module: LifecyclePort): void {
    if (this.#modules.has(module.manifest.moduleId))
      throw new Error(`Duplicate module: ${module.manifest.moduleId}`);
    this.#modules.set(module.manifest.moduleId, module);
  }
  async start(): Promise<void> {
    for (const module of this.#sort()) {
      await module.start();
      this.#started.push(module);
    }
  }
  async stop(): Promise<void> {
    for (const module of [...this.#started].reverse()) await module.stop();
    this.#started.length = 0;
  }
  async health(): Promise<Readonly<Record<string, HealthStatus>>> {
    const entries = await Promise.all(
      [...this.#modules].map(async ([id, module]) => [id, await module.health()] as const),
    );
    return Object.freeze(Object.fromEntries(entries));
  }
  #sort(): LifecyclePort[] {
    const ordered: LifecyclePort[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Lifecycle dependency cycle at ${id}`);
      if (visited.has(id)) return;
      const module = this.#modules.get(id);
      if (!module) throw new Error(`Unknown lifecycle dependency: ${id}`);
      visiting.add(id);
      for (const dependency of module.manifest.dependencies) visit(dependency);
      visiting.delete(id);
      visited.add(id);
      ordered.push(module);
    };
    for (const id of this.#modules.keys()) visit(id);
    return ordered;
  }
}

export function simpleLifecycle(
  moduleId: string,
  dependencies: readonly string[] = [],
): LifecyclePort {
  let started = false;
  return {
    manifest: { moduleId, version: '0.1.0', dependencies },
    start() {
      started = true;
      return Promise.resolve();
    },
    stop() {
      started = false;
      return Promise.resolve();
    },
    health() {
      return Promise.resolve({
        status: started ? 'UP' : 'DOWN',
        checkedAt: new Date().toISOString(),
        details: [],
      });
    },
  };
}
