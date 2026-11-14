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
    // The root of a long task decides by a table and reads a manual of the system, not solved
    // tasks (Orchestration D37, 2026-11-14): how each tool is called, what comes back, what next.
    const guide = mission?.nodes.find((node) => node.kind === 'AGENT' && node.guide !== undefined);
    const text = guide?.kind === 'AGENT' ? (guide.guide ?? '') : '';
    expect(text).toContain('Decisions, by what you see.');
    for (const entry of [
      'run_subagents: parts to build',
      'continues: give a finished part back',
      'sleep: wait without spending anything.',
      'send_message: talk to your subtasks',
      'Background commands:',
      'stop_subagents {names:',
    ])
      expect(text).toContain(entry);
    // Every specialist is in the manual with what to write for it (Orchestration D39), and a
    // general shape of a large task and a counter-example where splitting does not pay are there.
    for (const specialist of ['fixer:', 'reviewer:', 'tester:', 'integrator:', 'researcher:'])
      expect(text).toContain(`\n    ${specialist} `);
    expect(text).not.toContain('sub_mission');
    expect(text).toContain('Shape of a whole large task, in general terms (not a recipe):');
    expect(text).toContain('Counter-example, do not split:');
    // The manual carries placeholders, not the content of solved tasks.
    for (const word of ['Whole task', 'toolchain', 'latexmk', 'HH_', 'run.sh', 'flight'])
      expect(text).not.toContain(word);
    // Every pre-orchestrated template carries several examples of its speciality for its root, the
    // first from a small language toolchain.
    for (const id of ['fix-verify', 'review', 'acceptance', 'integrate', 'research']) {
      const template = catalog.latest('TEMPLATE', id);
      const example = template?.kind === 'TEMPLATE' ? (template.playbook?.example ?? '') : '';
      expect(example).toContain('small language toolchain');
      expect(example).not.toContain('HH_');
      expect(example.match(/^Example \d\./gmu)?.length).toBeGreaterThanOrEqual(3);
    }
  });
});
