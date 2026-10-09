import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePersistence, clearTemporaryFiles } from './index.js';

const roots: string[] = [];
async function persistence(): Promise<{ persistence: FilePersistence; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'persistence-'));
  roots.push(dataDir);
  const created = new FilePersistence(dataDir);
  await created.start();
  return { persistence: created, dataDir };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const run = 'wfr_123456';

describe('FilePersistence', () => {
  it('stores one JSON record per id inside the owner namespace', async () => {
    const { persistence: files, dataDir } = await persistence();
    const repository = files.repository<{ id: string; state: string }>('workflow', run);
    expect(await repository.get(run)).toBeUndefined();
    await repository.put({ id: run, state: 'RUNNING' });
    await repository.put({ id: run, state: 'COMPLETED' });
    expect(await repository.get(run)).toEqual({ id: run, state: 'COMPLETED' });
    expect(await readdir(join(dataDir, 'runs', run, 'workflow'))).toEqual([`${run}.json`]);
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([]);
  });

  it('appends audit entries in order as JSON lines', async () => {
    const { persistence: files, dataDir } = await persistence();
    const audit = files.auditLog<{ type: string }>('kernel-core', run);
    void audit.append({ type: 'RUN_STARTED' });
    void audit.append({ type: 'UNIT_ACCEPTED' });
    await audit.append({ type: 'RUN_CLOSED' });
    const lines = (await readFile(join(dataDir, 'runs', run, 'kernel-core', 'audit.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(lines).toEqual(['RUN_STARTED', 'UNIT_ACCEPTED', 'RUN_CLOSED']);
  });

  it('keeps namespaces apart and rejects malformed path segments', async () => {
    const { persistence: files } = await persistence();
    await files.repository<{ id: string }>('workflow', run).put({ id: 'a' });
    expect(await files.repository<{ id: string }>('kernel-core', run).get('a')).toBeUndefined();
    expect(() => files.repository('workflow', '../escape')).toThrow('Invalid workflowRunId');
    expect(() => files.auditLog('other' as never, run)).toThrow('Invalid namespace');
  });

  it('clears only the temporary directory', async () => {
    const { persistence: files, dataDir } = await persistence();
    await files.repository<{ id: string }>('workflow', run).put({ id: run });
    await mkdir(join(dataDir, 'tmp'), { recursive: true });
    await writeFile(join(dataDir, 'tmp', 'leftover'), 'x');
    await clearTemporaryFiles(dataDir);
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([]);
    expect(await readdir(join(dataDir, 'runs'))).toEqual([run]);
  });
});
