import { describe, expect, it } from 'vitest';
import { fingerprintOf, RequestLedger } from './request-ledger.js';

describe('RequestLedger', () => {
  it('uses canonical JSON so property order does not change the fingerprint', () => {
    expect(fingerprintOf({ b: 1, a: 2 })).toBe(fingerprintOf({ a: 2, b: 1 }));
    expect(fingerprintOf({ a: 2 })).not.toBe(fingerprintOf({ a: 3 }));
  });

  it('replays the first response and reports a conflict for different content', () => {
    const ledger = new RequestLedger();
    const payload = { requestId: 'req_123456', goal: 'one' };
    const response = { requestId: 'req_123456', outcome: 'ACCEPTED' as const };
    ledger.remember('req_123456', payload, response);

    expect(ledger.lookup('req_123456', { goal: 'one', requestId: 'req_123456' })).toEqual({
      kind: 'replay',
      response,
    });
    expect(ledger.lookup('req_123456', { requestId: 'req_123456', goal: 'two' })).toEqual({
      kind: 'conflict',
    });
    expect(ledger.lookup('req_other', payload)).toEqual({ kind: 'new' });
  });
});
