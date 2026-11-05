import { writeRootsOverlap } from '@multiagentos/contracts';

/**
 * The delegations of one run and the write occupancy that goes with them (M2Design 6.4, 7.3;
 * Kernel/Core 5d). Pure bookkeeping: the ledgers are the Monitor's, the checks of a request are
 * RunWork's.
 *
 * Write occupancy: the AgentRuns that are running hold pairwise disjoint write roots. A parent that
 * has delegated holds nothing while its children run: its roots are theirs, and what it submits
 * to write is refused until they have ended.
 */
export interface DelegatedTask {
  readonly name: string;
  /** The roots the task may write, as reserved; its AgentRun registers within them. */
  readonly roots: readonly string[];
  readonly tokens: number;
  /** The AgentRun that registered for this task. */
  claimedBy?: string;
}

interface Delegation {
  readonly parent: string;
  readonly tasks: Map<string, DelegatedTask>;
  /** The tasks that never registered have been given up. */
  released: boolean;
  /** The AgentRuns of this delegation that are still running. */
  readonly live: Set<string>;
}

/** What the occupancy needs to know of an AgentRun that has registered. */
export interface OccupancyHolder {
  readonly agentRunId: string;
  readonly running: boolean;
  /** What it may write; empty when it cannot write at all. */
  readonly roots: readonly string[];
}

export class RunDelegations {
  readonly #delegations = new Map<string, Delegation>();
  /** The delegation a SubAgent was started by, and so its parent. */
  readonly #delegationOf = new Map<string, string>();

  create(
    id: string,
    parent: string,
    tasks: readonly { name: string; roots: readonly string[]; tokens: number }[],
  ): void {
    this.#delegations.set(id, {
      parent,
      tasks: new Map(tasks.map((task) => [task.name, { ...task }])),
      released: false,
      live: new Set(),
    });
  }

  has(id: string): boolean {
    return this.#delegations.has(id);
  }

  /** The task `parent` delegated that nobody has registered for and that was not given up. */
  openTask(id: string, parent: string, name: string): DelegatedTask | undefined {
    const delegation = this.#delegations.get(id);
    if (delegation === undefined || delegation.parent !== parent || delegation.released)
      return undefined;
    const task = delegation.tasks.get(name);
    return task?.claimedBy === undefined ? task : undefined;
  }

  /** A task registers its AgentRun; `openTask` said it could. */
  claim(id: string, name: string, agentRunId: string): void {
    const delegation = this.#delegations.get(id);
    const task = delegation?.tasks.get(name);
    if (delegation === undefined || task === undefined) throw new Error(`No task ${name} in ${id}`);
    task.claimedBy = agentRunId;
    delegation.live.add(agentRunId);
    this.#delegationOf.set(agentRunId, id);
  }

  childEnded(agentRunId: string): void {
    const id = this.#delegationOf.get(agentRunId);
    if (id !== undefined) this.#delegations.get(id)?.live.delete(agentRunId);
  }

  /** The tasks that never registered are given up; true when this was the first time. */
  release(id: string): boolean {
    const delegation = this.#delegations.get(id);
    if (delegation === undefined || delegation.released) return false;
    delegation.released = true;
    return true;
  }

  #open(delegation: Delegation): boolean {
    if (delegation.live.size > 0) return true;
    if (delegation.released) return false;
    // Not released, and none runs: it is open until the tasks that have not registered are given
    // up, or all of them have registered.
    return [...delegation.tasks.values()].some((task) => task.claimedBy === undefined);
  }

  /** A parent with children that run, or tasks that may still register, holds no write roots. */
  isDelegated(parent: string): boolean {
    for (const delegation of this.#delegations.values())
      if (delegation.parent === parent && this.#open(delegation)) return true;
    return false;
  }

  /** The AgentRuns above `agentRunId`, nearest first; a cycle ends the walk. */
  #ancestorsOf(agentRunId: string | undefined): string[] {
    const found: string[] = [];
    let next = agentRunId;
    while (next !== undefined && !found.includes(next)) {
      found.push(next);
      const id = this.#delegationOf.get(next);
      next = id === undefined ? undefined : this.#delegations.get(id)?.parent;
    }
    return found;
  }

  /**
   * The AgentRun whose roots a new one under `parent` would touch, if any: running, not an
   * ancestor, not delegated away. Registration is refused with WRITE_SCOPE_CONFLICT (M2Design 6.4).
   */
  conflict(
    holders: readonly OccupancyHolder[],
    parent: string | undefined,
    roots: readonly string[],
  ): string | undefined {
    if (roots.length === 0) return undefined;
    const ancestors = this.#ancestorsOf(parent);
    return holders.find(
      (holder) =>
        holder.running &&
        holder.roots.length > 0 &&
        !ancestors.includes(holder.agentRunId) &&
        !this.isDelegated(holder.agentRunId) &&
        writeRootsOverlap(holder.roots, roots),
    )?.agentRunId;
  }
}
