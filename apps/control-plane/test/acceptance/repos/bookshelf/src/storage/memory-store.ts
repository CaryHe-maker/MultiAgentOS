import type { Loan } from '../loans/loan-service.js';
import type { Member } from '../loans/loan-policy.js';

/** In-memory persistence; a restart loses everything. */
export class Store {
  private readonly members = new Map<string, Member>();
  private readonly loans = new Map<string, Loan>();

  getMember(id: string): Member {
    const member = this.members.get(id);
    if (member === undefined) throw new Error(`unknown member ${id}`);
    return member;
  }

  saveMember(member: Member): void {
    this.members.set(member.id, member);
  }

  getLoan(id: string): Loan {
    const loan = this.loans.get(id);
    if (loan === undefined) throw new Error(`unknown loan ${id}`);
    return loan;
  }

  saveLoan(loan: Loan): void {
    this.loans.set(loan.id, { ...loan });
  }

  activeLoansOf(memberId: string): Loan[] {
    return [...this.loans.values()].filter(
      (loan) => loan.memberId === memberId && loan.returnedAt === undefined,
    );
  }
}
