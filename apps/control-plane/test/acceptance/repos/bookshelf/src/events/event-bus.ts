export type LibraryEvent = { type: 'BookReturned'; bookId: string; at: Date };

type Listener = (event: LibraryEvent) => void;

/** Synchronous in-process publish/subscribe; listeners run in subscription order. */
export class EventBus {
  private readonly listeners: Listener[] = [];

  subscribe(listener: Listener): void {
    this.listeners.push(listener);
  }

  publish(event: LibraryEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
