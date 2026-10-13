import { describe, expect, it } from 'vitest';
import { DEFAULT_KERNEL_CONFIG } from '../interfaces/kernel-config.js';
import { Monitor, MonitorInvariantError } from './index.js';

const grantedId = (decision: ReturnType<Monitor['reserve']>): string => {
  if (!decision.ok) throw new Error(`Unexpected rejection: ${decision.reasonCode}`);
  return decision.reservationId;
};

describe('Monitor settlement', () => {
  const budget = {
    ...DEFAULT_KERNEL_CONFIG.budget,
    tokenLimit: 100,
    finalInputBudget: 20,
    finalMaxOutputTokens: 10,
    perCallInputLimit: 20,
    maxOutputTokens: 10,
  };

  it('keeps the final reserve unavailable to ordinary calls and moves state only forward', () => {
    const monitor = new Monitor(budget);
    const ordinary = grantedId(monitor.reserve({ estimatedTokens: 70, final: false }));
    expect(monitor.reserve({ estimatedTokens: 1, final: false })).toEqual({
      ok: false,
      reasonCode: 'BUDGET_WRAP_UP',
    });
    expect(monitor.budgetState()).toBe('WRAP_UP');
    monitor.settle(ordinary, { type: 'NOT_SENT' });
    expect(monitor.budgetState()).toBe('WRAP_UP');
    const final = grantedId(monitor.reserve({ estimatedTokens: 30, final: true }));
    monitor.settle(final, { type: 'ACTUAL', usage: { inputTokens: 20, outputTokens: 10 } });
    expect(monitor.finalize()).toMatchObject({ used: 30, finalBudgetState: 'WRAP_UP' });
  });

  it('rejects a final call beyond the total limit and exhausts after an overrun', () => {
    const monitor = new Monitor(budget);
    const ordinary = grantedId(monitor.reserve({ estimatedTokens: 70, final: false }));
    monitor.settle(ordinary, { type: 'ACTUAL', usage: { inputTokens: 60, outputTokens: 15 } });
    expect(monitor.budgetState()).toBe('EXHAUSTED');
    expect(monitor.reserve({ estimatedTokens: 30, final: true })).toEqual({
      ok: false,
      reasonCode: 'BUDGET_EXHAUSTED',
    });
    expect(monitor.finalize()).toMatchObject({ used: 75, finalBudgetState: 'EXHAUSTED' });
  });

  it('accounts for an in-flight final reservation and rejects another that exceeds the limit', () => {
    const monitor = new Monitor(budget);
    grantedId(monitor.reserve({ estimatedTokens: 70, final: false }));
    grantedId(monitor.reserve({ estimatedTokens: 30, final: true }));
    expect(monitor.reserve({ estimatedTokens: 1, final: true })).toEqual({
      ok: false,
      reasonCode: 'BUDGET_EXHAUSTED',
    });
    expect(monitor.finalize()).toMatchObject({ unknown: 100, finalBudgetState: 'EXHAUSTED' });
  });

  it('returns an over-estimate anomaly while keeping the actual usage and final reserve', () => {
    const monitor = new Monitor(DEFAULT_KERNEL_CONFIG.budget);
    const reservationId = grantedId(monitor.reserve({ estimatedTokens: 100, final: false }));
    expect(
      monitor.settle(reservationId, {
        type: 'ACTUAL',
        usage: { inputTokens: 80, outputTokens: 40 },
      }),
    ).toEqual({
      budgetState: 'NORMAL',
      anomalies: [
        {
          type: 'ACTUAL_EXCEEDED_ESTIMATE',
          reservationId,
          estimatedTokens: 100,
          actualTokens: 120,
        },
      ],
    });
    expect(
      monitor.settle(reservationId, {
        type: 'ACTUAL',
        usage: { inputTokens: 80, outputTokens: 40 },
      }).anomalies,
    ).toEqual([]);
    expect(monitor.finalize()).toMatchObject({
      used: 120,
      unknown: 0,
      inputTokens: 80,
      outputTokens: 40,
    });
  });

  it('keeps the larger charge when a duplicate settlement conflicts', () => {
    const monitor = new Monitor(DEFAULT_KERNEL_CONFIG.budget);
    const reservationId = grantedId(monitor.reserve({ estimatedTokens: 100, final: false }));
    monitor.settle(reservationId, { type: 'UNKNOWN' });
    expect(
      monitor.settle(reservationId, {
        type: 'ACTUAL',
        usage: { inputTokens: 70, outputTokens: 50 },
      }).anomalies,
    ).toEqual([
      { type: 'CONFLICTING_SETTLEMENT', reservationId, previousTokens: 100, offeredTokens: 120 },
      { type: 'ACTUAL_EXCEEDED_ESTIMATE', reservationId, estimatedTokens: 100, actualTokens: 120 },
    ]);
    monitor.settle(reservationId, { type: 'NOT_SENT' });
    expect(monitor.finalize()).toMatchObject({
      used: 120,
      unknown: 0,
      inputTokens: 70,
      outputTokens: 50,
    });
  });

  it('accounts for unreturned reservations as unknown and preserves monotonic budget state', () => {
    const monitor = new Monitor(DEFAULT_KERNEL_CONFIG.budget);
    grantedId(monitor.reserve({ estimatedTokens: 540_000, final: false }));
    expect(monitor.finalize()).toMatchObject({
      used: 0,
      unknown: 540_000,
      finalBudgetState: 'WRAP_UP',
    });
    expect(monitor.finalize().unknown).toBe(540_000);
    expect(() => monitor.reserve({ estimatedTokens: 1, final: false })).toThrow(
      MonitorInvariantError,
    );
  });

  it('rejects invalid usage without changing an outstanding reservation', () => {
    const monitor = new Monitor(DEFAULT_KERNEL_CONFIG.budget);
    const reservationId = grantedId(monitor.reserve({ estimatedTokens: 100, final: false }));
    expect(() =>
      monitor.settle(reservationId, {
        type: 'ACTUAL',
        usage: { inputTokens: -1, outputTokens: 10 },
      }),
    ).toThrow(MonitorInvariantError);
    expect(monitor.finalize().unknown).toBe(100);
  });

  it('rejects an impossible cache-hit count without consuming a reservation', () => {
    const monitor = new Monitor(budget);
    const reservationId = grantedId(monitor.reserve({ estimatedTokens: 10, final: false }));
    expect(() =>
      monitor.settle(reservationId, {
        type: 'ACTUAL',
        usage: { inputTokens: 5, outputTokens: 1, inputCacheHitTokens: 6 },
      }),
    ).toThrow(MonitorInvariantError);
    expect(monitor.finalize().unknown).toBe(10);
  });

  it('leaves the prior charge intact when a conflicting settlement would overflow the ledger', () => {
    const monitor = new Monitor(budget);
    const first = grantedId(monitor.reserve({ estimatedTokens: 10, final: false }));
    const second = grantedId(monitor.reserve({ estimatedTokens: 10, final: false }));
    monitor.settle(first, { type: 'ACTUAL', usage: { inputTokens: 10, outputTokens: 0 } });
    monitor.settle(second, { type: 'ACTUAL', usage: { inputTokens: 10, outputTokens: 0 } });
    expect(() =>
      monitor.settle(first, {
        type: 'ACTUAL',
        usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
      }),
    ).toThrow(MonitorInvariantError);
    expect(monitor.finalize()).toMatchObject({ used: 20, inputTokens: 20, outputTokens: 0 });
  });
});
