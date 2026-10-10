/** One channel of the default, single-channel Inbox. */
export const DEFAULT_CHANNEL = 'default';

export interface InboxOptions<T, C extends string> {
  /** In priority order: a message of an earlier channel is always taken first. */
  readonly channels: readonly [C, ...C[]];
  /** When set, a message whose key was seen before is dropped (Inbox events use `eventId`). */
  readonly dedupeKey?: (message: T) => string;
  /** Called when a handler throws for a message nobody awaits; the loop goes on. */
  readonly onError?: (error: unknown, message: T) => void;
}

interface Entry<T, R> {
  readonly message: T;
  readonly resolve?: (value: R) => void;
  readonly reject?: (error: unknown) => void;
}

/**
 * The receive queue inside a communication subject (docs/M1/Infrastructure/Fabric.md 4):
 * messages are only enqueued on arrival and one consumer handles them one at a time. Channel
 * priority applies between two messages and never interrupts the one being handled, which is
 * what makes a run actor non-reentrant (docs/M1/Kernel/Interaction.md 4.4).
 */
export class Inbox<T, R = void, C extends string = typeof DEFAULT_CHANNEL> {
  readonly #options: InboxOptions<T, C>;
  readonly #queues: Map<C, Entry<T, R>[]>;
  readonly #seen = new Set<string>();
  #handler: ((message: T) => Promise<R>) | undefined;
  #busy = false;
  #idleWaiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  #unobservedError: Error | undefined;
  #hasUnobservedError = false;

  public constructor(options: InboxOptions<T, C>) {
    this.#options = options;
    this.#queues = new Map(options.channels.map((channel) => [channel, []]));
  }

  /** Starts consuming; messages enqueued earlier are handled first. */
  start(handler: (message: T) => Promise<R>): void {
    if (this.#handler !== undefined) throw new Error('Inbox already started');
    this.#handler = handler;
    void this.#pump();
  }

  /** Returns false when the message is a duplicate and was dropped. */
  enqueue(message: T, channel?: C): boolean {
    return this.#push({ message }, channel);
  }

  /** Enqueues a message and resolves with what the handler returns for it. */
  request(message: T, channel?: C): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      if (!this.#push({ message, resolve, reject }, channel))
        reject(new Error('Duplicate inbox request'));
    });
  }

  get size(): number {
    let total = 0;
    for (const queue of this.#queues.values()) total += queue.length;
    return total;
  }

  /** Resolves once every queued message has been handled. */
  idle(): Promise<void> {
    if (!this.#busy && this.size === 0)
      return this.#hasUnobservedError
        ? Promise.reject(this.#unobservedError ?? new Error('Unobserved inbox failure'))
        : Promise.resolve();
    return new Promise((resolve, reject) => this.#idleWaiters.push({ resolve, reject }));
  }

  #push(entry: Entry<T, R>, channel: C = this.#options.channels[0]): boolean {
    const queue = this.#queues.get(channel);
    if (queue === undefined) throw new Error(`Unknown inbox channel: ${channel}`);
    const key = this.#options.dedupeKey?.(entry.message);
    if (key !== undefined) {
      if (this.#seen.has(key)) return false;
      this.#seen.add(key);
    }
    queue.push(entry);
    void this.#pump();
    return true;
  }

  #next(): Entry<T, R> | undefined {
    for (const channel of this.#options.channels) {
      const entry = this.#queues.get(channel)?.shift();
      if (entry !== undefined) return entry;
    }
    return undefined;
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#handler === undefined) return;
    this.#busy = true;
    try {
      while (true) {
        const entry = this.#next();
        if (entry === undefined) break;
        try {
          const result = await this.#handler(entry.message);
          entry.resolve?.(result);
        } catch (error) {
          if (entry.reject !== undefined) entry.reject(error);
          else if (this.#options.onError === undefined) this.#recordUnobserved(error);
          else {
            try {
              this.#options.onError(error, entry.message);
            } catch (observerError) {
              this.#recordUnobserved(observerError);
            }
          }
        }
      }
    } finally {
      this.#busy = false;
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const waiter of waiters) {
        if (this.#hasUnobservedError)
          waiter.reject(this.#unobservedError ?? new Error('Unobserved inbox failure'));
        else waiter.resolve();
      }
    }
  }

  #recordUnobserved(error: unknown): void {
    if (this.#hasUnobservedError) return;
    this.#unobservedError =
      error instanceof Error ? error : new Error('Unobserved inbox failure', { cause: error });
    this.#hasUnobservedError = true;
  }
}
