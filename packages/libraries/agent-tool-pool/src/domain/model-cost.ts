import type { ModelDefinition, TokenUsage } from '@multiagentos/contracts';

type Pricing = ModelDefinition['pricing'];

/**
 * Whether `at` falls in the peak period of the model's pricing (AgentToolPool 7): an ISO
 * weekday listed in `peak.weekdays` and a time inside one of the half-open `[start, end)`
 * windows, both in UTC. Public holidays are not known, so a holiday is priced as a working
 * day and the result is an upper bound on those days.
 */
export function isPeakTime(pricing: Pricing, at: Date): boolean {
  const weekday = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  if (!pricing.peak.weekdays.includes(weekday)) return false;
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  return pricing.peak.windows.some(
    (window) => minuteOf(window.start) <= minute && minute < minuteOf(window.end),
  );
}

function minuteOf(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export interface CallCost {
  /** Micro-USD; fractional, so sums over many calls stay exact enough to report. */
  readonly microUsd: number;
  readonly peak: boolean;
}

/**
 * The price of one model call whose usage was reported at `at`. Cache hits are priced as hits,
 * the rest of the input as misses; a call without cache figures is priced as all misses, which
 * is the upper bound.
 */
export function modelCallCost(model: ModelDefinition, usage: TokenUsage, at: Date): CallCost {
  const rates = model.pricing.offPeak;
  const hit = Math.min(usage.inputCacheHitTokens ?? 0, usage.inputTokens);
  const offPeak =
    (hit * rates.inputCacheHit +
      (usage.inputTokens - hit) * rates.inputCacheMiss +
      usage.outputTokens * rates.output) /
    1_000_000;
  const peak = isPeakTime(model.pricing, at);
  return { microUsd: peak ? (offPeak * model.pricing.peak.ratePercent) / 100 : offPeak, peak };
}
