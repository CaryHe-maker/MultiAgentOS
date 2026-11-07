import { describe, expect, it } from 'vitest';
import { FileDefinitionSource } from './adapters/file/file-definition-source.js';
import { DefinitionCatalog, buildCatalogIndex, planSeal } from './catalog/catalog.js';
import { DEFAULT_DEFINITIONS_DIRECTORY } from './definitions-directory.js';

/**
 * Guards the catalog shipped in the repository. If someone edits a sealed file, this test
 * fails with DIGEST_MISMATCH; the fix is a new version, not a new digest.
 */
describe('shipped definitions', () => {
  const load = async () => await new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY).load();

  it('load without issues and every published version is sealed', async () => {
    const snapshot = await load();
    const result = buildCatalogIndex(snapshot);
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(planSeal(snapshot).patches).toEqual([]);
  });

  it('are exactly the definitions of AgentToolPool section 3', async () => {
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    expect(
      catalog
        .list()
        .map((each) => `${each.kind}:${each.id}@${each.version}`)
        .sort(),
    ).toEqual([
      'AGENT:code-viewer@v0.1.0',
      'AGENT:explorer@v0.1.0',
      'AGENT:main@v0.1.0',
      'AGENT:planner@v0.1.0',
      'AGENT:worker@v0.1.0',
      'MODEL:deepseek-flash@v0.1.0',
      'PROMPT:code-viewer-system@v0.1.0',
      'PROMPT:explorer-system@v0.1.0',
      'PROMPT:main-system@v0.1.0',
      'PROMPT:planner-system@v0.1.0',
      'PROMPT:worker-system@v0.1.0',
      'TEMPLATE:analyze@v0.1.0',
      'TOOL:ask-user@v0.1.0',
      'TOOL:edit-file@v0.1.0',
      'TOOL:finish-analysis@v0.1.0',
      'TOOL:finish-explorer@v0.1.0',
      'TOOL:finish-worker@v0.1.0',
      'TOOL:git-inspect@v0.1.0',
      'TOOL:handoff-to-code-viewer@v0.1.0',
      'TOOL:list-files@v0.1.0',
      'TOOL:read-file@v0.1.0',
      'TOOL:read-output@v0.1.0',
      'TOOL:reply@v0.1.0',
      'TOOL:run-command@v0.1.0',
      'TOOL:run-subagents@v0.1.0',
      'TOOL:search-repository@v0.1.0',
      'TOOL:update-todos@v0.1.0',
      'TOOL:web-fetch@v0.1.0',
      'TOOL:web-search@v0.1.0',
      'TOOL:write-file@v0.1.0',
      'UNIT:context-assemble@v0.1.0',
      'UNIT:file-edit@v0.1.0',
      'UNIT:file-read@v0.1.0',
      'UNIT:file-write@v0.1.0',
      'UNIT:git-inspect@v0.1.0',
      'UNIT:message-publish@v0.1.0',
      'UNIT:model-call@v0.1.0',
      'UNIT:output-read@v0.1.0',
      'UNIT:report-publish@v0.1.0',
      'UNIT:repository-list@v0.1.0',
      'UNIT:repository-orient@v0.1.0',
      'UNIT:repository-search@v0.1.0',
      'UNIT:run-command@v0.1.0',
      'UNIT:web-fetch@v0.1.0',
      'UNIT:web-search@v0.1.0',
    ]);
  });

  it('price DeepSeek flash as published on 2026-09-28', async () => {
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    const model = catalog.latest('MODEL', 'deepseek-flash');
    if (model === undefined) throw new Error('deepseek-flash is missing');
    // USD per 1M tokens, off-peak: cache hit / cache miss / output.
    expect(Object.values(model.pricing.offPeak).map((micro) => micro / 1_000_000)).toEqual([
      0.003, 0.15, 0.6,
    ]);
    expect(model.pricing.peak).toMatchObject({
      ratePercent: 200,
      weekdays: [1, 2, 3, 4, 5],
      windows: [
        { start: '01:00', end: '04:00' },
        { start: '06:00', end: '10:00' },
      ],
    });
  });
});
