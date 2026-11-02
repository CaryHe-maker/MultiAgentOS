import type { ConsoleView, LiveState, TranscriptRecord } from '@multiagentos/user-interaction';

export interface ConsoleSnapshot {
  readonly records: readonly (TranscriptRecord & { readonly id: number })[];
  readonly live: LiveState;
  /** Messages put back into the input box; `seq` changes each time so the box takes them once. */
  readonly restored: { readonly seq: number; readonly messages: readonly string[] };
}

const EMPTY: LiveState = { status: '', activity: [], waiting: 0, queued: [] };

/** The console's view as a store the Ink components subscribe to (useSyncExternalStore). */
export class ConsoleStore implements ConsoleView {
  #snapshot: ConsoleSnapshot = { records: [], live: EMPTY, restored: { seq: 0, messages: [] } };
  readonly #listeners = new Set<() => void>();
  #nextId = 0;

  public print(record: TranscriptRecord): void {
    this.#set({
      ...this.#snapshot,
      records: [...this.#snapshot.records, { ...record, id: this.#nextId++ }],
    });
  }

  public update(live: LiveState): void {
    this.#set({ ...this.#snapshot, live });
  }

  public restoreInput(messages: readonly string[]): void {
    this.#set({
      ...this.#snapshot,
      restored: { seq: this.#snapshot.restored.seq + 1, messages: [...messages] },
    });
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  public readonly snapshot = (): ConsoleSnapshot => this.#snapshot;

  #set(next: ConsoleSnapshot): void {
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}
