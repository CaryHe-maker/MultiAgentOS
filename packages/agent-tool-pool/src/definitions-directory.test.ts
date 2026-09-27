import { describe, expect, it } from 'vitest';
import type { ModelDefinition } from '@multiagentos/contracts';
import { FileDefinitionSource } from './adapters/file/file-definition-source.js';
import { buildCatalogIndex, planSeal } from './domain/catalog-index.js';
import { DEFAULT_DEFINITIONS_DIRECTORY } from './definitions-directory.js';

/**
 * Guards the catalog shipped in the repository. If someone edits a sealed file, this test
 * fails with DIGEST_MISMATCH; the fix is a new version, not a new digest.
 */
describe('shipped definitions', () => {
  const load = async () => await new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY).load();

  it('load without issues and are all sealed', async () => {
    const snapshot = await load();
    const result = buildCatalogIndex(snapshot);
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(planSeal(snapshot).patches).toEqual([]);
  });

  it('contain the M1 agent closure', async () => {
    const result = buildCatalogIndex(await load());
    if (!result.ok) throw new Error('catalog did not load');
    expect([...result.index.definitions.keys()].sort()).toEqual([
      'AGENT:repository-analysis-agent@v0.1.0',
      'MODEL:deepseek-flash@v1.0.0',
      'MODEL:deepseek-v4-pro@v1.0.0',
      'PROMPT:repository-analysis@v0.1.0',
      'TOOL:read-file@v0.1.0',
      'TOOL:search-repository@v0.1.0',
      'UNIT:context-build@v0.1.0',
      'UNIT:file-read@v0.1.0',
      'UNIT:model-call@v0.1.0',
    ]);
  });

  it('price DeepSeek models as published on 2026-09-28', async () => {
    const result = buildCatalogIndex(await load());
    if (!result.ok) throw new Error('catalog did not load');
    const model = (id: string) =>
      result.index.definitions.get(`MODEL:${id}@v1.0.0`) as ModelDefinition;
    // USD per 1M tokens, off-peak: cache hit / cache miss / output.
    const usd = (definition: ModelDefinition) =>
      Object.values(definition.pricing.offPeak).map((micro) => micro / 1_000_000);
    expect(usd(model('deepseek-flash'))).toEqual([0.003, 0.15, 0.6]);
    expect(usd(model('deepseek-v4-pro'))).toEqual([0.022, 0.66, 1.98]);
    for (const id of ['deepseek-flash', 'deepseek-v4-pro'])
      expect(model(id).pricing.peak).toMatchObject({
        ratePercent: 200,
        weekdays: [1, 2, 3, 4, 5],
        windows: [
          { start: '01:00', end: '04:00' },
          { start: '06:00', end: '10:00' },
        ],
      });
  });
});
