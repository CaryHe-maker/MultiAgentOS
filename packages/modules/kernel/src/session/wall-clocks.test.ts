import { describe, expect, it } from 'vitest';
import { WallClocks } from './wall-clocks.js';

function setup() {
  let now = 0;
  const timers: { delayMs: number; cancelled: boolean }[] = [];
  let dues = 0;
  const clocks = new WallClocks({
    now: () => now,
    schedule: (delayMs) => {
      const timer = { delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    due: () => {
      dues += 1;
    },
  });
  const advance = (ms: number) => {
    now += ms;
  };
  const armed = () => timers.filter((timer) => !timer.cancelled);
  return { clocks, advance, armed, dues: () => dues };
}

const nobodyWaits = () => false;

describe('WallClocks', () => {
  it('runs from registration and expires once', () => {
    const { clocks, advance, armed } = setup();
    clocks.register('agr_a', 1000);
    clocks.reconcile(nobodyWaits);
    expect(armed().map((timer) => timer.delayMs)).toEqual([1000]);
    advance(999);
    expect(clocks.takeExpired()).toEqual([]);
    advance(1);
    expect(clocks.takeExpired()).toEqual(['agr_a']);
    expect(clocks.takeExpired()).toEqual([]);
  });

  it('does not count the time spent waiting for the user', () => {
    const { clocks, advance, armed } = setup();
    clocks.register('agr_a', 1000);
    advance(400);
    clocks.reconcile(() => true);
    expect(armed()).toEqual([]);
    advance(60 * 60 * 1000);
    expect(clocks.takeExpired()).toEqual([]);
    expect(clocks.usedMs('agr_a')).toBe(400);
    clocks.reconcile(nobodyWaits);
    expect(armed().map((timer) => timer.delayMs)).toEqual([600]);
    advance(600);
    expect(clocks.takeExpired()).toEqual(['agr_a']);
  });

  it('arms one timer for the earliest clock', () => {
    const { clocks, armed } = setup();
    clocks.register('agr_a', 1000);
    clocks.register('agr_b', 300);
    clocks.register('agr_none', undefined);
    clocks.reconcile(nobodyWaits);
    expect(armed().map((timer) => timer.delayMs)).toEqual([300]);
    expect(clocks.usedMs('agr_none')).toBeUndefined();
  });

  it('leaves no timer once the run stops', () => {
    const { clocks, armed } = setup();
    clocks.register('agr_a', 1000);
    clocks.reconcile(nobodyWaits);
    clocks.stop();
    expect(armed()).toEqual([]);
  });
});
