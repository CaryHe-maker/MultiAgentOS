import type { LibraryConfig, MemberTier } from '../config.js';

export interface Member {
  id: string;
  tier: MemberTier;
  suspended: boolean;
}

export type BorrowDecision =
  | { allowed: true }
  | { allowed: false; reason: 'SUSPENDED' | 'TOO_MANY_LOANS' };

/** Decides whether a member may take one more book. */
export function canBorrow(
  member: Member,
  activeLoans: number,
  config: Pick<LibraryConfig, 'maxActiveLoans'>,
): BorrowDecision {
  if (member.suspended) return { allowed: false, reason: 'SUSPENDED' };
  if (activeLoans >= config.maxActiveLoans[member.tier])
    return { allowed: false, reason: 'TOO_MANY_LOANS' };
  return { allowed: true };
}
