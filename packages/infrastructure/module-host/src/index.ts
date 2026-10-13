import type { HealthStatus, LifecyclePort, ModuleId } from '@multiagentos/contracts';

/** A module could not be registered or ordered, or the host no longer accepts a start. */
export class ModuleHostError extends Error {
  public constructor(
    public readonly code:
      | 'DUPLICATE_MODULE'
      | 'MISSING_DEPENDENCY'
      | 'DEPENDENCY_CYCLE'
      | 'START_IN_PROGRESS'
      | 'HOST_STOPPED'
      | 'STOP_TIMEOUT',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ModuleHostError';
  }
}

/**
 * Where one module is in its lifecycle. A module leaves `REGISTERED` the moment its `start()`
 * is called, so a start that failed half way is still stopped; `STOP_FAILED` is kept as
 * evidence and never retried.
 */
export type ModuleLifecycleState =
  'REGISTERED' | 'STARTING' | 'READY' | 'START_FAILED' | 'STOPPING' | 'STOPPED' | 'STOP_FAILED';

export interface ModuleLedgerEntry {
  readonly moduleId: ModuleId;
  readonly state: ModuleLifecycleState;
  /** Why the module is in `START_FAILED` or `STOP_FAILED`. */
  readonly error?: unknown;
}

export interface ModuleHostOptions {
  /** A `stop()` that takes longer is recorded as `STOP_FAILED` and the next module is stopped. */
  readonly stopTimeoutMs?: number;
}

interface Entry {
  readonly module: LifecyclePort;
  state: ModuleLifecycleState;
  error?: unknown;
}

const NEEDS_STOP: readonly ModuleLifecycleState[] = ['STARTING', 'READY', 'START_FAILED'];

/**
 * Assembly and lifecycle mechanism (docs/M1/Infrastructure/ModuleHost.md). The Supervisor
 * drives it: modules start in dependency order and stop in the reverse order. When a start
 * fails, the failed module and the modules already started are stopped and the error is
 * rethrown, so the system never opens the Gateway half-started. It keeps a ledger of facts and
 * decides nothing about the system: whether a failure ends the process is the caller's call.
 */
export class ModuleHost {
  readonly #entries = new Map<ModuleId, Entry>();
  readonly #stopTimeoutMs: number | undefined;
  /** Modules whose `start()` was called, in that order. */
  #startSequence: Entry[] = [];
  #startOp: Promise<void> | undefined;
  #stopOp: Promise<void> | undefined;
  #stopRequested = false;

  public constructor(options: ModuleHostOptions = {}) {
    this.#stopTimeoutMs = options.stopTimeoutMs;
  }

  register(module: LifecyclePort): void {
    const { moduleId } = module.manifest;
    if (this.#entries.has(moduleId)) throw new ModuleHostError('DUPLICATE_MODULE', moduleId);
    this.#entries.set(moduleId, { module, state: 'REGISTERED' });
  }

  /** Dependency order; modules without an order between them keep their registration order. */
  startOrder(): readonly ModuleId[] {
    const order: ModuleId[] = [];
    const visiting = new Set<ModuleId>();
    const visit = (moduleId: ModuleId, path: readonly ModuleId[]): void => {
      if (order.includes(moduleId)) return;
      if (visiting.has(moduleId))
        throw new ModuleHostError('DEPENDENCY_CYCLE', [...path, moduleId].join(' -> '));
      const entry = this.#entries.get(moduleId);
      if (entry === undefined) throw new ModuleHostError('MISSING_DEPENDENCY', moduleId);
      visiting.add(moduleId);
      for (const dependency of entry.module.manifest.dependencies)
        visit(dependency, [...path, moduleId]);
      visiting.delete(moduleId);
      order.push(moduleId);
    };
    for (const moduleId of this.#entries.keys()) visit(moduleId, []);
    return order;
  }

  /**
   * Starts every module. A failure rolls back and leaves the host startable again unless a
   * module could not be stopped; a `stop()` that arrives meanwhile ends the start after the
   * module in flight.
   */
  start(afterStart?: (moduleId: ModuleId) => void | Promise<void>): Promise<void> {
    if (this.#stopRequested)
      return Promise.reject(new ModuleHostError('HOST_STOPPED', 'stop was requested'));
    if (this.#startOp !== undefined)
      return Promise.reject(new ModuleHostError('START_IN_PROGRESS', 'start is running'));
    const op = this.#start(afterStart).finally(() => {
      if (this.#startOp === op) this.#startOp = undefined;
    });
    this.#startOp = op;
    return op;
  }

  async #start(afterStart?: (moduleId: ModuleId) => void | Promise<void>): Promise<void> {
    const order = this.startOrder();
    const unclean = [...this.#entries.values()].find(
      (entry) => entry.state !== 'REGISTERED' && entry.state !== 'STOPPED',
    );
    if (unclean !== undefined)
      throw new ModuleHostError(
        'HOST_STOPPED',
        `${unclean.module.manifest.moduleId} is ${unclean.state}`,
      );
    this.#startSequence = [];
    try {
      for (const moduleId of order) {
        const entry = this.#entries.get(moduleId);
        if (entry === undefined) continue;
        if (this.#stopRequested) throw new ModuleHostError('HOST_STOPPED', 'stop was requested');
        entry.state = 'STARTING';
        delete entry.error;
        this.#startSequence.push(entry);
        try {
          await entry.module.start();
          entry.state = 'READY';
          await afterStart?.(moduleId);
        } catch (error) {
          entry.state = 'START_FAILED';
          entry.error = error;
          throw error;
        }
      }
    } catch (error) {
      try {
        await this.#stopModules();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Module start and rollback failed', {
          cause: rollbackError,
        });
      }
      throw error;
    }
  }

  /**
   * Stops what was started, last started first, and ends the host: a later `start()` is
   * refused. One failing stop does not skip the others. Concurrent and repeated calls share
   * one pass; it rejects for as long as the ledger holds a `STOP_FAILED` module.
   */
  stop(): Promise<void> {
    this.#stopRequested = true;
    this.#stopOp ??= (async () => {
      // A start in flight cannot be interrupted; it rolls back by itself once it sees the flag.
      await this.#startOp?.catch(() => undefined);
      await this.#stopModules();
    })();
    return this.#stopOp;
  }

  async #stopModules(): Promise<void> {
    for (const entry of [...this.#startSequence].reverse()) {
      if (!NEEDS_STOP.includes(entry.state)) continue;
      const startError = entry.state === 'START_FAILED' ? entry.error : undefined;
      entry.state = 'STOPPING';
      try {
        await this.#stopOne(entry.module);
        entry.state = 'STOPPED';
        delete entry.error;
      } catch (error) {
        entry.state = 'STOP_FAILED';
        entry.error =
          startError === undefined
            ? error
            : new AggregateError([startError, error], 'Module failed to start and to stop');
      }
    }
    const errors = [...this.#entries.values()]
      .filter((entry) => entry.state === 'STOP_FAILED')
      .map((entry) => entry.error);
    if (errors.length > 0) throw new AggregateError(errors, 'Some modules failed to stop');
  }

  async #stopOne(module: LifecyclePort): Promise<void> {
    if (this.#stopTimeoutMs === undefined) return module.stop();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ModuleHostError('STOP_TIMEOUT', module.manifest.moduleId)),
        this.#stopTimeoutMs,
      );
    });
    try {
      await Promise.race([module.stop(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every registered module with its state, in registration order. */
  ledger(): readonly ModuleLedgerEntry[] {
    return [...this.#entries].map(([moduleId, entry]) =>
      Object.freeze({
        moduleId,
        state: entry.state,
        ...(entry.error === undefined ? {} : { error: entry.error }),
      }),
    );
  }

  /** A snapshot per module; it does not report failures that happen between two calls. */
  async health(): Promise<ReadonlyMap<ModuleId, HealthStatus>> {
    const result = new Map<ModuleId, HealthStatus>();
    for (const [moduleId, entry] of this.#entries)
      result.set(moduleId, await entry.module.health());
    return result;
  }
}
