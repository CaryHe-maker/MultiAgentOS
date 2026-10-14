import { describe, expect, it } from 'vitest';
import { recordRegeneration, recordRoundProgress } from './progress.js';
import type { ProgressState } from './progress.js';

const initial: ProgressState = Object.freeze({ regenerationCount: 0, noProgressCount: 0 });

describe('regeneration and no-progress counters', () => {
  it('increments INVALID actions to the regeneration limit and clears on a valid action', () => {
    const once = recordRegeneration(initial, true, 2);
    expect(once.regenerationCount).toBe(1);
    expect(once.wrapUpReason).toBeUndefined();
    const twice = recordRegeneration(once, true, 2);
    expect(twice.wrapUpReason).toBe('REGENERATION_LIMIT');
    expect(recordRegeneration(once, false, 2).regenerationCount).toBe(0);
    expect(initial.regenerationCount).toBe(0);
  });

  it('counts a round without new OK results, including an INVALID round', () => {
    const once = recordRoundProgress(initial, false, 2);
    expect(once.noProgressCount).toBe(1);
    expect(once.wrapUpReason).toBeUndefined();
    const twice = recordRoundProgress(once, false, 2);
    expect(twice.wrapUpReason).toBe('NO_PROGRESS');
    expect(recordRoundProgress(once, true, 2).noProgressCount).toBe(0);
  });

  it('preserves the first wrap-up reason and all unrelated state', () => {
    const state = { ...initial, wrapUpReason: 'USER_DECLINED' as const, goal: '分析目标' };
    expect(recordRegeneration(state, true, 1)).toMatchObject({
      goal: state.goal,
      wrapUpReason: 'USER_DECLINED',
      regenerationCount: 1,
    });
    expect(recordRoundProgress(state, false, 1)).toMatchObject({
      goal: state.goal,
      wrapUpReason: 'USER_DECLINED',
      noProgressCount: 1,
    });
  });
});
