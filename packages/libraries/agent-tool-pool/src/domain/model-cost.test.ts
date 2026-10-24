import type { ModelDefinition } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEFINITIONS_DIRECTORY } from '../definitions-directory.js';
import { FileDefinitionSource } from '../adapters/file/file-definition-source.js';
import { loadCatalogIndex } from './load-catalog-index.js';
import { isPeakTime, modelCallCost } from './model-cost.js';

const index = await loadCatalogIndex(new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY));
const flash = index.definitions.get('MODEL:deepseek-flash@v1.0.0') as ModelDefinition;

describe('model call cost (AgentToolPool 7)', () => {
  it.each([
    ['2026-10-12T01:00:00Z', true], // Monday, first minute of the first window
    ['2026-10-12T03:59:00Z', true],
    ['2026-10-12T04:00:00Z', false], // windows are half-open
    ['2026-10-12T05:30:00Z', false],
    ['2026-10-16T09:59:00Z', true], // Friday
    ['2026-10-17T02:00:00Z', false], // Saturday
    ['2026-10-18T07:00:00Z', false], // Sunday
  ])('%s is peak: %s', (at, peak) => {
    expect(isPeakTime(flash.pricing, new Date(at))).toBe(peak);
  });

  it('prices hits, misses and output at the off-peak rates', () => {
    const cost = modelCallCost(
      flash,
      { inputTokens: 1_000_000, inputCacheHitTokens: 400_000, outputTokens: 100_000 },
      new Date('2026-10-12T12:00:00Z'),
    );
    // 0.4M × 0.003 + 0.6M × 0.15 + 0.1M × 0.60 USD = 0.0012 + 0.09 + 0.06 = 0.1512 USD
    expect(cost).toEqual({ microUsd: 151_200, peak: false });
  });

  it('doubles the price in the peak period and treats missing cache figures as misses', () => {
    const usage = { inputTokens: 1_000, outputTokens: 100 };
    const offPeak = modelCallCost(flash, usage, new Date('2026-10-12T12:00:00Z'));
    const peak = modelCallCost(flash, usage, new Date('2026-10-12T02:00:00Z'));
    expect(offPeak.microUsd).toBeCloseTo(1_000 * 0.15 + 100 * 0.6);
    expect(peak).toEqual({ microUsd: offPeak.microUsd * 2, peak: true });
  });
});
