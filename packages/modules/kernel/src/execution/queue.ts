import type { UnitAttempt } from './attempt.js';

/**
 * The single FIFO of one run (docs/M1/Kernel/Execution.md 3). It only orders attempts;
 * Execution decides when an attempt may start and when the queue is cleared.
 */
export class AttemptQueue {
  readonly #items: UnitAttempt[] = [];

  public get size(): number {
    return this.#items.length;
  }

  public enqueue(attempt: UnitAttempt): void {
    this.#items.push(attempt);
  }

  /** Returns the next attempt without changing its state. */
  public dequeue(): UnitAttempt | undefined {
    return this.#items.shift();
  }

  /** Removes every queued attempt; Execution marks them ABORTED. */
  public clear(): UnitAttempt[] {
    return this.#items.splice(0);
  }
}
