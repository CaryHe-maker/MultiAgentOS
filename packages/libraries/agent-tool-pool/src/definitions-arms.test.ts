import { createProtocolRegistry } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { FileDefinitionSource } from './adapters/file/file-definition-source.js';
import { OverlayDefinitionSource } from './adapters/file/overlay-definition-source.js';
import { DefinitionCatalog, buildCatalogIndex } from './catalog/catalog.js';
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DEFINITION_ARM_DIRECTORIES,
} from './definitions-directory.js';

/** Criteria in any form, but not "acceptance tests", which are tests of a specification. */
const CRITERIA = /acceptance(?! tests)|criteri/iu;

describe('the comparison arm without criteria (Orchestration D81)', () => {
  const source = () =>
    new OverlayDefinitionSource(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
      new FileDefinitionSource(DEFINITION_ARM_DIRECTORIES['no-acceptance']),
    );

  it('loads without issues, with the same definitions as the catalog', async () => {
    const snapshot = await source().load();
    const result = buildCatalogIndex(snapshot);
    expect(result.ok ? [] : result.issues).toEqual([]);
    const ids = async (catalog: DefinitionCatalog) =>
      catalog
        .list()
        .map((each) => `${each.kind}:${each.id}@${each.version}`)
        .sort();
    expect(await ids(await DefinitionCatalog.load(source()))).toEqual(
      await ids(
        await DefinitionCatalog.load(new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY)),
      ),
    );
  });

  it('shows no agent a criterion: prompts, tool descriptions, the manual and the parameters', async () => {
    const catalog = await DefinitionCatalog.load(source());
    const registry = createProtocolRegistry();
    for (const definition of catalog.list()) {
      // The tester's playbook is about acceptance tests and the reviewer's reviews against the
      // criteria it is given: their own methods, not criteria set for the tasks they start.
      if (
        definition.kind === 'TEMPLATE' &&
        (definition.id === 'acceptance' || definition.id === 'review')
      )
        continue;
      if (definition.kind === 'PROMPT') expect(definition.template).not.toMatch(CRITERIA);
      if (definition.kind === 'TOOL') {
        expect(definition.modelDescription).not.toMatch(CRITERIA);
        const parameters = registry.resolveContract(definition.parametersContract);
        expect(JSON.stringify(parameters)).not.toMatch(/"acceptance"/u);
      }
      if (definition.kind === 'TEMPLATE') expect(JSON.stringify(definition)).not.toMatch(CRITERIA);
    }
  });
});

describe('the comparison arm with the original whole examples (Orchestration D83)', () => {
  const load = async (arm?: 'few-shot') =>
    await DefinitionCatalog.load(
      arm === undefined
        ? new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY)
        : new OverlayDefinitionSource(
            new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
            new FileDefinitionSource(DEFINITION_ARM_DIRECTORIES[arm]),
          ),
    );
  /** The text of every node of the Mission template, without what the catalog adds (its digest). */
  const nodesOf = async (arm?: 'few-shot') => {
    const mission = (await load(arm)).latest('TEMPLATE', 'mission');
    return JSON.stringify(mission?.nodes);
  };

  it('is the manual of the catalog with the examples added, and nothing else changed', async () => {
    const base = await nodesOf();
    const arm = await nodesOf('few-shot');
    const examples = arm.slice(
      arm.indexOf('Whole examples of how'),
      arm.indexOf('Counter-example'),
    );
    expect(examples).toContain('agent: \\"lead\\"');
    expect(arm.replace(examples, '')).toBe(base);
  });
});
