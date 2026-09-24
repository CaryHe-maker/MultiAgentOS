import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalContextEngine } from './index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('FR-CTX-001..004 local context engine', () => {
  it('searches, ranks and clips repository content with provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multiagentos-context-'));
    roots.push(root);
    await writeFile(
      join(root, 'calculator.ts'),
      'export const add = (a: number, b: number) => a - b;\n',
    );
    await writeFile(join(root, 'unrelated.ts'), 'export const label = "hello";\n');
    const engine = new LocalContextEngine();
    const pack = await engine.buildContext({
      workflowRunId: 'wfr_123456',
      missionScopeId: 'msc_123456',
      graphRevision: 0,
      taskRunId: 'tsk_123456',
      agentRunId: 'agr_123456',
      workspace: {
        workspaceId: 'wsp_123456',
        rootPath: root,
        repositoryRevision: 'abc123',
        isolation: 'FIXTURE',
      },
      objective: 'fix calculator add',
      previousObservationRefs: [],
      tokenBudget: 30,
    });
    expect(pack.items[0]?.path).toBe('calculator.ts');
    expect(pack.tokenCount).toBeLessThanOrEqual(30);
    expect(pack.provenance[0]).toMatchObject({
      source: 'calculator.ts',
      revision: 'abc123',
      retrieval: 'TEXT',
    });
    expect(Object.isFrozen(pack)).toBe(true);
  });
});
