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
  #flushWaiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  #observerError: Error | undefined;
  #hasObserverError = false;

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
    if (!this.#busy && this.#queue.length === 0)
      return this.#hasObserverError
        ? Promise.reject(this.#observerError ?? new Error('Sender failure observer failed'))
        : Promise.resolve();
    return new Promise((resolve, reject) => this.#flushWaiters.push({ resolve, reject }));
  }

  async #pump(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#queue.length > 0) {
        const item = this.#queue.shift() as T;
        try {
          await this.#send(item);
        } catch (error) {
          try {
            this.#onFailure(error, item);
          } catch (observerError) {
            if (!this.#hasObserverError) {
              this.#observerError =
                observerError instanceof Error
                  ? observerError
                  : new Error('Sender failure observer failed', { cause: observerError });
              this.#hasObserverError = true;
            }
          }
        }
      }
    } finally {
      this.#busy = false;
      const waiters = this.#flushWaiters;
      this.#flushWaiters = [];
      for (const waiter of waiters) {
        if (this.#hasObserverError)
          waiter.reject(this.#observerError ?? new Error('Sender failure observer failed'));
        else waiter.resolve();
      }
    }
  }
}
