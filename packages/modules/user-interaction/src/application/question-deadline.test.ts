import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleQuestionDeadline } from './question-deadline.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Question deadlines', () => {
  it('does not expire a long delay until its full duration has elapsed', () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const delayMs = 2_147_483_647 + 2_000;
    scheduleQuestionDeadline(delayMs, expire);
    vi.advanceTimersByTime(delayMs - 1);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a rescheduled long deadline and releases its timer', () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const cancel = scheduleQuestionDeadline(2_147_483_647 + 2_000, expire);
    vi.advanceTimersByTime(2_147_483_647);
    expect(vi.getTimerCount()).toBe(1);
    cancel();
    cancel();
    vi.advanceTimersByTime(2_000);
    expect(expire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires once when the event loop wakes after the deadline', () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10_000);
    const expire = vi.fn();
    scheduleQuestionDeadline(1_000, expire);
    vi.advanceTimersByTime(1_000);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
