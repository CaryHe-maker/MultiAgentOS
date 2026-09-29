import { describe, expect, it } from 'vitest';
import type {
  BoundaryContext,
  CatalogPort,
  PinnedDefinitionSet,
  PortResult,
  RunUserIntent,
} from '@multiagentos/contracts';
import { M1_AGENT, WorkflowService } from './index.js';

const context: BoundaryContext = {
  correlationId: 'cor_123456',
  tenantId: 'local',
  projectId: 'fixture',
};
const intent: RunUserIntent = {
  kind: 'RUN',
  idempotencyKey: 'run-123456',
  workSessionId: 'wss_123456',
  promptRevisionId: 'prv_123456',
  objective: 'explain the repository',
  workspace: {
    workspaceId: 'wsp_123456',
    rootPath: '.',
    repositoryRevision: 'fixture',
    isolation: 'FIXTURE',
  },
};

/** Minimal CatalogPort stub; the full fake lives in @multiagentos/testing. */
function catalogReturning(result: PortResult<PinnedDefinitionSet>) {
  const requests: unknown[] = [];
  const catalog: CatalogPort = {
    getDefinition: () => Promise.reject(new Error('Workflow must only pin, not look up')),
    pinAgent: (request) => {
      requests.push(request);
      return Promise.resolve(result);
    },
    capabilities: () => [],
  };
  return { catalog, requests };
}

describe('WorkflowService definition pinning', () => {
  it('pins M1_AGENT once when a run is created and keeps the set per run', async () => {
    const pinned = { refs: [] } as unknown as PinnedDefinitionSet;
    const { catalog, requests } = catalogReturning({ ok: true, value: pinned });
    const workflow = new WorkflowService(catalog);
    const created = await workflow.create(intent, context);
    expect(requests).toEqual([M1_AGENT]);
    expect(created.ok).toBe(true);
    if (created.ok) expect(workflow.pinnedDefinitions(created.value.workflowRunId)).toBe(pinned);
  });

  it('does not create a run when pinning fails', async () => {
    const error = {
      code: 'CATALOG_DEFINITION_UNAVAILABLE',
      category: 'POLICY',
      message: 'revoked',
      retryable: false,
      correlationId: context.correlationId,
    } as const;
    const { catalog } = catalogReturning({ ok: false, error });
    expect(await new WorkflowService(catalog).create(intent, context)).toEqual({
      ok: false,
      error,
    });
  });
});
