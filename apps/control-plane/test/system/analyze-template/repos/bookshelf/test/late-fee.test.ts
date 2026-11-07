import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateLateFee } from '../src/billing/late-fee.js';

const config = { graceDays: 2, feeCentsPerDay: 25 };
const due = new Date('2026-03-01T12:00:00Z');
const at = (hours: number) => new Date(due.getTime() + hours * 3600_000);

test('charges nothing on or before the due date', () => {
  assert.equal(calculateLateFee(due, due, config), 0);
  assert.equal(calculateLateFee(due, at(-5), config), 0);
});

test('charges nothing within the grace period', () => {
  assert.equal(calculateLateFee(due, at(48), config), 0);
});

test('counts every started day from the due date once grace is over', () => {
  assert.equal(calculateLateFee(due, at(49), config), 75);
});
