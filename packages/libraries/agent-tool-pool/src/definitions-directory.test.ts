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
      'AGENT:lead@v0.1.0',
      'AGENT:main@v0.1.0',
      'AGENT:planner@v0.1.0',
      'AGENT:worker@v0.1.0',
      'MODEL:deepseek-flash@v0.1.0',
      'PROMPT:code-viewer-system@v0.1.0',
      'PROMPT:compaction-system@v0.1.0',
      'PROMPT:explorer-system@v0.1.0',
      'PROMPT:lead-system@v0.1.0',
      'PROMPT:main-system@v0.1.0',
      'PROMPT:planner-system@v0.1.0',
      'PROMPT:worker-system@v0.1.0',
      'TEMPLATE:acceptance@v0.1.0',
      'TEMPLATE:analyze@v0.1.0',
      'TEMPLATE:explore-build@v0.1.0',
      'TEMPLATE:fix-verify@v0.1.0',
      'TEMPLATE:integrate@v0.1.0',
      'TEMPLATE:mission@v0.1.0',
      'TEMPLATE:research@v0.1.0',
      'TEMPLATE:review@v0.1.0',
      'TOOL:ask-user@v0.1.0',
      'TOOL:edit-file@v0.1.0',
      'TOOL:finish-analysis@v0.1.0',
      'TOOL:finish-explorer@v0.1.0',
      'TOOL:finish-worker@v0.1.0',
      'TOOL:git-inspect@v0.1.0',
      'TOOL:handoff-to-code-viewer@v0.1.0',
      'TOOL:job-kill@v0.1.0',
      'TOOL:job-list@v0.1.0',
      'TOOL:job-output@v0.1.0',
      'TOOL:list-external-files@v0.1.0',
      'TOOL:list-files@v0.1.0',
      'TOOL:read-external-file@v0.1.0',
      'TOOL:read-file@v0.1.0',
      'TOOL:read-output@v0.1.0',
      'TOOL:reply@v0.1.0',
      'TOOL:run-command@v0.1.0',
      'TOOL:run-subagents@v0.1.0',
      'TOOL:search-external-repository@v0.1.0',
      'TOOL:search-repository@v0.1.0',
      'TOOL:send-message@v0.1.0',
      'TOOL:sleep@v0.1.0',
      'TOOL:stop-subagents@v0.1.0',
      'TOOL:sub-mission@v0.1.0',
      'TOOL:update-todos@v0.1.0',
      'TOOL:view-tasks@v0.1.0',
      'TOOL:web-fetch@v0.1.0',
      'TOOL:web-search@v0.1.0',
      'TOOL:write-file@v0.1.0',
      'UNIT:context-assemble@v0.1.0',
      'UNIT:external-list@v0.1.0',
      'UNIT:external-read@v0.1.0',
      'UNIT:external-search@v0.1.0',
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
  it('give main and lead the handbook of ways to split work (Phase2Plan 2)', async () => {
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    const promptOf = (id: string) => {
      const prompt = catalog.latest('PROMPT', id);
      if (prompt === undefined) throw new Error(`${id} is missing`);
      return prompt.template;
    };
    const ways = [
      'Fan out and join',
      'Explore, then build',
      'Interface first',
      'Write by section, review as one',
      'Long steps in the background',
      'Correct course',
      'Alone',
    ];
    for (const way of ways) {
      expect(promptOf('main-system')).toContain(`- ${way}:`);
      expect(promptOf('lead-system')).toContain(`- ${way}:`);
    }
    // A lead's subtasks cannot start subtasks: the way of nested leads is main's alone.
    expect(promptOf('main-system')).toContain('- Leads for large parts:');
    expect(promptOf('lead-system')).not.toContain('- Leads for large parts:');
    const mission = catalog.latest('TEMPLATE', 'mission');
    expect(JSON.stringify(mission?.nodes)).toContain('table of decisions');
    // The root of a long task decides by a table, reads short examples of single decisions and
    // two whole tasks (2026-11-14): one done alone, one large system run by plan, check and route.
    const guide = mission?.nodes.find((node) => node.kind === 'AGENT' && node.guide !== undefined);
    const text = guide?.kind === 'AGENT' ? (guide.guide ?? '') : '';
    expect(text).toContain('Decisions, by what you see.');
    expect(text.match(/^[a-j]\) /gmu)).toHaveLength(10);
    expect(text).toContain('Whole task 1. Small enough to do alone.');
    // Three large tasks of different kinds, one of them without code, so that the root does not
    // copy the shape of one example (2026-11-14).
    expect(text).toContain('Whole task 2. A large system built from a specification');
    expect(text).toContain('Whole task 3. One change through a large codebase that exists');
    expect(text).toContain('Whole task 4. An academic paper, from the literature to the PDF');
    // The paper goes the whole way: survey, plan, evidence, drafts, revision, format, PDF.
    for (const stage of [
      '1. Survey.',
      '2. Plan the argument',
      '3. Evidence before prose',
      '4. Draft',
      '5. Revise',
      '6. Format and output',
      'latexmk -pdf',
      'paper/main.pdf',
    ])
      expect(text).toContain(stage);
    expect(text).not.toContain('most of them do not use');
    // Between them the whole tasks use every template, give a defect back to its owner with
    // continues, and show the root changing things itself (D33).
    for (const step of [
      'template: "acceptance"',
      'template: "integrate"',
      'template: "review"',
      'template: "research"',
      'template: "fix-verify"',
      'continues: "back"',
      'continues: "sec-eval"',
      'lang/lexer/scan.py myself',
      'I write the introduction myself, from the outline',
    ])
      expect(text).toContain(step);
    // No example is taken from a task of the evaluation set.
    for (const word of ['HH_', 'run.sh', 'services/', 'logout', 'flight'])
      expect(text).not.toContain(word);
    // Every pre-orchestrated template carries several examples of its speciality, the first from
    // the language toolchain of the second whole task.
    for (const id of [
      'fix-verify',
      'explore-build',
      'review',
      'acceptance',
      'integrate',
      'research',
    ]) {
      const template = catalog.latest('TEMPLATE', id);
      const example = template?.kind === 'TEMPLATE' ? (template.playbook?.example ?? '') : '';
      expect(example).toContain('small language toolchain');
      expect(example).not.toContain('HH_');
      expect(example.match(/^Example \d\./gmu)?.length).toBeGreaterThanOrEqual(3);
    }
  });
});
