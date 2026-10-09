import { describe, expect, it } from 'vitest';
import type { SourceDocument } from '../ports/definition-source.js';
import { draftDocuments, patchDocument } from '../test-support/definition-fixtures.js';
import type { CatalogIssueCode } from './catalog-issue.js';
import { planSeal } from './catalog-index.js';

const codes = (documents: readonly SourceDocument[]) =>
  planSeal({ documents, issues: [] }).issues.map((issue) => issue.code);
const patched = (prefix: string, patch: Readonly<Record<string, unknown>>) =>
  draftDocuments().map((document) =>
    document.origin.startsWith(prefix) ? patchDocument(document, patch) : document,
  );
const contract = (id: string) => ({ kind: 'contract', id, version: 'v0' });
const ref = (id: string) => ({ id, version: 'v1.0.0' });

describe('definition rules', () => {
  it('accepts the fixture catalog', () => {
    expect(codes(draftDocuments())).toEqual([]);
  });

  it.each<[string, string, Readonly<Record<string, unknown>>, CatalogIssueCode]>([
    [
      'a contract that is not registered',
      'tools/read-file/',
      { parametersContract: contract('executor.Missing') },
      'CONTRACT_UNKNOWN',
    ],
    [
      'contracts that do not match the execution kind',
      'units/model-call/',
      { inputContract: contract('executor.FileReadInput') },
      'UNIT_INVALID',
    ],
    [
      'a repository unit without repo.read',
      'units/file-read/',
      { protectedCapabilities: [] },
      'UNIT_INVALID',
    ],
    [
      'a protected capability on a unit that reads no repository',
      'units/model-call/',
      { protectedCapabilities: ['repo.read'] },
      'UNIT_INVALID',
    ],
    [
      'FINAL_CALL for a reason other than USER_DECLINED or BUDGET_WRAP_UP',
      'units/file-read/',
      { failurePolicy: { NOT_FOUND: 'FINAL_CALL' } },
      'UNIT_INVALID',
    ],
    [
      'a unit that references a CONTROL tool',
      'units/context-assemble/',
      { toolRefs: [ref('finish-analysis')] },
      'UNIT_INVALID',
    ],
    ['a UNIT tool that no unit owns', 'units/file-read/', { toolRefs: [] }, 'TOOL_INVALID'],
    [
      'a finish action that is not a CONTROL tool',
      'agents/',
      { actions: { finish: { toolRef: ref('read-file') } } },
      'AGENT_INVALID',
    ],
    [
      'a start unit outside unitRefs',
      'agents/',
      { startUnitRefs: [ref('repository-orient')] },
      'AGENT_INVALID',
    ],
    [
      'a start unit that is not REPOSITORY_ORIENT',
      'agents/',
      { startUnitRefs: [ref('file-read')] },
      'AGENT_INVALID',
    ],
    [
      'an agent without a report-publish unit',
      'agents/',
      { unitRefs: [ref('file-read'), ref('context-assemble'), ref('model-call')] },
      'AGENT_INVALID',
    ],
    [
      'an agent that hands off to itself',
      'agents/',
      {
        actions: {
          finish: { toolRef: ref('finish-analysis') },
          handoff: { toolRef: ref('finish-analysis'), targetAgentRef: ref('analysis-agent') },
        },
      },
      'AGENT_INVALID',
    ],
  ])('rejects %s', (_label, prefix, patch, code) => {
    expect(codes(patched(prefix, patch))).toContain(code);
  });
});
