import { describe, expect, it } from 'vitest';
import type { SourceDocument, SourceSnapshot } from '../ports/definition-source.js';
import { documentAt, draftDocuments, patchDocument } from '../test-support/definition-fixtures.js';
import type { CatalogIssueCode } from './catalog-issue.js';
import { buildCatalogIndex, planSeal } from './catalog-index.js';

const snapshot = (
  documents: readonly SourceDocument[],
  statusDocument?: SourceDocument,
): SourceSnapshot =>
  statusDocument === undefined
    ? { documents, issues: [] }
    : { documents, statusDocument, issues: [] };

/** Seals drafts the same way `pnpm run catalog:seal` does, but in memory. */
function seal(documents: readonly SourceDocument[]): SourceDocument[] {
  const plan = planSeal(snapshot(documents));
  expect(plan.issues).toEqual([]);
  const digests = new Map(plan.patches.map((patch) => [patch.origin, patch.digest]));
  return documents.map((document) => {
    const digest = digests.get(document.origin);
    return digest === undefined ? document : patchDocument(document, { digest });
  });
}

const issueCodes = (documents: readonly SourceDocument[], status?: SourceDocument) => {
  const result = buildCatalogIndex(snapshot(documents, status));
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};

const replace = (
  documents: readonly SourceDocument[],
  prefix: string,
  patch: Readonly<Record<string, unknown>>,
) =>
  documents.map((document) =>
    document.origin.startsWith(prefix) ? patchDocument(document, patch) : document,
  );

describe('buildCatalogIndex', () => {
  it('indexes a sealed catalog and freezes every definition', () => {
    const result = buildCatalogIndex(snapshot(seal(draftDocuments())));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.index.definitions.keys()].sort()).toEqual([
      'AGENT:analysis-agent@v1.0.0',
      'MODEL:test-model@v1.0.0',
      'PROMPT:analysis@v1.0.0',
      'TOOL:read-file@v1.0.0',
      'UNIT:file-read@v1.0.0',
    ]);
    const model = result.index.definitions.get('MODEL:test-model@v1.0.0');
    expect(Object.isFrozen(model)).toBe(true);
    if (model?.kind === 'MODEL') expect(Object.isFrozen(model.pricing.offPeak)).toBe(true);
  });

  it('does not freeze or share the objects it was given', () => {
    const documents = seal(draftDocuments());
    const result = buildCatalogIndex(snapshot(documents));
    expect(result.ok).toBe(true);
    expect(Object.isFrozen(documentAt(documents, 'models/').content)).toBe(false);
  });

  it('refuses unsealed drafts and tells which digest to expect', () => {
    const result = buildCatalogIndex(snapshot(draftDocuments()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(
      new Set(['DEFINITION_UNSEALED']),
    );
    expect(result.issues[0]?.message).toMatch(/computed [a-f0-9]{64}/u);
  });

  it('detects an edited published definition', () => {
    const documents = replace(seal(draftDocuments()), 'tools/', { modelDescription: 'changed' });
    expect(issueCodes(documents)).toEqual<CatalogIssueCode[]>([
      'DIGEST_MISMATCH',
      'REFERENCE_INVALID',
      'REFERENCE_INVALID',
    ]);
  });

  it('propagates a re-sealed dependency to every definition above it', () => {
    const original = seal(draftDocuments());
    const resealedTool = documentAt(
      seal(replace(draftDocuments(), 'tools/', { modelDescription: 'changed' })),
      'tools/',
    );
    const documents = original.map((document) =>
      document.origin === resealedTool.origin ? resealedTool : document,
    );
    // The tool now has a valid digest of its own, but the unit still declares a digest that
    // covered the old tool, so the change cannot slip in under an existing unit version.
    expect(issueCodes(documents)).toEqual<CatalogIssueCode[]>([
      'DIGEST_MISMATCH',
      'REFERENCE_INVALID',
    ]);
  });

  it.each<[string, string, Readonly<Record<string, unknown>>, CatalogIssueCode]>([
    ['schema violations', 'tools/', { riskClass: 'SAFE' }, 'DEFINITION_INVALID'],
    ['unknown kinds', 'tools/', { kind: 'EXECUTOR' }, 'DEFINITION_INVALID'],
    [
      'missing references',
      'units/',
      { toolRefs: [{ id: 'nope', version: 'v1.0.0' }] },
      'REFERENCE_MISSING',
    ],
    [
      'undeclared prompt slots',
      'prompts/',
      { template: 'Analyse {{repository}} and {{branch}}.' },
      'PROMPT_VARIABLES_MISMATCH',
    ],
    ['unused prompt variables', 'prompts/', { template: 'No slots.' }, 'PROMPT_VARIABLES_MISMATCH'],
    [
      'side effects in read-only units',
      'tools/',
      { sideEffect: 'WORKSPACE_WRITE' },
      'EFFECT_MISMATCH',
    ],
  ])('reports %s', (_label, prefix, patch, code) => {
    const documents = replace(draftDocuments(), prefix, patch);
    expect(planSeal(snapshot(documents)).issues.map((issue) => issue.code)).toContain(code);
  });

  it('reports duplicate definitions', () => {
    const documents = draftDocuments();
    const tool = documentAt(documents, 'tools/');
    const duplicate = { origin: 'tools/read-file/copy.yaml', content: tool.content };
    expect(planSeal(snapshot([...documents, duplicate])).issues.map((issue) => issue.code)).toEqual(
      ['DEFINITION_DUPLICATE'],
    );
  });

  it('reports tools with the same model-facing name within one agent', () => {
    const documents = draftDocuments();
    const tool = documentAt(documents, 'tools/');
    const twin = patchDocument(tool, { id: 'read-file-twin' });
    const withTwin = replace([...documents, twin], 'units/', {
      toolRefs: [
        { id: 'read-file', version: 'v1.0.0' },
        { id: 'read-file-twin', version: 'v1.0.0' },
      ],
    });
    expect(planSeal(snapshot(withTwin)).issues.map((issue) => issue.code)).toEqual([
      'TOOL_NAME_CONFLICT',
    ]);
  });

  it('reads status overrides and rejects unknown targets', () => {
    const documents = seal(draftDocuments());
    const status = (entries: readonly object[]): SourceDocument => ({
      origin: 'status.yaml',
      content: { schemaVersion: 'v0', entries },
    });
    const revokeTool = {
      kind: 'TOOL',
      id: 'read-file',
      version: 'v1.0.0',
      status: 'REVOKED',
      reason: 'test',
    };
    const result = buildCatalogIndex(snapshot(documents, status([revokeTool])));
    expect(result.ok && result.index.statuses.get('TOOL:read-file@v1.0.0')).toBe('REVOKED');
    expect(issueCodes(documents, status([{ ...revokeTool, id: 'nope' }]))).toEqual([
      'STATUS_INVALID',
    ]);
    expect(issueCodes(documents, status([revokeTool, revokeTool]))).toEqual(['STATUS_INVALID']);
  });

  it('keeps source issues', () => {
    const result = buildCatalogIndex({
      documents: seal(draftDocuments()),
      issues: [{ origin: 'x.txt', code: 'SOURCE_LOCATION_INVALID', message: 'test' }],
    });
    expect(result.ok ? [] : result.issues.map((issue) => issue.code)).toEqual([
      'SOURCE_LOCATION_INVALID',
    ]);
  });
});

describe('planSeal', () => {
  it('only patches drafts and never rewrites a sealed document', () => {
    const sealed = seal(draftDocuments());
    expect(planSeal(snapshot(sealed)).patches).toEqual([]);
    const draft = documentAt(draftDocuments(), 'tools/');
    const newVersion = {
      origin: 'tools/read-file/v1.1.0.yaml',
      content: { ...(draft.content as object), version: 'v1.1.0' },
    };
    const plan = planSeal(snapshot([...sealed, newVersion]));
    expect(plan.issues).toEqual([]);
    expect(plan.patches.map((patch) => patch.origin)).toEqual(['tools/read-file/v1.1.0.yaml']);
  });

  it('writes nothing when any document has issues', () => {
    const documents = replace(draftDocuments(), 'models/', { baseUrl: 'http://insecure' });
    const plan = planSeal(snapshot(documents));
    expect(plan.patches).toEqual([]);
    expect(plan.issues.map((issue) => issue.code)).toContain('DEFINITION_INVALID');
  });
});
