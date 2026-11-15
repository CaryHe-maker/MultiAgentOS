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
      'AGENT:explorer@v0.1.0',
      'AGENT:lead@v0.1.0',
      'AGENT:main@v0.1.0',
      'AGENT:worker@v0.1.0',
      'MODEL:deepseek-flash@v0.1.0',
      'PROMPT:compaction-system@v0.1.0',
      'PROMPT:explorer-system@v0.1.0',
      'PROMPT:lead-system@v0.1.0',
      'PROMPT:main-system@v0.1.0',
      'PROMPT:worker-system@v0.1.0',
      'TEMPLATE:acceptance@v0.1.0',
      'TEMPLATE:fix-verify@v0.1.0',
      'TEMPLATE:integrate@v0.1.0',
      'TEMPLATE:mission@v0.1.0',
      'TEMPLATE:research@v0.1.0',
      'TEMPLATE:review@v0.1.0',
      'TOOL:ask-user@v0.1.0',
      'TOOL:edit-file@v0.1.0',
      'TOOL:finish-explorer@v0.1.0',
      'TOOL:finish-worker@v0.1.0',
      'TOOL:git-inspect@v0.1.0',
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
      'UNIT:repository-list@v0.1.0',
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
  it('let every Agent that starts tasks start every Agent it may name (2026-11-14)', async () => {
    // A task can do no more than its parent (Kernel: CAPABILITY_NOT_SUBSET), so an Agent offered
    // to a spawner but beyond its capabilities can never be started: a lead could not start the
    // explorers of the reviewer's and the researcher's playbooks.
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    const definitions = catalog.list();
    const agents = definitions.flatMap((each) => (each.kind === 'AGENT' ? [each] : []));
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const spawnable = agents.filter((agent) => agent.spawnable !== undefined);
    const missing = (parent: string, child: string): string[] => {
      const has = new Set(byId.get(parent)?.capabilities ?? []);
      return (byId.get(child)?.capabilities ?? []).filter((capability) => !has.has(capability));
    };
    const gaps: string[] = [];
    for (const spawner of agents.filter((agent) => agent.actions.spawn !== undefined))
      for (const child of spawnable) {
        const lacking = missing(spawner.id, child.id);
        if (lacking.length > 0) gaps.push(`${spawner.id} -> ${child.id}: ${lacking.join(', ')}`);
      }
    // A specialist is a lead that starts the Agents of its playbook's phases.
    for (const template of definitions) {
      if (template.kind !== 'TEMPLATE' || template.playbook === undefined) continue;
      for (const phase of template.playbook.phases) {
        if (phase.tasks === undefined) continue;
        const lacking = missing('lead', phase.tasks.agent);
        if (lacking.length > 0)
          gaps.push(`${template.id}/${phase.name} -> ${phase.tasks.agent}: ${lacking.join(', ')}`);
      }
    }
    expect(gaps).toEqual([]);
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
    // A short list of ways, as dsh and other agents keep it (D68): the system keeps the rules.
    for (const way of ['Fan out and join', 'Explore, then build', 'Alone']) {
      expect(promptOf('main-system')).toContain(`- ${way}:`);
      expect(promptOf('lead-system')).toContain(`- ${way}:`);
    }
    expect(promptOf('lead-system')).toContain('- Interface first:');
    // Prompts stay short (D68): the check is the project's own, at the strength the task needs.
    for (const id of ['main-system', 'lead-system', 'worker-system', 'explorer-system'])
      expect(promptOf(id).length).toBeLessThan(4500);
    expect(promptOf('worker-system')).toContain('do not build extra test harnesses');
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
    expect(text).toContain('Counter-example, do not split:');
    // The goal tells the root what the system is for and how it is judged.
    expect(JSON.stringify(mission?.nodes)).toContain('judged by how soon the goal is delivered');
    // The manual is short and asks for no more checking than the project's own (D68).
    expect(text.length).toBeLessThan(5000);
    expect(text).toContain('do not run them again');
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
