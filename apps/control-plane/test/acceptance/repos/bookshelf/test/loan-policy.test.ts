import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canBorrow } from '../src/loans/loan-policy.js';

const config = { maxActiveLoans: { standard: 5, student: 8, staff: 12 } };

test('refuses a suspended member regardless of loans', () => {
  const member = { id: 'm1', tier: 'staff' as const, suspended: true };
  assert.deepEqual(canBorrow(member, 0, config), { allowed: false, reason: 'SUSPENDED' });
});

test('refuses the loan that would exceed the tier limit', () => {
  const member = { id: 'm2', tier: 'standard' as const, suspended: false };
  assert.deepEqual(canBorrow(member, 4, config), { allowed: true });
  assert.deepEqual(canBorrow(member, 5, config), { allowed: false, reason: 'TOO_MANY_LOANS' });
});
