import { describe, expect, it } from 'vitest';
import { DEFAULT_KERNEL_CONFIG } from '../interfaces/kernel-config.js';
import { Monitor, MonitorInvariantError } from './index.js';

const grantedId = (decision: ReturnType<Monitor['reserve']>): string => {
  if (!decision.ok) throw new Error(`Unexpected rejection: ${decision.reasonCode}`);
  return decision.reservationId;
};

describe('Monitor settlement', () => {
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
});
