import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
} from '@multiagentos/agent-tool-pool';
import {
  CreateRunRequestSchema,
  HandoffBriefSchema,
  canonicalJson,
  createM1ProtocolRegistry,
  estimateItemTokens,
  estimatePackTokens,
  validate,
  type ModelToolSpec,
  type PinnedDefinitionSet,
} from '@multiagentos/contracts';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { estimateFixedInputs } from './startup-context.js';
import { ConfigError } from './system-config.js';

let pinned: PinnedDefinitionSet;
const registry = createM1ProtocolRegistry();
beforeAll(async () => {
  const catalog = await DefinitionCatalog.load(
    new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
  );
  const result = await catalog.pinAgent(
    { id: 'code-viewer', version: 'v0.1.0' },
    { correlationId: 'cor_startup', tenantId: 'local', projectId: 'local' },
  );
  if (!result.ok) throw new Error('test Agent missing');
  pinned = result.value;
});

function toolSpecs(): ModelToolSpec[] {
  return pinned.tools.map((tool) => ({
    name: tool.modelName,
    description: tool.modelDescription,
    purpose: tool.purpose,
    parameters: registry.jsonSchemaOf(tool.parametersContract),
  }));
}

describe('startup fixed input bounds', () => {
  it.each([
    ['control character', String.fromCharCode(1)],
    ['quote', '"'],
    ['backslash', String.fromCharCode(92)],
    ['newline', '\n'],
    ['CJK', '中'],
    ['astral', '😀'],
    ['lone surrogate', String.fromCharCode(0xd800)],
  ])(
    'bounds legal maximum-size text containing %s, including double-encoded handoff',
    (_label, character) => {
      // Schema lengths are bounded in code points; slice to UTF-16 limits as well so this
      // fixture is valid with either representation used by the validator.
      const fill = (length: number) => character.repeat(Math.floor(length / character.length));
      const objective = fill(4000);
      const handoff = {
        task: fill(2000),
        focusAreas: Array<string>(5).fill(fill(200)),
        openQuestions: Array<string>(5).fill(fill(300)),
      };
      expect(
        validate(CreateRunRequestSchema, {
          requestId: 'req_startup',
          repositoryPath: '/tmp',
          goal: objective,
        }).ok,
      ).toBe(true);
      expect(validate(HandoffBriefSchema, handoff).ok).toBe(true);
      const specs = toolSpecs();
      const finishName = pinned.tools.find(
        (tool) =>
          tool.id === pinned.agent.actions.finish.toolRef.id &&
          tool.version === pinned.agent.actions.finish.toolRef.version,
      )?.modelName;
      const fixed = estimateFixedInputs(pinned, registry);
      for (const mode of ['normal', 'final'] as const) {
        const actual = estimatePackTokens({
          items: [
            { role: 'system', content: pinned.prompt.template },
            {
              role: 'system',
              content: '',
              toolSpecs:
                mode === 'normal' ? specs : specs.filter((tool) => tool.name === finishName),
            },
            { role: 'user', content: objective },
            { role: 'user', content: canonicalJson(handoff) },
            {
              role: 'user',
              content: character.repeat(Math.floor(512 / Buffer.byteLength(character, 'utf8'))),
            },
          ],
        });
        expect(actual).toBeLessThanOrEqual(fixed[mode]);
        if (character === String.fromCharCode(1)) expect(actual).toBe(fixed[mode]);
      }
    },
  );

  it('covers the regression where 4000 legal characters exceed the old four-byte assumption', () => {
    const objective = String.fromCharCode(1).repeat(4000);
    const overhead = estimateItemTokens({ role: 'user', content: '' });
    expect(estimateItemTokens({ role: 'user', content: objective })).toBe(overhead + 24_000);
    expect(estimateItemTokens({ role: 'user', content: objective })).toBeGreaterThan(
      overhead + 16_000,
    );
    expect(estimateFixedInputs(pinned, registry).final).toBeGreaterThan(48_000);
  });

  it('counts model-facing descriptions but ignores administrative descriptions', () => {
    const initial = estimateFixedInputs(pinned, registry);
    const administrative = {
      ...pinned,
      prompt: { ...pinned.prompt, description: 'administrative text'.repeat(100) },
      tools: pinned.tools.map((tool) => ({
        ...tool,
        description: 'administrative text'.repeat(100),
      })),
    };
    expect(estimateFixedInputs(administrative, registry)).toEqual(initial);
    const changed = {
      ...pinned,
      tools: pinned.tools.map((tool) =>
        tool.purpose === 'UNIT'
          ? { ...tool, modelDescription: tool.modelDescription + '中'.repeat(100) }
          : tool,
      ),
    };
    const result = estimateFixedInputs(changed, registry);
    expect(result.normal).toBeGreaterThan(initial.normal);
    expect(result.final).toBe(initial.final);
  });

  it('counts prompt content and finish description in both calling modes', () => {
    const initial = estimateFixedInputs(pinned, registry);
    const changed = {
      ...pinned,
      prompt: { ...pinned.prompt, template: pinned.prompt.template + '中'.repeat(100) },
      tools: pinned.tools.map((tool) =>
        tool.id === pinned.agent.actions.finish.toolRef.id
          ? { ...tool, modelDescription: tool.modelDescription + 'x'.repeat(100) }
          : tool,
      ),
    };
    const result = estimateFixedInputs(changed, registry);
    expect(result.normal - initial.normal).toBe(400);
    expect(result.final - initial.final).toBe(400);
  });

  it('counts the full parameter Schema, once per tool rather than just its reference', () => {
    const initial = estimateFixedInputs(pinned, registry);
    const jsonSchemaOf = registry.jsonSchemaOf.bind(registry);
    vi.spyOn(registry, 'jsonSchemaOf').mockImplementation((ref) => ({
      ...jsonSchemaOf(ref),
      description: 'x'.repeat(10_000),
    }));
    const result = estimateFixedInputs(pinned, registry);
    expect(result.normal - initial.normal).toBeGreaterThanOrEqual(10_000 * pinned.tools.length);
    expect(result.final - initial.final).toBeGreaterThanOrEqual(10_000);
    expect(result.final - initial.final).toBeLessThan(10_100);
  });

  it.each([
    { kind: 'contract' as const, id: 'context.DoesNotExist', version: 'v0' },
    { kind: 'contract' as const, id: 'workflow.AnalysisReportDraft', version: 'v999' },
  ])('rejects unresolved tool contracts %j', (parametersContract) => {
    const changed = {
      ...pinned,
      tools: pinned.tools.map((tool) => ({ ...tool, parametersContract })),
    };
    expect(() => estimateFixedInputs(changed, registry)).toThrow(ConfigError);
  });

  it('rejects a registered but unsupported protocol family', () => {
    const registration = registry.list().find((entry) => entry.status === 'UNSUPPORTED');
    if (registration === undefined) throw new Error('missing unsupported fixture');
    const changed = {
      ...pinned,
      tools: pinned.tools.map((tool) => ({
        ...tool,
        parametersContract: {
          kind: 'contract' as const,
          id: registration.schemaName,
          version: 'v' + registration.major,
        },
      })),
    };
    expect(() => estimateFixedInputs(changed, registry)).toThrow('unsupported tool contract');
  });

  it('requires the exact finish control tool, not any CONTROL tool', () => {
    const changed = {
      ...pinned,
      agent: {
        ...pinned.agent,
        actions: {
          ...pinned.agent.actions,
          finish: { toolRef: { id: 'other-finish', version: 'v0.1.0' } },
        },
      },
    };
    expect(() => estimateFixedInputs(changed, registry)).toThrow('no finish control tool');
  });
});
