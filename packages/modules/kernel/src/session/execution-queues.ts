/**
 * The queues of Execution (M2Design 7.1, Kernel/Execution 4): one queue per AgentRun, and the
 * rules that decide which attempt may start now. Pure bookkeeping: it starts nothing itself.
 *
 *  - Within an AgentRun the attempts start in the order they were made. Neighbouring READs run
 *    together; WRITE, EXEC and MODEL are barriers: one starts only when everything before it has
 *    ended, and nothing after it starts before it has ended.
 *  - Between AgentRuns the queues run side by side, under global limits: attempts executing at
 *    once, EXEC executing at once, WEB (the search and the fetch of the web) executing at once in
 *    a pool of its own, and, with `serial`, one attempt at all. A WEB attempt waits for the
 *    network, not for a machine: it takes no place of the attempts, so a slow site cannot hold a
 *    model call back, and it is no barrier either.
 *  - FCFS: when several can start, the oldest attempt (the lowest `seq`) goes first.
 *  - Only an attempt that is executing counts against the limits. One that is queued, one that
 *    waits for a call slot and one that waits for an answer to a question do not (M2Design 7.1).
 */
export type ConcurrencyClass = 'READ' | 'WRITE' | 'EXEC' | 'MODEL' | 'WEB';

export type QueueState = 'QUEUED' | 'RUNNING' | 'WAITING';

export interface QueueEntry {
  /** The order the attempts were made in, over all AgentRuns. */
  readonly seq: number;
  readonly agentRunId: string;
  readonly cls: ConcurrencyClass;
  state: QueueState;
}

export interface QueueLimits {
  readonly maxAttempts: number;
  readonly maxExec: number;
  /** Web attempts executing at once; they are not counted in `maxAttempts`. */
  readonly maxWeb: number;
  /** Every attempt is a barrier and only one runs at a time: for finding races. */
  readonly serial: boolean;
}

export class AttemptQueues<E extends QueueEntry> {
  readonly #queues = new Map<string, E[]>();

  add(entry: E): void {
    entry.state = 'QUEUED';
    const queue = this.#queues.get(entry.agentRunId) ?? [];
    queue.push(entry);
    this.#queues.set(entry.agentRunId, queue);
  }

  /**
   * Marks what may start now as RUNNING and returns it, oldest first. An entry `allowed` refuses
   * stays queued and blocks what stands behind it, like a barrier that has not started.
   */
  startable(limits: QueueLimits, allowed: (entry: E) => boolean = () => true): E[] {
    const started: E[] = [];
    for (;;) {
      const next = this.#oldestEligible(limits, allowed);
      if (next === undefined) return started;
      next.state = 'RUNNING';
      started.push(next);
    }
  }

  /** The attempt ended, or was given up: it leaves its queue. */
  release(entry: E): void {
    const queue = this.#queues.get(entry.agentRunId);
    if (queue === undefined) return;
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.#queues.delete(entry.agentRunId);
  }

  /** An executing attempt waits for a call slot: it stays at the head of its queue, uncounted. */
  park(entry: E): void {
    entry.state = 'WAITING';
  }

  /** A parked attempt runs again if the limits allow it. */
  resume(entry: E, limits: QueueLimits): boolean {
    if (entry.state !== 'WAITING' || !this.#fits(entry, limits)) return false;
    entry.state = 'RUNNING';
    return true;
  }

  /** What has not started, removed: the run is converging. */
  /** Takes out what waits to run: of every AgentRun, or of one. */
  drainQueued(agentRunId?: string): E[] {
    const queued: E[] = [];
    for (const [owner, queue] of this.#queues) {
      if (agentRunId !== undefined && owner !== agentRunId) continue;
      for (const entry of [...queue])
        if (entry.state === 'QUEUED') {
          queued.push(entry);
          queue.splice(queue.indexOf(entry), 1);
        }
    }
    for (const [owner, queue] of this.#queues) if (queue.length === 0) this.#queues.delete(owner);
    return queued;
  }

  /** What waits to start, oldest first. */
  waitingQueued(): E[] {
    return this.#all()
      .filter((entry) => entry.state === 'QUEUED')
      .sort((a, b) => a.seq - b.seq);
  }

  running(): E[] {
    return this.#all().filter((entry) => entry.state === 'RUNNING');
  }

  /** Waiting for a call slot, oldest first. */
  waiting(): E[] {
    return this.#all()
      .filter((entry) => entry.state === 'WAITING')
      .sort((a, b) => a.seq - b.seq);
  }

  size(): number {
    return this.#all().length;
  }

  #all(): E[] {
    return [...this.#queues.values()].flat();
  }

  #counts(): { running: number; exec: number; web: number } {
    let running = 0;
    let exec = 0;
    let web = 0;
    for (const entry of this.#all())
      if (entry.state === 'RUNNING') {
        if (entry.cls === 'WEB') web += 1;
        else running += 1;
        if (entry.cls === 'EXEC') exec += 1;
      }
    return { running, exec, web };
  }

  #fits(entry: E, limits: QueueLimits): boolean {
    const { running, exec, web } = this.#counts();
    // One attempt at all: the web counts as well.
    if (limits.serial) return running + web < 1;
    if (entry.cls === 'WEB') return web < limits.maxWeb;
    if (running >= limits.maxAttempts) return false;
    return !(entry.cls === 'EXEC' && exec >= limits.maxExec);
  }

  /** Reads and the web go side by side; everything else is a barrier. */
  #isBarrier(entry: E, limits: QueueLimits): boolean {
    return limits.serial || (entry.cls !== 'READ' && entry.cls !== 'WEB');
  }

  #oldestEligible(limits: QueueLimits, allowed: (entry: E) => boolean): E | undefined {
    let best: E | undefined;
    for (const queue of this.#queues.values()) {
      for (let index = 0; index < queue.length; index += 1) {
        const entry = queue[index];
        if (entry === undefined) break;
        // A running or waiting entry in front of a barrier blocks it; a barrier blocks all after.
        if (entry.state !== 'QUEUED') {
          if (this.#isBarrier(entry, limits)) break;
          continue;
        }
        if (!allowed(entry)) break;
        const before = queue.slice(0, index);
        const free = this.#isBarrier(entry, limits)
          ? before.length === 0
          : before.every((earlier) => !this.#isBarrier(earlier, limits));
        if (free && this.#fits(entry, limits) && (best === undefined || entry.seq < best.seq))
          best = entry;
        // Whatever stands behind a barrier cannot start before it.
        if (this.#isBarrier(entry, limits)) break;
      }
    }
    return best;
  }
}
