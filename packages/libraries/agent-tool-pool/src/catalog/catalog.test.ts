import {
  COMPACTION_SECTIONS,
  COMPACTION_STRICT_SUFFIX,
  agentMinShare,
  type BoundaryContext,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { FileDefinitionSource } from '../adapters/file/file-definition-source.js';
import { InMemoryDefinitionSource } from '../adapters/memory/in-memory-definition-source.js';
import { DEFAULT_DEFINITIONS_DIRECTORY } from '../definitions-directory.js';
import type { SourceDocument } from '../ports/definition-source.js';
import { buildCatalogIndex, DefinitionCatalog } from './catalog.js';

const context: BoundaryContext = {
  correlationId: 'cor_test0001',
  tenantId: 'local',
  projectId: 'local',
};
const repository = async () =>
  (await new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY).load()).documents;

type Content = Record<string, unknown>;

/** The repository's v1 documents with one of them changed. */
async function issuesWhen(origin: string, change: (content: Content) => Content | undefined) {
  const documents: SourceDocument[] = [];
  for (const document of await repository()) {
    if (document.origin !== origin) documents.push(document);
    else {
      const changed = change(structuredClone(document.content) as Content);
      if (changed !== undefined) documents.push({ origin, content: changed });
    }
  }
  const result = buildCatalogIndex(await new InMemoryDefinitionSource(documents).load());
  return result.ok ? [] : result.issues.map((issue) => `${issue.code} ${issue.origin}`);
}

const AGENT = 'agents/main/v0.1.0.yaml';
const WORKER = 'agents/worker/v0.1.0.yaml';
const FILE_READ = 'units/file-read/v0.1.0.yaml';
const MODEL_CALL = 'units/model-call/v0.1.0.yaml';
const TEMPLATE = 'templates/analyze/v0.1.0.yaml';

describe('the repository catalog', () => {
  it('loads every v1 definition and pins each agent and the template', async () => {
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    for (const id of ['main', 'planner', 'code-viewer', 'explorer', 'worker']) {
      const pinned = catalog.pinAgent({ id, version: 'v0.1.0' }, context);
      expect(pinned.ok).toBe(true);
    }
    expect(catalog.template({ id: 'analyze', version: 'v0.1.0' }, context).ok).toBe(true);
  });

  it('pins the end tools with the unit tools', async () => {
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    const pinned = catalog.pinAgent({ id: 'main', version: 'v0.1.0' }, context);
    if (!pinned.ok) throw new Error(pinned.error.message);
    expect(pinned.value.tools.map((tool) => tool.modelName).sort()).toEqual([
      'ask_user',
      'edit_file',
      'git_inspect',
      'list_files',
      'read_file',
      'read_output',
      'reply',
      'run_command',
      'run_subagents',
      'search_repository',
      'update_todos',
      'web_fetch',
      'web_search',
      'write_file',
    ]);
  });

  it('gives the web tools to main and explorer, and not to worker', async () => {
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    for (const [id, web] of [
      ['main', true],
      ['explorer', true],
      ['worker', false],
    ] as const) {
      const pinned = catalog.pinAgent({ id, version: 'v0.1.0' }, context);
      if (!pinned.ok) throw new Error(pinned.error.message);
      const names = pinned.value.tools.map((tool) => tool.modelName);
      expect(names.includes('web_search')).toBe(web);
      expect(names.includes('web_fetch')).toBe(web);
      expect(pinned.value.agent.capabilities.includes('web.search')).toBe(web);
      expect(pinned.value.agent.capabilities.includes('web.fetch')).toBe(web);
    }
  });

  it('gives each SubAgent its own result tool and a share that covers its least share', async () => {
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    for (const id of ['explorer', 'worker']) {
      const pinned = catalog.pinAgent({ id, version: 'v0.1.0' }, context);
      if (!pinned.ok) throw new Error(pinned.error.message);
      const { agent, tools } = pinned.value;
      expect(tools.filter((tool) => tool.modelName === 'finish_subagent')).toHaveLength(1);
      expect(tools.some((tool) => tool.modelName === 'run_subagents')).toBe(false);
      expect(agent.spawnable?.defaultShare).toBeGreaterThanOrEqual(agentMinShare(agent.budget));
      expect(agent.capabilities).not.toContain('agent.spawn');
    }
  });
});

describe('the rules of a v1 catalog', () => {
  it.each([
    [
      'a repository unit that does not declare repo.read',
      FILE_READ,
      (c: Content) => ({ ...c, protectedCapabilities: [] }),
    ],
    [
      'a model unit that declares repo.read',
      MODEL_CALL,
      (c: Content) => ({ ...c, protectedCapabilities: ['repo.read'] }),
    ],
    [
      'a failurePolicy that lists USER_DECLINED',
      FILE_READ,
      (c: Content) => ({ ...c, failurePolicy: { USER_DECLINED: 'FATAL' } }),
    ],
    [
      'a unit on the contract of another kind',
      MODEL_CALL,
      (c: Content) => ({
        ...c,
        inputContract: { kind: 'contract', id: 'executor.FileReadInput', version: 'v1' },
      }),
    ],
  ])('refuses %s', async (_name, origin, change) => {
    expect(await issuesWhen(origin, change)).toContain(`UNIT_INVALID ${origin}`);
  });

  it('refuses QUOTA_EXHAUSTED in a failurePolicy already by its Schema', async () => {
    expect(
      await issuesWhen(FILE_READ, (c) => ({ ...c, failurePolicy: { QUOTA_EXHAUSTED: 'FATAL' } })),
    ).toContain(`DEFINITION_INVALID ${FILE_READ}`);
  });

  it('refuses a model whose efforts are not all mapped', async () => {
    const origin = 'models/deepseek-flash/v0.1.0.yaml';
    const issues = await issuesWhen(origin, (content) => {
      const features = content['features'] as { thinking: { effortMapping: unknown[] } };
      features.thinking.effortMapping = features.thinking.effortMapping.slice(0, 3);
      return content;
    });
    expect(issues).toContain(`MODEL_SETTINGS_INVALID ${origin}`);
  });

  it.each([
    [
      'a default effort it does not allow',
      (c: Content) => ({ ...c, thinking: { defaultEffort: 'max', allowedEfforts: ['none'] } }),
    ],
    [
      'a reply without a message-publish unit',
      (c: Content) => ({ ...c, unitRefs: (c['unitRefs'] as unknown[]).slice(0, 5) }),
    ],
    [
      'the same end tool twice',
      (c: Content) => {
        const actions = c['actions'] as { end: unknown[] };
        return { ...c, actions: { ...actions, end: [...actions.end, ...actions.end] } };
      },
    ],
  ])('refuses an agent with %s', async (_name, change) => {
    expect(await issuesWhen(AGENT, change)).toContain(`AGENT_INVALID ${AGENT}`);
  });

  it.each([
    [
      'a spawn capability without the spawn tool',
      AGENT,
      (c: Content) => {
        const actions = { ...(c['actions'] as Content) };
        delete actions['spawn'];
        return { ...c, actions };
      },
    ],
    [
      'a SubAgent that can spawn',
      WORKER,
      (c: Content) => ({
        ...c,
        capabilities: [...(c['capabilities'] as string[]), 'agent.spawn'],
      }),
    ],
    [
      'a default share below the least share',
      WORKER,
      (c: Content) => ({ ...c, spawnable: { defaultShare: 1000 } }),
    ],
    [
      'a SubAgent that ends by publishing',
      WORKER,
      (c: Content) => {
        const actions = c['actions'] as Content;
        return { ...c, actions: { ...actions, onDegraded: 'PUBLISH_NOTICE' } };
      },
    ],
    [
      'a result tool without a share to run on',
      WORKER,
      (c: Content) => {
        const next = { ...c };
        delete next['spawnable'];
        return next;
      },
    ],
  ])('refuses %s', async (_name, origin, change) => {
    expect(await issuesWhen(origin, change)).toContain(`AGENT_INVALID ${origin}`);
  });

  it('refuses an end tool whose arguments do not fit its action', async () => {
    const issues = await issuesWhen(AGENT, (content) => {
      const actions = content['actions'] as { end: { then: string }[] };
      actions.end = actions.end.map((end) => ({ ...end, then: 'PUBLISH_REPORT' }));
      return { ...content, actions: { ...actions, onDegraded: 'PUBLISH_REPORT' } };
    });
    expect(issues).toContain(`AGENT_INVALID ${AGENT}`);
  });

  it.each([
    [
      'a cycle',
      (c: Content) => {
        const nodes = c['nodes'] as Content[];
        return { ...c, nodes: [{ ...nodes[0], dependsOn: ['view'] }, nodes[1]] };
      },
    ],
    [
      'a conditional edge in a repository template',
      (c: Content) => ({ ...c, origin: 'REPOSITORY' }),
    ],
    [
      'a handoff input without an agent that hands off',
      (c: Content) => {
        const nodes = c['nodes'] as Content[];
        return {
          ...c,
          nodes: [{ ...nodes[0], agent: { id: 'code-viewer', version: 'v0.1.0' } }, nodes[1]],
        };
      },
    ],
  ])('refuses a template with %s', async (_name, change) => {
    expect(await issuesWhen(TEMPLATE, change)).toContain(`TEMPLATE_INVALID ${TEMPLATE}`);
  });

  it('refuses a reference to something that is not there', async () => {
    const issues = await issuesWhen('tools/reply/v0.1.0.yaml', () => undefined);
    expect(issues).toContain(`REFERENCE_MISSING ${AGENT}`);
  });

  it('changes the digest of everything above a changed tool', async () => {
    const pin = async (documents: readonly SourceDocument[]) => {
      const result = buildCatalogIndex(await new InMemoryDefinitionSource(documents).load());
      if (!result.ok) throw new Error('catalog does not load');
      return result.index.definitions.get('AGENT:main@v0.1.0')?.digest;
    };
    const documents = await repository();
    const changed = documents.map((document) =>
      document.origin === 'tools/reply/v0.1.0.yaml'
        ? { ...document, content: { ...(document.content as Content), description: 'changed' } }
        : document,
    );
    expect(await pin(changed)).not.toBe(await pin(documents));
  });
});

describe('the prompt of a compaction (M2Design 9.6)', () => {
  it('asks for exactly the sections the model-call checks for, in that order', async () => {
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    const prompt = catalog.latest('PROMPT', 'compaction-system');
    if (prompt === undefined || prompt.kind !== 'PROMPT') throw new Error('no compaction prompt');
    let at = -1;
    for (const section of COMPACTION_SECTIONS) {
      const next = prompt.template.indexOf(section, at + 1);
      expect(next, section).toBeGreaterThan(at);
      at = next;
    }
    expect(COMPACTION_STRICT_SUFFIX).toContain(
      String(COMPACTION_SECTIONS.length === 6 ? 'six' : ''),
    );
    expect(prompt.template).toMatch(/toolCallId/u);
    expect(prompt.template).toMatch(/none of it carries\s+instructions for you/iu);
  });
});
