import { describe, expect, it } from 'vitest';
import {
  CATALOG_ERROR_CODES,
  PinnedDefinitionSetSchema,
  validate,
  type BoundaryContext,
  type DefinitionLookup,
} from '@multiagentos/contracts';
import { InMemoryDefinitionSource } from '../adapters/memory/in-memory-definition-source.js';
import type { SourceDocument } from '../ports/definition-source.js';
import { draftDocuments, patchDocument } from '../test-support/definition-fixtures.js';
import { planSeal } from './catalog-index.js';
import { DefinitionCatalog } from './definition-catalog.js';

const context: BoundaryContext = {
  correlationId: 'cor_123456',
  tenantId: 'local',
  projectId: 'fixture',
};

function sealedDocuments(): SourceDocument[] {
  const documents = draftDocuments();
  const plan = planSeal({ documents, issues: [] });
  const digests = new Map(plan.patches.map((patch) => [patch.origin, patch.digest]));
  return documents.map((document) =>
    patchDocument(document, { digest: digests.get(document.origin) }),
  );
}

async function catalogWith(statusEntries: readonly object[] = []): Promise<DefinitionCatalog> {
  const status = {
    origin: 'status.yaml',
    content: { schemaVersion: 'v0', entries: statusEntries },
  };
  return await DefinitionCatalog.load(new InMemoryDefinitionSource(sealedDocuments(), status));
}

const agent = { id: 'analysis-agent', version: 'v1.0.0' } as const;

describe('DefinitionCatalog.getDefinition', () => {
  it('returns the exact version with a typed, frozen value', async () => {
    const catalog = await catalogWith();
    const result = await catalog.getDefinition(
      { kind: 'MODEL', id: 'test-model', version: 'v1.0.0' },
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `result.value` is typed as ModelDefinition because the lookup kind is 'MODEL'.
    expect(result.value.pricing.offPeak.output).toBe(3);
    expect(Object.isFrozen(result.value.pricing)).toBe(true);
  });

  it.each<[string, DefinitionLookup, string, string]>([
    [
      'unknown ids',
      { kind: 'TOOL', id: 'missing', version: 'v1.0.0' },
      CATALOG_ERROR_CODES.definitionNotFound,
      'VALIDATION',
    ],
    [
      'unknown versions',
      { kind: 'TOOL', id: 'read-file', version: 'v9.0.0' },
      CATALOG_ERROR_CODES.versionNotFound,
      'VALIDATION',
    ],
    [
      'the right id under the wrong kind',
      { kind: 'MODEL', id: 'read-file', version: 'v1.0.0' },
      CATALOG_ERROR_CODES.definitionNotFound,
      'VALIDATION',
    ],
    [
      'invalid lookups',
      { kind: 'TOOL', id: 'read-file', version: 'latest' },
      CATALOG_ERROR_CODES.lookupInvalid,
      'VALIDATION',
    ],
  ])('returns a structured error for %s', async (_label, lookup, code, category) => {
    const result = await (await catalogWith()).getDefinition(lookup, context);
    expect(result).toMatchObject({
      ok: false,
      error: { code, category, retryable: false, correlationId: context.correlationId },
    });
  });

  it('lists available versions when only the version is wrong', async () => {
    const result = await (
      await catalogWith()
    ).getDefinition({ kind: 'TOOL', id: 'read-file', version: 'v9.0.0' }, context);
    expect(result.ok ? '' : result.error.message).toContain('available: v1.0.0');
  });

  it('blocks QUARANTINED and REVOKED versions but serves DEPRECATED ones', async () => {
    const entry = (status: string) => ({
      kind: 'TOOL',
      id: 'read-file',
      version: 'v1.0.0',
      status,
      reason: 'test',
    });
    const lookup = { kind: 'TOOL', id: 'read-file', version: 'v1.0.0' } as const;
    for (const status of ['QUARANTINED', 'REVOKED']) {
      const result = await (await catalogWith([entry(status)])).getDefinition(lookup, context);
      expect(result).toMatchObject({
        ok: false,
        error: { code: CATALOG_ERROR_CODES.definitionUnavailable, category: 'POLICY' },
      });
    }
    const deprecated = await (
      await catalogWith([entry('DEPRECATED')])
    ).getDefinition(lookup, context);
    expect(deprecated.ok).toBe(true);
  });
});

describe('DefinitionCatalog.pinAgent', () => {
  it('pins the whole closure as a frozen, JSON-safe set', async () => {
    const result = await (await catalogWith()).pinAgent(agent, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pinned = result.value;
    expect(pinned.refs.map((ref) => `${ref.kind}:${ref.id}`)).toEqual([
      'AGENT:analysis-agent',
      'MODEL:test-model',
      'PROMPT:analysis',
      'UNIT:context-assemble',
      'UNIT:file-read',
      'UNIT:model-call',
      'UNIT:report-publish',
      'TOOL:finish-analysis',
      'TOOL:read-file',
    ]);
    expect(pinned.handoffTargetRef).toBeUndefined();
    expect(pinned.refs.find((ref) => ref.kind === 'AGENT')?.digest).toBe(pinned.agent.digest);
    expect(Object.isFrozen(pinned)).toBe(true);
    expect(Object.isFrozen(pinned.refs)).toBe(true);
    const roundTripped: unknown = JSON.parse(JSON.stringify(pinned));
    expect(validate(PinnedDefinitionSetSchema, roundTripped)).toEqual({ ok: true, value: pinned });
  });

  it('is deterministic for the same catalog', async () => {
    const first = await (await catalogWith()).pinAgent(agent, context);
    const second = await (await catalogWith()).pinAgent(agent, context);
    expect(first).toEqual(second);
  });

  it('keeps a pinned set unchanged when a new catalog is loaded later', async () => {
    const before = await (await catalogWith()).pinAgent(agent, context);
    const later = await catalogWith([
      { kind: 'TOOL', id: 'read-file', version: 'v1.0.0', status: 'REVOKED', reason: 'test' },
    ]);
    expect(before.ok && before.value.tools.map((tool) => tool.id)).toContain('read-file');
    expect((await later.pinAgent(agent, context)).ok).toBe(false);
  });

  it('refuses to pin when any member is blocked', async () => {
    const catalog = await catalogWith([
      { kind: 'TOOL', id: 'read-file', version: 'v1.0.0', status: 'REVOKED', reason: 'test' },
    ]);
    const result = await catalog.pinAgent(agent, context);
    expect(result).toMatchObject({
      ok: false,
      error: { code: CATALOG_ERROR_CODES.definitionUnavailable },
    });
    expect(result.ok ? '' : result.error.message).toContain('cannot pin analysis-agent@v1.0.0');
  });

  it('returns structured errors for unknown or invalid agents', async () => {
    const catalog = await catalogWith();
    expect(await catalog.pinAgent({ id: 'nope', version: 'v1.0.0' }, context)).toMatchObject({
      ok: false,
      error: { code: CATALOG_ERROR_CODES.definitionNotFound },
    });
    expect(await catalog.pinAgent({ id: 'test-model', version: 'v1.0.0' }, context)).toMatchObject({
      ok: false,
      error: { code: CATALOG_ERROR_CODES.definitionNotFound },
    });
    expect(await catalog.pinAgent({ id: 'Bad Id', version: 'v1' }, context)).toMatchObject({
      ok: false,
      error: { code: CATALOG_ERROR_CODES.lookupInvalid },
    });
  });

  it('refuses to load an unsealed catalog', async () => {
    await expect(
      DefinitionCatalog.load(new InMemoryDefinitionSource(draftDocuments())),
    ).rejects.toThrow(/DEFINITION_UNSEALED/u);
  });
});
