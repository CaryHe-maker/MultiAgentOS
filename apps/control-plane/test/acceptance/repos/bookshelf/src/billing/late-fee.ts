import type { LibraryConfig } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fee in cents for a loan returned at `returnedAt`. Nothing is charged while the loan is
 * within its due date plus the grace period; after that every started day costs
 * `feeCentsPerDay`, counted from the due date, not from the end of the grace period.
 */
export function calculateLateFee(
  dueAt: Date,
  returnedAt: Date,
  config: Pick<LibraryConfig, 'graceDays' | 'feeCentsPerDay'>,
): number {
  if (returnedAt.getTime() <= dueAt.getTime()) return 0;
  const lateMs = returnedAt.getTime() - dueAt.getTime();
  const lateDays = Math.ceil(lateMs / DAY_MS);
  if (lateDays <= config.graceDays) return 0;
  return lateDays * config.feeCentsPerDay;
}
