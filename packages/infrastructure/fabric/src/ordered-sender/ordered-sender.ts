/**
 * Sends registered items one after another, in registration order, the next one only after the
 * previous send returned (docs/M1/Kernel/Interaction.md 4.4). A failed send is a contract
 * defect: it is reported, skipped and never retried, and later items are still sent.
 */
export class OrderedSender<T> {
  readonly #send: (item: T) => Promise<void>;
  readonly #onFailure: (error: unknown, item: T) => void;
  readonly #queue: T[] = [];
  #busy = false;
  #flushWaiters: (() => void)[] = [];

  public constructor(
    send: (item: T) => Promise<void>,
    onFailure: (error: unknown, item: T) => void,
  ) {
    this.#send = send;
    this.#onFailure = onFailure;
  }

  enqueue(item: T): void {
    this.#queue.push(item);
    void this.#pump();
  }

  /** Resolves once everything registered so far has been sent or reported as failed. */
  flushed(): Promise<void> {
    if (!this.#busy && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#flushWaiters.push(resolve));
  }

  async #pump(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (let item = this.#queue.shift(); item !== undefined; item = this.#queue.shift()) {
        try {
          await this.#send(item);
        } catch (error) {
          this.#onFailure(error, item);
        }
      }
    } finally {
      this.#busy = false;
      const waiters = this.#flushWaiters;
      this.#flushWaiters = [];
      for (const waiter of waiters) waiter();
    }
  }
}
