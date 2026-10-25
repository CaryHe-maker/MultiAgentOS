import { calculateLateFee } from '../billing/late-fee.js';
import type { LibraryConfig } from '../config.js';
import type { EventBus } from '../events/event-bus.js';
import type { Store } from '../storage/memory-store.js';
import { canBorrow, type BorrowDecision } from './loan-policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Loan {
  id: string;
  memberId: string;
  bookId: string;
  dueAt: Date;
  returnedAt?: Date;
  feeCents?: number;
}

export class LoanService {
  constructor(
    private readonly store: Store,
    private readonly events: EventBus,
    private readonly config: LibraryConfig,
  ) {}

  borrow(memberId: string, bookId: string, now: Date): BorrowDecision & { loan?: Loan } {
    const member = this.store.getMember(memberId);
    const decision = canBorrow(member, this.store.activeLoansOf(memberId).length, this.config);
    if (!decision.allowed) return decision;
    const loan: Loan = {
      id: `${bookId}:${now.getTime()}`,
      memberId,
      bookId,
      dueAt: new Date(now.getTime() + this.config.loanDays * DAY_MS),
    };
    this.store.saveLoan(loan);
    return { allowed: true, loan };
  }

  /** Closes the loan, charges the late fee and tells listeners that the book is back. */
  returnBook(loanId: string, now: Date): Loan {
    const loan = this.store.getLoan(loanId);
    const closed: Loan = {
      ...loan,
      returnedAt: now,
      feeCents: calculateLateFee(loan.dueAt, now, this.config),
    };
    this.store.saveLoan(closed);
    this.events.publish({ type: 'BookReturned', bookId: loan.bookId, at: now });
    return closed;
  }
}
