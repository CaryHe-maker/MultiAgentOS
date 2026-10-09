import { describe, expect, it } from 'vitest';
import { validate } from '../platform-common/validation.js';
import {
  AgentPinRequestSchema,
  DefinitionLookupSchema,
  PinnedDefinitionSetSchema,
} from './catalog-schemas.js';
import {
  AgentDefinitionSchema,
  DEFINITION_DRAFT_SCHEMAS,
  DEFINITION_KINDS,
  DEFINITION_SCHEMAS,
  DefinitionSchema,
  ModelDefinitionSchema,
  PromptDefinitionSchema,
  ToolDefinitionSchema,
  UnitDefinitionSchema,
  type Definition,
} from './definition-schemas.js';

const digest = 'a'.repeat(64);
const contract = (id: string) => ({ kind: 'contract', id, version: 'v0' }) as const;
const common = { schemaVersion: 'v0', version: 'v1.0.0', digest, description: 'fixture' } as const;

const fixtures = {
  AGENT: {
    ...common,
    kind: 'AGENT',
    id: 'fixture-agent',
    role: 'analyst',
    modelRef: { id: 'fixture-model', version: 'v1.0.0' },
    modelSettings: { thinking: 'DISABLED' },
    promptRef: { id: 'fixture-prompt', version: 'v1.0.0' },
    unitRefs: [{ id: 'fixture-unit', version: 'v1.0.0' }],
    startUnitRefs: [],
    actions: { finish: { toolRef: { id: 'fixture-finish', version: 'v1.0.0' } } },
    limits: { maxRounds: 3, maxToolCallsPerRound: 1 },
  },
  UNIT: {
    ...common,
    kind: 'UNIT',
    id: 'fixture-unit',
    executionKind: 'FILE_READ',
    protectedCapabilities: ['repo.read'],
    inputContract: contract('executor.FileReadInput'),
    outputContract: contract('executor.FileReadOutput'),
    toolRefs: [{ id: 'fixture-tool', version: 'v1.0.0' }],
    effect: 'READ_ONLY',
    isIdempotent: true,
    failurePolicy: { NOT_FOUND: 'RETURN_TO_MODEL' },
  },
  TOOL: {
    ...common,
    kind: 'TOOL',
    id: 'fixture-tool',
    modelName: 'read_file',
    modelDescription: 'Read a file.',
    purpose: 'UNIT',
    parametersContract: contract('executor.FileReadInput'),
    riskClass: 'READ_ONLY',
    sideEffect: 'NONE',
    isIdempotent: true,
    contentStatus: 'PLACEHOLDER',
  },
  MODEL: {
    ...common,
    kind: 'MODEL',
    id: 'fixture-model',
    provider: 'fixture',
    apiModelId: 'fixture-1',
    providerModelLabel: 'Fixture 1',
    apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
    baseUrl: 'https://example.invalid',
    limits: { contextWindowTokens: 1_000, maxOutputTokens: 100 },
    features: {
      hasJsonOutput: true,
      hasToolCalls: true,
      hasVision: false,
      thinking: { isSupported: false, isEnabledByDefault: false, effortLevels: [] },
    },
    pricing: {
      currency: 'USD',
      unit: 'MICRO_USD_PER_MILLION_TOKENS',
      offPeak: { inputCacheHit: 1, inputCacheMiss: 2, output: 3 },
      peak: {
        ratePercent: 200,
        timeZone: 'UTC',
        weekdays: [1, 2, 3, 4, 5],
        windows: [{ start: '01:00', end: '04:00' }],
      },
      source: { url: 'https://example.invalid/pricing', verifiedOn: '2026-09-28' },
    },
  },
  PROMPT: {
    ...common,
    kind: 'PROMPT',
    id: 'fixture-prompt',
    role: 'system',
    template: 'Answer {{question}}.',
    variables: [{ name: 'question', description: 'user question' }],
    contentStatus: 'PLACEHOLDER',
  },
} as const;

describe('catalog definition schemas', () => {
  it.each(DEFINITION_KINDS)('accepts a valid %s definition', (kind) => {
    expect(validate(DEFINITION_SCHEMAS[kind], fixtures[kind])).toEqual({
      ok: true,
      value: fixtures[kind],
    });
    expect(validate(DefinitionSchema, fixtures[kind]).ok).toBe(true);
  });

  it.each(DEFINITION_KINDS)('accepts a %s draft only without digest', (kind) => {
    const draft: Record<string, unknown> = { ...fixtures[kind] };
    delete draft['digest'];
    expect(validate(DEFINITION_DRAFT_SCHEMAS[kind], draft).ok).toBe(true);
    expect(validate(DEFINITION_SCHEMAS[kind], draft).ok).toBe(false);
    expect(validate(DEFINITION_DRAFT_SCHEMAS[kind], { ...draft, extra: 1 }).ok).toBe(false);
  });

  it.each(DEFINITION_KINDS)('rejects undeclared fields in %s', (kind) => {
    expect(validate(DEFINITION_SCHEMAS[kind], { ...fixtures[kind], metadata: {} }).ok).toBe(false);
  });

  it('rejects a definition whose kind does not match its body', () => {
    expect(validate(DefinitionSchema, { ...fixtures.TOOL, kind: 'MODEL' }).ok).toBe(false);
  });

  it.each([
    ['version without v prefix', { version: '1.0.0' }],
    ['partial version', { version: 'v1.0' }],
    ['leading zero version', { version: 'v01.0.0' }],
    ['upper-case id', { id: 'Fixture-Tool' }],
    ['short digest', { digest: 'abc' }],
    ['upper-case digest', { digest: 'A'.repeat(64) }],
  ])('rejects %s', (_label, patch) => {
    expect(validate(ToolDefinitionSchema, { ...fixtures.TOOL, ...patch }).ok).toBe(false);
  });

  it('keeps model prices integral and peak rules well-formed', () => {
    const withPrice = (price: number) => ({
      ...fixtures.MODEL,
      pricing: {
        ...fixtures.MODEL.pricing,
        offPeak: { ...fixtures.MODEL.pricing.offPeak, output: price },
      },
    });
    expect(validate(ModelDefinitionSchema, withPrice(0.6)).ok).toBe(false);
    expect(validate(ModelDefinitionSchema, withPrice(-1)).ok).toBe(false);
    const withPeak = (peak: object) => ({
      ...fixtures.MODEL,
      pricing: { ...fixtures.MODEL.pricing, peak: { ...fixtures.MODEL.pricing.peak, ...peak } },
    });
    expect(validate(ModelDefinitionSchema, withPeak({ ratePercent: 50 })).ok).toBe(false);
    expect(validate(ModelDefinitionSchema, withPeak({ weekdays: [0] })).ok).toBe(false);
    const withSource = (verifiedOn: string) => ({
      ...fixtures.MODEL,
      pricing: {
        ...fixtures.MODEL.pricing,
        source: { ...fixtures.MODEL.pricing.source, verifiedOn },
      },
    });
    expect(validate(ModelDefinitionSchema, withSource('2026-13-40')).ok).toBe(false);
    expect(
      validate(ModelDefinitionSchema, withPeak({ windows: [{ start: '24:00', end: '25:00' }] })).ok,
    ).toBe(false);
  });

  it('forbids duplicate references in closed sets', () => {
    const ref = { id: 'fixture-unit', version: 'v1.0.0' };
    expect(validate(AgentDefinitionSchema, { ...fixtures.AGENT, unitRefs: [ref, ref] }).ok).toBe(
      false,
    );
    expect(validate(AgentDefinitionSchema, { ...fixtures.AGENT, unitRefs: [] }).ok).toBe(false);
    expect(validate(UnitDefinitionSchema, { ...fixtures.UNIT, toolRefs: [] }).ok).toBe(true);
  });

  it('only allows system prompts in M1', () => {
    expect(validate(PromptDefinitionSchema, { ...fixtures.PROMPT, role: 'user' }).ok).toBe(false);
  });

  it('narrows the union by kind', () => {
    const definition: Definition = fixtures.MODEL;
    if (definition.kind === 'MODEL') expect(definition.pricing.currency).toBe('USD');
  });
});

describe('catalog lookup and pinning schemas', () => {
  it('requires an exact version for lookups', () => {
    const lookup = { kind: 'TOOL', id: 'fixture-tool', version: 'v1.0.0' };
    expect(validate(DefinitionLookupSchema, lookup).ok).toBe(true);
    expect(validate(DefinitionLookupSchema, { ...lookup, version: 'latest' }).ok).toBe(false);
    expect(validate(DefinitionLookupSchema, { ...lookup, kind: 'CONTRACT' }).ok).toBe(false);
    expect(validate(AgentPinRequestSchema, { id: 'fixture-agent' }).ok).toBe(false);
  });

  it('accepts a pinned set that survives a JSON round trip', () => {
    const ref = (kind: keyof typeof fixtures) => ({
      kind,
      id: fixtures[kind].id,
      version: 'v1.0.0',
      digest,
    });
    const pinned = {
      schemaVersion: 'v0',
      agent: fixtures.AGENT,
      model: fixtures.MODEL,
      prompt: fixtures.PROMPT,
      units: [fixtures.UNIT],
      tools: [fixtures.TOOL],
      refs: DEFINITION_KINDS.map(ref),
    };
    const roundTripped: unknown = JSON.parse(JSON.stringify(pinned));
    expect(validate(PinnedDefinitionSetSchema, roundTripped)).toEqual({ ok: true, value: pinned });
  });
});
