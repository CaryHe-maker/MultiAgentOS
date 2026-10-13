import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePersistence, clearTemporaryFiles, forPersistenceNamespace } from './index.js';

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
  it('reports its availability before start, while running and after stop', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'persistence-'));
    roots.push(dataDir);
    const files = new FilePersistence(dataDir);
    expect((await files.health()).status).toBe('DOWN');
    await files.start();
    expect((await files.health()).status).toBe('UP');
    await files.stop();
    expect((await files.health()).status).toBe('DOWN');
  });

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

  it('drains queued audit entries before stop and rejects new writes afterward', async () => {
    const { persistence: files, dataDir } = await persistence();
    const first = files.auditLog<{ order: number }>('kernel-core', run);
    const second = files.auditLog<{ order: number }>('kernel-core', run);
    const writes = Array.from({ length: 40 }, (_, order) =>
      (order % 2 === 0 ? first : second).append({ order }),
    );
    await files.stop();
    await Promise.all(writes);
    const lines = (await readFile(join(dataDir, 'runs', run, 'kernel-core', 'audit.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { order: number }).order);
    expect(lines).toEqual(Array.from({ length: 40 }, (_, order) => order));
    await expect(first.append({ order: 41 })).rejects.toThrow('Persistence is stopped');
  });

  it('continues audit appends after a failed write', async () => {
    const { persistence: files, dataDir } = await persistence();
    const directory = join(dataDir, 'runs', run, 'kernel-core');
    await mkdir(join(directory, 'audit.jsonl'), { recursive: true });
    const audit = files.auditLog<{ type: string }>('kernel-core', run);
    await expect(audit.append({ type: 'failed' })).rejects.toThrow();
    await rm(join(directory, 'audit.jsonl'), { recursive: true });
    await audit.append({ type: 'recovered' });
    expect(await readFile(join(directory, 'audit.jsonl'), 'utf8')).toBe('{"type":"recovered"}\n');
  });

  it('limits each owner facade to its own namespace', async () => {
    const { persistence: files } = await persistence();
    const workflow = forPersistenceNamespace(files, 'workflow');
    const core = forPersistenceNamespace(files, 'kernel-core');
    await workflow.repository<{ id: string }>('workflow', run).put({ id: 'a' });
    expect(await core.repository<{ id: string }>('kernel-core', run).get('a')).toBeUndefined();
    expect(() => workflow.auditLog('kernel-core', run)).toThrow('Namespace is not owned');
    expect(() => core.repository('workflow', run)).toThrow('Namespace is not owned');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects storage directories redirected by symlinks',
    async () => {
      const { persistence: files, dataDir } = await persistence();
      const outside = await mkdtemp(join(tmpdir(), 'persistence-outside-'));
      roots.push(outside);
      await mkdir(join(dataDir, 'runs'), { recursive: true });
      await symlink(outside, join(dataDir, 'runs', run), 'dir');
      await expect(
        files.repository<{ id: string }>('workflow', run).put({ id: 'a' }),
      ).rejects.toThrow('symbolic link');
      expect(await readdir(outside)).toEqual([]);
    },
  );

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
