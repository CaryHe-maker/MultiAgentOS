import { describe, expect, it } from 'vitest';
import { reservedTokens } from './attempt-request.js';

describe('reservedTokens', () => {
  it('leaves room for the estimate to be low', () => {
    expect(reservedTokens(100_000, 880_000, 64_000)).toBe(169_000);
  });

  it('never asks for more than the ledger keeps for one call', () => {
    expect(reservedTokens(880_000, 880_000, 64_000)).toBe(944_000);
  });
});
