import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = async (path: string): Promise<string> =>
  await readFile(join(process.cwd(), path), 'utf8');

describe('FR-UI-001 FR-WF-007 NFR-COMP-003 architecture boundaries', () => {
  it('prevents Workflow from importing execution implementations', async () => {
    const workflow = await source('packages/workflow/src/index.ts');
    expect(workflow).not.toMatch(/@multiagentos\/(?:kernel|context-engine|agent-tool-pool)/u);
    expect(workflow).not.toMatch(/node:(?:fs|child_process)/u);
  });
  it('prevents UserInteraction and Executor bypasses', async () => {
    const interaction = await source('packages/user-interaction/src/index.ts');
    const executor = await source('apps/executor/src/index.ts');
    expect(interaction).not.toContain('@multiagentos/workflow');
    expect(executor).not.toContain('@multiagentos/kernel');
    expect(executor).not.toMatch(/node:(?:child_process|worker_threads)/u);
    expect(executor).not.toMatch(/\b(?:writeFile|appendFile|rm|unlink|rename|mkdir)\b/u);
  });
  it('keeps apps out of domain package dependencies', async () => {
    for (const name of [
      'workflow',
      'kernel',
      'context-engine',
      'agent-tool-pool',
      'user-interaction',
    ]) {
      const manifest = JSON.parse(
        (await source(`packages/${name}/package.json`)).replace(/^\uFEFF/u, ''),
      ) as {
        dependencies?: Record<string, string>;
      };
      expect(
        Object.keys(manifest.dependencies ?? {}).some(
          (dependency) =>
            dependency.startsWith('@multiagentos/') && !dependency.endsWith('/contracts'),
        ),
      ).toBe(false);
    }
  });
});
