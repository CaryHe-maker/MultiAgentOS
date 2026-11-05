import { writeRootCovers } from '@multiagentos/contracts';

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
  readonly id: string;
  readonly parent: string;
  readonly tasks: Map<string, DelegatedTask>;
  /** The tasks that never registered have been given up. */
  released: boolean;
  /** The AgentRuns of this delegation that are still running. */
  readonly live: Set<string>;
}

export type ClaimResult =
  | { readonly ok: true; readonly task: DelegatedTask }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' | 'WRONG_PARENT' | 'TAKEN' | 'RELEASED' };

/** Two sets of write roots touch the same files: one root covers the other. */
export function rootsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => writeRootCovers(a, b) || writeRootCovers(b, a)));
}

/** Every root of `inner` lies within one of `outer`. */
export function rootsWithin(inner: readonly string[], outer: readonly string[]): boolean {
  return inner.every((root) => outer.some((container) => writeRootCovers(container, root)));
}

export interface OccupancyHolder {
  readonly agentRunId: string;
  readonly parent: string | undefined;
  readonly running: boolean;
  readonly roots: readonly string[];
}

export class RunDelegations {
  readonly #delegations = new Map<string, Delegation>();
  readonly #childOf = new Map<string, string>();

  create(
    id: string,
    parent: string,
    tasks: readonly { name: string; roots: readonly string[]; tokens: number }[],
  ): void {
    this.#delegations.set(id, {
      id,
      parent,
      tasks: new Map(tasks.map((task) => [task.name, { ...task }])),
      released: false,
      live: new Set(),
    });
  }

  has(id: string): boolean {
    return this.#delegations.has(id);
  }

  /** The task of a delegation that is still open for an AgentRun: not taken, not given up. */
  taskOf(id: string, name: string): DelegatedTask | undefined {
    const delegation = this.#delegations.get(id);
    if (delegation === undefined || delegation.released) return undefined;
    const task = delegation.tasks.get(name);
    return task?.claimedBy === undefined ? task : undefined;
  }

  parentOf(id: string): string | undefined {
    return this.#delegations.get(id)?.parent;
  }

  /** A task registers its AgentRun. */
  claim(id: string, parent: string, name: string, agentRunId: string): ClaimResult {
    const delegation = this.#delegations.get(id);
    if (delegation === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (delegation.parent !== parent) return { ok: false, reason: 'WRONG_PARENT' };
    if (delegation.released) return { ok: false, reason: 'RELEASED' };
    const task = delegation.tasks.get(name);
    if (task === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (task.claimedBy !== undefined) return { ok: false, reason: 'TAKEN' };
    task.claimedBy = agentRunId;
    delegation.live.add(agentRunId);
    this.#childOf.set(agentRunId, id);
    return { ok: true, task };
  }

  childEnded(agentRunId: string): void {
    const id = this.#childOf.get(agentRunId);
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

  /** The ancestors of an AgentRun, nearest first. */
  ancestorsOf(parent: string | undefined, parentOf: (id: string) => string | undefined): string[] {
    const found: string[] = [];
    let next = parent;
    while (next !== undefined && !found.includes(next)) {
      found.push(next);
      next = parentOf(next);
    }
    return found;
  }

  /**
   * The AgentRun whose roots a new one would touch, if any: running, not an ancestor, not
   * delegated away. Registration is refused with WRITE_SCOPE_CONFLICT (M2Design 6.4).
   */
  conflict(
    holders: readonly OccupancyHolder[],
    candidate: { readonly ancestors: readonly string[]; readonly roots: readonly string[] },
  ): string | undefined {
    if (candidate.roots.length === 0) return undefined;
    return holders.find(
      (holder) =>
        holder.running &&
        holder.roots.length > 0 &&
        !candidate.ancestors.includes(holder.agentRunId) &&
        !this.isDelegated(holder.agentRunId) &&
        rootsOverlap(holder.roots, candidate.roots),
    )?.agentRunId;
  }
}
