/** Node clamps a timeout larger than a signed 32-bit integer to one millisecond. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Schedules a relative deadline without overflow; returns an idempotent cancellation. */
export function scheduleQuestionDeadline(delayMs: number, expire: () => void): () => void {
  if (!Number.isFinite(delayMs) || delayMs <= 0)
    throw new Error('Question deadline delay must be positive and finite');
  const deadline = performance.now() + delayMs;
  let isCancelled = false;
  const wake = () => {
    if (isCancelled) return;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      isCancelled = true;
      expire();
    } else timer = setTimeout(wake, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  };
  // Always defer expiry so the caller can register its cancellation before the callback runs.
  let timer = setTimeout(wake, Math.min(delayMs, MAX_TIMER_DELAY_MS));
  return () => {
    isCancelled = true;
    clearTimeout(timer);
  };
}
