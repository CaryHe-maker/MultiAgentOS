import type {
  ConsoleView,
  LiveState,
  ThinkingView,
  TranscriptRecord,
} from '@multiagentos/user-interaction';
import { ConsoleText } from '@multiagentos/user-interaction';

/** Something written once into the scroll-back of the terminal, and never redrawn. */
export type StaticItem =
  | { readonly id: number; readonly kind: 'RECORD'; readonly record: TranscriptRecord }
  | { readonly id: number; readonly kind: 'FOLDED'; readonly text: string };

/** Something still drawn in place, in the order it happened. */
export type TailItem =
  | { readonly kind: 'RECORD'; readonly seq: number; readonly record: TranscriptRecord }
  | { readonly kind: 'BLOCK'; readonly seq: number; readonly block: ThinkingView };

export interface ConsoleSnapshot {
  readonly static: readonly StaticItem[];
  /** The latest two blocks of thinking and what happened since the older of them, in order. */
  readonly tail: readonly TailItem[];
  readonly live: LiveState;
  /** Messages put back into the input box; `seq` changes each time so the box takes them once. */
  readonly restored: { readonly seq: number; readonly messages: readonly string[] };
}

const EMPTY: LiveState = { status: '', activity: [], waiting: 0, queued: [] };

/**
 * The console's view as a store the Ink components subscribe to (useSyncExternalStore).
 *
 * The terminal only lets a program add lines to what is already written; what is drawn in place is
 * only the bottom of the screen. So the store keeps the end of the conversation in place, and lets
 * it go into the scroll-back only when it can no longer change: everything from the second latest
 * block of thinking on (the two blocks, and the authorizations, steps and messages between and
 * after them) stays in place and in order; a third block moves everything before the second one
 * into the scroll-back, the oldest block as a single folded line (docs/M2/Phase1Console.md 4.3).
 */
export class ConsoleStore implements ConsoleView {
  readonly #listeners = new Set<() => void>();
  readonly #records: { seq: number; record: TranscriptRecord }[] = [];
  /** Blocks not yet in the scroll-back: where they stand in the order, and what they last were. */
  readonly #blocks = new Map<string, { seq: number; view: ThinkingView }>();
  /** Blocks the console passed in its latest update, in the order they began. */
  #present: string[] = [];
  /** Blocks that are in the scroll-back already: the console still passes them, and they stay there. */
  readonly #committed = new Set<string>();
  readonly #static: StaticItem[] = [];
  #nextId = 0;
  #sequence = 0;
  /** Everything before this has been moved into the scroll-back, whatever the blocks say. */
  #floor = 0;
  #live: LiveState = EMPTY;
  #restored: ConsoleSnapshot['restored'] = { seq: 0, messages: [] };
  #snapshot: ConsoleSnapshot = this.#build();

  public print(record: TranscriptRecord): void {
    this.#sequence += 1;
    this.#records.push({ seq: this.#sequence, record });
    this.#settle();
  }

  public update(live: LiveState): void {
    this.#live = live;
    const views = live.thinking ?? [];
    for (const view of views) {
      if (this.#committed.has(view.id)) continue;
      const known = this.#blocks.get(view.id);
      if (known === undefined) {
        this.#sequence += 1;
        this.#blocks.set(view.id, { seq: this.#sequence, view });
      } else known.view = view;
    }
    this.#present = views.map((view) => view.id).filter((id) => !this.#committed.has(id));
    this.#settle();
  }

  public restoreInput(messages: readonly string[]): void {
    this.#restored = { seq: this.#restored.seq + 1, messages: [...messages] };
    this.#snapshot = this.#build();
    this.#notify();
  }

  /**
   * The view ran out of room: everything before `seq` goes into the scroll-back now, whatever it
   * is, so the part that is still drawn in place fits the screen.
   */
  public advanceFloor(seq: number): void {
    if (seq <= this.#floor) return;
    this.#floor = seq;
    this.#settle();
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  public readonly snapshot = (): ConsoleSnapshot => this.#snapshot;

  /** Moves what has become final into the scroll-back, in order, and publishes the result. */
  #settle(): void {
    const present = this.#present
      .map((id) => this.#blocks.get(id))
      .filter((block): block is { seq: number; view: ThinkingView } => block !== undefined);
    const boundary =
      present.length === 0
        ? Number.POSITIVE_INFINITY
        : (present[Math.max(0, present.length - 2)]?.seq ?? Number.POSITIVE_INFINITY);
    const commitBelow = Math.max(boundary, this.#floor);
    const gone = [...this.#blocks.entries()].filter(([id]) => !this.#present.includes(id));
    const due = [
      ...this.#records
        .filter((entry) => entry.seq < commitBelow)
        .map((entry) => ({ seq: entry.seq, record: entry.record, id: undefined })),
      ...[...this.#blocks.entries()]
        .filter(([id, block]) => block.seq < commitBelow || gone.some(([other]) => other === id))
        .map(([id, block]) => ({ seq: block.seq, record: undefined, id, view: block.view })),
    ].sort((left, right) => left.seq - right.seq);
    for (const item of due) {
      if (item.record !== undefined) {
        this.#static.push({ id: this.#nextId++, kind: 'RECORD', record: item.record });
        this.#records.splice(
          this.#records.findIndex((entry) => entry.seq === item.seq),
          1,
        );
      } else if (item.id !== undefined && 'view' in item) {
        this.#static.push({
          id: this.#nextId++,
          kind: 'FOLDED',
          text: ConsoleText.thinkingFolded(item.view.number, item.view.label, secondsOf(item.view)),
        });
        this.#blocks.delete(item.id);
        this.#committed.add(item.id);
      }
    }
    this.#snapshot = this.#build();
    this.#notify();
  }

  #build(): ConsoleSnapshot {
    const tail: TailItem[] = [
      ...this.#records.map((entry) => ({
        kind: 'RECORD' as const,
        seq: entry.seq,
        record: entry.record,
      })),
      ...[...this.#blocks.values()].map((block) => ({
        kind: 'BLOCK' as const,
        seq: block.seq,
        block: block.view,
      })),
    ].sort((left, right) => left.seq - right.seq);
    return {
      static: [...this.#static],
      tail,
      live: this.#live,
      restored: this.#restored,
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

function secondsOf(view: ThinkingView): string {
  const end = view.endedAt === undefined ? Date.now() : Date.parse(view.endedAt);
  return `${(Math.max(0, end - Date.parse(view.startedAt)) / 1000).toFixed(1)}s`;
}
