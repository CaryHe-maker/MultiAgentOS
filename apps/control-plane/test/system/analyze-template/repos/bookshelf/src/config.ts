import { readFileSync } from 'node:fs';

export type MemberTier = 'standard' | 'student' | 'staff';

export interface LibraryConfig {
  loanDays: number;
  graceDays: number;
  feeCentsPerDay: number;
  maxActiveLoans: Record<MemberTier, number>;
  holdPickupDays: number;
}

export function loadConfig(path = 'config/library.json'): LibraryConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as LibraryConfig;
}
