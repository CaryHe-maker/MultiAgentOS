import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecutionScope, ExecutorOutcome } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { createFileReadExecutor } from '../file-read/file-read-executor.js';
import { createListExecutor } from '../repository-list/list-executor.js';
import { createSearchExecutor } from '../repository-search/search-executor.js';
import { emptyDirectory, environmentFor } from '../test-support/environments.js';
import { FileDigestCache } from './file-set.js';

/**
 * A folder outside the workspace that the user allowed (docs/M2/Library/ExecutorSet.md 5e): the same
 * executors, with a scope that stays below one path, shows paths in full and looks for no project
 * instructions. The search of the workspace takes a directory too.
 */

const FILES: Record<string, string> = {
  'src/a.ts': 'export const alpha = 1;\n',
  'src/deep/b.ts': 'export const beta = alpha;\n',
  'docs/readme.md': 'alpha is described here\n',
  'AGENTS.md': 'do as this folder says\n',
  'src/AGENTS.md': 'and this\n',
  '.ssh/id_rsa': 'PRIVATE\n',
  'keys/server.pem': 'PRIVATE\n',
  '.env': 'alpha=secret\n',
  'state/log.txt': 'alpha in the data directory\n',
};

async function folder(): Promise<string> {
  const root = await emptyDirectory('external');
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
const root = await folder();

const external = (
  below: string,
  exclusions: string[] = ['**/.ssh/**', 'state/**'],
): ExecutionScope => ({
  kind: 'REPOSITORY',
  repositoryRoot: root,
  exclusions,
  external: { below },
});
const workspace = (): ExecutionScope => ({
  kind: 'REPOSITORY',
  repositoryRoot: root,
  exclusions: [],
});

const completed = (outcome: ExecutorOutcome) => {
  if (outcome.outcome !== 'COMPLETED') throw new Error(`not completed: ${JSON.stringify(outcome)}`);
  return {
    output: outcome.result.output as Record<string, unknown>,
    text: outcome.result.artifact.text,
  };
};

const read = (scope: ExecutionScope, path: string) =>
  createFileReadExecutor().execute({ path }, environmentFor('FILE_READ', scope));
const list = (scope: ExecutionScope, input: { path?: string; depth?: number }) =>
  createListExecutor(new FileDigestCache()).execute(
    input,
    environmentFor('REPOSITORY_LIST', scope),
  );
const search = (scope: ExecutionScope, query: string, path?: string) =>
  createSearchExecutor({ cache: new FileDigestCache(), backend: 'scan' }).execute(
    {
      query,
      mode: 'TEXT',
      maxItems: 20,
      tokenBudget: 100_000,
      ...(path === undefined ? {} : { path }),
    },
    environmentFor('REPOSITORY_SEARCH', scope),
  );

describe('FILE_READ outside the workspace', () => {
  it('shows the path in full and looks for no project instructions', async () => {
    const found = completed(await read(external('src/deep/b.ts'), 'src/deep/b.ts'));
    expect(found.output).toMatchObject({ path: join(root, 'src', 'deep', 'b.ts') });
    expect(found.output['nestedInstructions']).toBeUndefined();
    expect(found.text.startsWith(`${join(root, 'src', 'deep', 'b.ts')} (lines 1-1 of 1)`)).toBe(
      true,
    );
  });

  it('still reads the workspace as before, with its instructions and short paths', async () => {
    const found = completed(await read(workspace(), 'src/deep/b.ts'));
    expect(found.output).toMatchObject({ path: 'src/deep/b.ts' });
    expect(found.output['nestedInstructions']).toEqual(['src/AGENTS.md']);
  });

  it('stays below the path it was allowed for', async () => {
    expect(await read(external('src/deep'), 'src/a.ts')).toEqual({
      outcome: 'REJECTED',
      reasonCode: 'OUT_OF_SCOPE',
    });
    expect(await read(external('src/deep'), 'src/deeper/../a.ts')).toMatchObject({
      outcome: 'REJECTED',
    });
    // A directory whose name only starts like the allowed one is not below it.
    expect(await read(external('src/de'), 'src/deep/b.ts')).toMatchObject({ outcome: 'REJECTED' });
    expect(completed(await read(external('src'), 'src/deep/b.ts')).output).toBeDefined();
  });

  it('does not read what the rules hold back, nor a path out of the root', async () => {
    for (const path of ['.ssh/id_rsa', 'keys/server.pem', '.env', 'state/log.txt'])
      expect(await read(external(''), path), path).toEqual({
        outcome: 'REJECTED',
        reasonCode: 'OUT_OF_SCOPE',
      });
    expect(await read(external(''), '../outside.txt')).toMatchObject({ outcome: 'REJECTED' });
  });
});

describe('REPOSITORY_LIST outside the workspace', () => {
  it('lists below the path and says where in full', async () => {
    const found = completed(await list(external('src'), { path: 'src' }));
    expect(found.output).toMatchObject({ path: join(root, 'src'), fileCount: 3 });
    expect(found.text.startsWith(`${join(root, 'src')}/\n`)).toBe(true);
    expect(found.text).toContain('deep/ [1 files]');
    expect(found.text).not.toContain('docs');
  });

  it('lists the root without a path, and leaves out what the rules hold back', async () => {
    const found = completed(await list(external(''), {}));
    expect(found.output).toMatchObject({ path: root });
    for (const hidden of ['.ssh', 'id_rsa', 'server.pem', '.env', 'state'])
      expect(found.text).not.toContain(hidden);
  });

  it('refuses a path above the one it was allowed for', async () => {
    expect(await list(external('src/deep'), { path: 'src' })).toEqual({
      outcome: 'REJECTED',
      reasonCode: 'NOT_FOUND',
    });
    expect(await list(external('src/deep'), {})).toMatchObject({ outcome: 'REJECTED' });
  });

  it('keeps the workspace listing as it was', async () => {
    const found = completed(await list(workspace(), { path: 'src' }));
    expect(found.output).toMatchObject({ path: 'src' });
  });
});

describe('REPOSITORY_SEARCH outside the workspace', () => {
  it('finds below the path only, with full paths', async () => {
    const found = completed(await search(external('src'), 'alpha', 'src'));
    const hits = found.output['hits'] as { path: string }[];
    expect(hits.map((hit) => hit.path).sort()).toEqual([
      join(root, 'src', 'a.ts'),
      join(root, 'src', 'deep', 'b.ts'),
    ]);
    expect(found.text).toContain(`${join(root, 'src', 'a.ts')}:1-1`);
  });

  it('can be limited to one file', async () => {
    const hits = completed(await search(external('docs/readme.md'), 'alpha', 'docs/readme.md'))
      .output['hits'] as { path: string }[];
    expect(hits.map((hit) => hit.path)).toEqual([join(root, 'docs', 'readme.md')]);
  });

  it('refuses a path above the one it was allowed for', async () => {
    expect(await search(external('src/deep'), 'alpha', 'src')).toMatchObject({
      outcome: 'REJECTED',
      reasonCode: 'OUT_OF_SCOPE',
    });
    expect(await search(external('src/deep'), 'alpha')).toMatchObject({ outcome: 'REJECTED' });
  });

  it('never finds what the rules hold back', async () => {
    const found = completed(await search(external(''), 'alpha'));
    const hits = found.output['hits'] as { path: string }[];
    for (const hit of hits) {
      expect(hit.path).not.toContain('.env');
      expect(hit.path).not.toContain('state');
    }
  });

  it('takes a directory in the workspace too, with short paths', async () => {
    const hits = completed(await search(workspace(), 'alpha', 'src')).output['hits'] as {
      path: string;
    }[];
    expect(hits.map((hit) => hit.path).sort()).toEqual(['src/a.ts', 'src/deep/b.ts']);
    expect(await search(workspace(), 'alpha', '../x')).toMatchObject({ outcome: 'REJECTED' });
  });
});
