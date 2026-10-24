import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  OrientContextPackSchema,
  type RepositoryOrientOutput,
  sha256Hex,
  validate,
  type ExecutorOutcome,
  type OrientContextPack,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { FileDigestCache } from '../repository-access/file-set.js';
import { emptyDirectory, environmentFor, repositoryScope } from '../test-support/environments.js';
import { createOrientExecutor } from './orient-executor.js';

async function orient(files: Record<string, string>, tokenBudget = 8_000) {
  const root = await emptyDirectory('orient');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const outcome: ExecutorOutcome = await createOrientExecutor(new FileDigestCache()).execute(
    { objective: 'What is this?', tokenBudget },
    environmentFor('REPOSITORY_ORIENT', repositoryScope(root)),
  );
  if (outcome.outcome !== 'COMPLETED') throw new Error(JSON.stringify(outcome));
  const pack = JSON.parse(outcome.result.artifact.text) as OrientContextPack;
  return { output: outcome.result.output as RepositoryOrientOutput, pack };
}

const readme = Array.from({ length: 60 }, (_, index) => `readme line ${index + 1}`).join('\n');

describe('REPOSITORY_ORIENT (ExecutorSet 4.1)', () => {
  it('shows the tree, the README and the manifests with provenance', async () => {
    const { output, pack } = await orient({
      'README.md': readme,
      'package.json': '{ "name": "x" }\n',
      'src/index.ts': 'export {};\n',
      'src/deep/nested/file.ts': 'x\n',
      '.env': 'SECRET=1\n',
    });
    expect(validate(OrientContextPackSchema, pack)).toMatchObject({ ok: true });
    expect(output).toMatchObject({ fileCount: 4, snapshotId: pack.snapshotId });
    const [tree, readmeItem, manifest] = pack.items;
    expect(tree?.content).toContain('src/ [2 files]');
    expect(tree?.content).toContain('  deep/ [1 files]');
    expect(tree?.content).not.toContain('nested');
    expect(tree?.content).not.toContain('.env');
    expect(readmeItem?.provenance).toMatchObject({
      path: 'README.md',
      startLine: 1,
      endLine: 40,
      retrieval: 'TREE',
    });
    expect(readmeItem?.content).toContain('40 | readme line 40');
    expect(readmeItem?.content).not.toContain('readme line 41');
    const excerpt = `${readme.split('\n').slice(0, 40).join('\n')}\n`;
    expect(readmeItem?.provenance.contentSha256).toBe(sha256Hex(excerpt));
    expect(manifest?.provenance.path).toBe('package.json');
    expect(output.summary).toContain('Excerpts: README.md, package.json.');
  });

  it('keeps the pack within the budget and says what it left out', async () => {
    const files: Record<string, string> = { 'README.md': readme };
    for (let index = 0; index < 300; index += 1) files[`dir${index % 30}/file${index}.ts`] = 'x\n';
    const { output, pack } = await orient(files, 1_500);
    expect(pack.tokenCount).toBeLessThanOrEqual(1_500);
    expect(output.truncated).toBe(true);
    expect(pack.truncated).toBe(true);
  });
});
