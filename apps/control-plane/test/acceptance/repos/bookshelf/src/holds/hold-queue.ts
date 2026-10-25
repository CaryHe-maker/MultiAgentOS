import type { LibraryConfig } from '../config.js';
import type { EventBus, LibraryEvent } from '../events/event-bus.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Hold {
  memberId: string;
  bookId: string;
  readyUntil?: Date;
}

export type Mailer = (memberId: string, message: string) => void;

/**
 * First-come, first-served holds. When a held book comes back, only the member at the head of
 * that book's queue is emailed, and the book is kept for them for `holdPickupDays`.
 */
export class HoldQueue {
  private readonly queues = new Map<string, Hold[]>();

  constructor(
    events: EventBus,
    private readonly mail: Mailer,
    private readonly config: Pick<LibraryConfig, 'holdPickupDays'>,
  ) {
    events.subscribe((event) => this.onEvent(event));
  }

  place(memberId: string, bookId: string): number {
    const queue = this.queues.get(bookId) ?? [];
    queue.push({ memberId, bookId });
    this.queues.set(bookId, queue);
    return queue.length;
  }

  private onEvent(event: LibraryEvent): void {
    if (event.type !== 'BookReturned') return;
    const head = this.queues.get(event.bookId)?.[0];
    if (head === undefined || head.readyUntil !== undefined) return;
    head.readyUntil = new Date(event.at.getTime() + this.config.holdPickupDays * DAY_MS);
    this.mail(head.memberId, `Your hold on ${event.bookId} is ready until ${head.readyUntil.toISOString()}`);
  }
}
