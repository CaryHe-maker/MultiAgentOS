import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppendLogPort, SnapshotIndexLine } from '@multiagentos/contracts';
import {
  DEFAULT_REPOSITORY_EXCLUSIONS,
  PROTECTED_WRITE_RULES,
  newId,
} from '@multiagentos/contracts';
import { WorkspaceSnapshots, createSubprocessRunner } from '@multiagentos/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShadowFiles, createWorkspaceFiles } from './workspace-files.js';

let root: string;
let shadow: string;
let lines: SnapshotIndexLine[];

const index = (): AppendLogPort<SnapshotIndexLine> => ({
  append: (line) => {
    lines.push(line);
    return Promise.resolve();
  },
  async *readAll() {
    await Promise.resolve();
    yield* lines;
  },
  repairTail: () => Promise.resolve({ truncatedBytes: 0 }),
});

const snapshots = () =>
  new WorkspaceSnapshots({
    repositoryRoot: root,
    directory: join(shadow, 'snapshots'),
    index: index(),
    git: createSubprocessRunner(),
    files: createWorkspaceFiles(root),
    shadow: createShadowFiles(join(shadow, 'snapshots')),
    rules: [...DEFAULT_REPOSITORY_EXCLUSIONS, '**/.multiagentos/**'],
    now: () => new Date('2026-11-04T00:00:00.000Z'),
  });

const put = async (path: string, content: string | Buffer) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};
const read = (path: string) => readFile(join(root, path), 'utf8');
const exists = (path: string) =>
  stat(join(root, path)).then(
    () => true,
    () => false,
  );

/** One Turn in which `change` happens. */
async function turn(
  store: WorkspaceSnapshots,
  change: () => Promise<void>,
  turnId = newId('trn'),
): Promise<string> {
  await store.turnStarted(turnId);
  await change();
  await store.turnEnded(turnId);
  return turnId;
}

const planOf = async (store: WorkspaceSnapshots, scope: 'LAST' | 'ALL' = 'LAST') => {
  const result = await store.planUndo(scope);
  if (result.kind !== 'PLAN') throw new Error(result.kind);
  return result.plan;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'snapshot-repo-'));
  shadow = await mkdtemp(join(tmpdir(), 'snapshot-shadow-'));
  lines = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(shadow, { recursive: true, force: true });
});

describe('a Turn', () => {
  it('records what it added, changed and deleted, without needing a git repository', async () => {
    await put('keep.txt', 'keep');
    await put('change.txt', 'old');
    await put('delete.txt', 'bye');
    const store = snapshots();
    const turnId = newId('trn');
    await store.turnStarted(turnId);
    await put('change.txt', 'new');
    await put('sub/add.txt', 'hello');
    await rm(join(root, 'delete.txt'));
    expect(await store.turnEnded(turnId)).toMatchObject({
      startSnapshot: expect.any(String) as string,
      endSnapshot: expect.any(String) as string,
      changedFileCount: 3,
    });
    expect(lines.at(-1)).toMatchObject({
      kind: 'TURN_ENDED',
      changedFiles: [
        { path: 'change.txt', change: 'MODIFIED' },
        { path: 'delete.txt', change: 'DELETED' },
        { path: 'sub/add.txt', change: 'ADDED' },
      ],
    });
    expect(await exists('.git')).toBe(false);
  });

  it('leaves excluded files, links and oversized new files out', async () => {
    await put('.env', 'SECRET');
    await put('node_modules/a/index.js', 'x');
    await put('big.bin', Buffer.alloc(17 * 1024 * 1024, 1));
    await put('a.txt', 'a');
    await symlink(join(root, 'a.txt'), join(root, 'link.txt')).catch(() => undefined);
    const store = snapshots();
    const turnId = await turn(store, async () => {
      await put('.env', 'CHANGED');
      await put('node_modules/a/index.js', 'y');
      await put('big.bin', Buffer.alloc(17 * 1024 * 1024, 2));
    });
    expect(lines.find((l) => l.kind === 'TURN_ENDED' && l.turnId === turnId)).toMatchObject({
      changedFiles: [],
    });
  });

  it('still reads settings of nobody: a repository config cannot reach it', async () => {
    await put('.git/config', '[core]\n\tautocrlf = true\n');
    await put('a.txt', 'one\n');
    const store = snapshots();
    await turn(store, () => put('a.txt', 'two\r\n'));
    expect(lines.at(-1)).toMatchObject({ changedFiles: [{ path: 'a.txt' }] });
  });

  it('goes on without a snapshot when capturing fails', async () => {
    await put('a.txt', 'a');
    const broken = new WorkspaceSnapshots({
      repositoryRoot: root,
      directory: join(shadow, 'snapshots'),
      shadow: createShadowFiles(join(shadow, 'snapshots')),
      index: index(),
      git: {
        run: () => Promise.resolve({ exitCode: 128, signal: null, stdout: '', truncated: false }),
      },
      files: createWorkspaceFiles(root),
      rules: [],
      now: () => new Date(0),
    });
    await turn(broken, () => put('a.txt', 'b'));
    expect(lines[0]).not.toHaveProperty('startSnapshot');
    expect(await broken.planUndo('LAST')).toEqual({ kind: 'NOT_UNDOABLE' });
  });
});

describe('undo', () => {
  it('restores only what the Turn changed, bytes and all', async () => {
    const binary = Buffer.from([0, 255, 1, 254, 10, 13, 10]);
    await put('a.bin', binary);
    await put('b.txt', 'old');
    await put('other.txt', 'other');
    const store = snapshots();
    await turn(store, async () => {
      await put('a.bin', 'x');
      await put('b.txt', 'new');
      await put('c.txt', 'created');
      await rm(join(root, 'other.txt'));
      await put('other.txt', 'other');
    });
    await put('untouched-later.txt', 'by the user');
    const plan = await planOf(store);
    expect(plan.external).toEqual([]);
    expect(await store.applyUndo(plan, false)).toEqual({ ok: true });
    expect(await readFile(join(root, 'a.bin'))).toEqual(binary);
    expect(await read('b.txt')).toBe('old');
    expect(await exists('c.txt')).toBe(false);
    expect(await read('untouched-later.txt')).toBe('by the user');
    expect(lines.at(-1)).toMatchObject({ kind: 'REVERTED', forced: false });
  });

  it('goes back one Turn at a time, and all at once', async () => {
    await put('a.txt', '0');
    const store = snapshots();
    await turn(store, () => put('a.txt', '1'));
    await turn(store, () => put('a.txt', '2'));
    await turn(store, () => put('a.txt', '3'));
    await store.applyUndo(await planOf(store), false);
    expect(await read('a.txt')).toBe('2');
    await store.applyUndo(await planOf(store, 'ALL'), false);
    expect(await read('a.txt')).toBe('0');
    expect(await store.planUndo('LAST')).toEqual({ kind: 'NOTHING_TO_UNDO' });
  });

  it('names an external change, and only a forced undo overwrites it, keeping a backup', async () => {
    await put('a.txt', 'old');
    const store = snapshots();
    await turn(store, () => put('a.txt', 'agent'));
    await put('a.txt', 'user');
    const plan = await planOf(store);
    expect(plan.external).toEqual([{ path: 'a.txt', change: 'MODIFIED' }]);
    const applied = await store.applyUndo(plan, true);
    expect(applied).toMatchObject({ ok: true, backupSnapshot: expect.any(String) as string });
    expect(await read('a.txt')).toBe('old');
  });

  it('names a deleted file as external too', async () => {
    await put('a.txt', 'old');
    const store = snapshots();
    await turn(store, () => put('a.txt', 'agent'));
    await rm(join(root, 'a.txt'));
    expect((await planOf(store)).external).toEqual([{ path: 'a.txt', change: 'DELETED' }]);
  });

  it('stops when a file changed after the plan, and puts back what it wrote', async () => {
    await put('a.txt', 'a0');
    await put('b.txt', 'b0');
    const store = snapshots();
    await turn(store, async () => {
      await put('a.txt', 'a1');
      await put('b.txt', 'b1');
    });
    const plan = await planOf(store);
    await put('b.txt', 'changed meanwhile');
    expect(await store.applyUndo(plan, false)).toEqual({ ok: false });
    expect(await read('a.txt')).toBe('a1');
    expect(await read('b.txt')).toBe('changed meanwhile');
    expect(lines.at(-1)).not.toMatchObject({ kind: 'REVERTED' });
  });

  it('survives a restart: the index alone is enough', async () => {
    await put('a.txt', 'old');
    await turn(snapshots(), () => put('a.txt', 'new'));
    const reopened = snapshots();
    await reopened.load();
    await reopened.applyUndo(await planOf(reopened), false);
    expect(await read('a.txt')).toBe('old');
  });

  it('treats a Turn left by an exit as all external, when nothing follows it', async () => {
    await put('a.txt', 'old');
    const store = snapshots();
    await store.turnStarted(newId('trn'));
    await put('a.txt', 'new');
    const reopened = snapshots();
    await reopened.load();
    expect((await planOf(reopened)).external).toEqual([{ path: 'a.txt', change: 'UNKNOWN' }]);
    await reopened.applyUndo(await planOf(reopened), true);
    expect(await read('a.txt')).toBe('old');
  });

  it('measures a Turn left by an exit against the next start', async () => {
    await put('a.txt', 'old');
    const first = snapshots();
    await first.turnStarted(newId('trn'));
    await put('a.txt', 'crashed');
    const second = snapshots();
    await second.load();
    await turn(second, () => put('b.txt', 'next'));
    const plan = await planOf(second, 'ALL');
    expect(plan.external).toEqual([]);
    await second.applyUndo(plan, false);
    expect(await read('a.txt')).toBe('old');
    expect(await exists('b.txt')).toBe(false);
  });

  it('does not follow a link put in where a file was', async () => {
    await put('dir/a.txt', 'old');
    const store = snapshots();
    await turn(store, () => put('dir/a.txt', 'new'));
    const plan = await planOf(store);
    await rm(join(root, 'dir'), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), 'snapshot-outside-'));
    const linked = await symlink(outside, join(root, 'dir')).then(
      () => true,
      () => false,
    );
    if (!linked) return;
    await store.applyUndo(plan, false).catch(() => undefined);
    await expect(stat(join(outside, 'a.txt'))).rejects.toThrow();
    await rm(outside, { recursive: true, force: true });
  });
});

describe('a diff', () => {
  it('shows a Turn, the latest first, skipping what was reverted', async () => {
    await put('a.txt', 'zero\n');
    const store = snapshots();
    const first = await turn(store, () => put('a.txt', 'one\n'));
    const second = await turn(store, () => put('a.txt', 'two\n'));
    expect(await store.diffTurn(1)).toMatchObject({
      turnId: second,
      files: [{ path: 'a.txt', change: 'MODIFIED' }],
      diff: expect.stringContaining('+two') as string,
    });
    expect(await store.diffTurn(2)).toMatchObject({ turnId: first });
    expect(await store.diffTurn(3)).toBeUndefined();
    await store.applyUndo(await planOf(store), false);
    expect(await store.diffTurn(1)).toMatchObject({ turnId: first });
  });
});

describe('opening a Session', () => {
  it('finds what changed since its last Turn', async () => {
    await put('a.txt', 'a');
    await turn(snapshots(), () => put('a.txt', 'b'));
    const opened = snapshots();
    await opened.load();
    expect(await opened.divergedFiles()).toEqual([]);
    await put('a.txt', 'user');
    await put('new.txt', 'user');
    expect(await opened.divergedFiles()).toEqual(['a.txt', 'new.txt']);
  });

  it('measures from where an undo left the workspace', async () => {
    await put('a.txt', 'a');
    const store = snapshots();
    await turn(store, () => put('a.txt', 'b'));
    await store.applyUndo(await planOf(store), false);
    const opened = snapshots();
    await opened.load();
    expect(await opened.divergedFiles()).toEqual([]);
  });

  it('has nothing to say for a Session with no Turn', async () => {
    await put('a.txt', 'a');
    expect(await snapshots().divergedFiles()).toEqual([]);
  });
});

describe('what a snapshot holds', () => {
  it('keeps the bytes on disk, whatever .gitattributes says', async () => {
    await put('.gitattributes', '* text=auto eol=lf\n');
    await put('crlf.txt', 'one\r\ntwo\r\n');
    const store = snapshots();
    await turn(store, () => put('crlf.txt', 'three\r\n'));
    const plan = await planOf(store);
    expect(plan.external).toEqual([]);
    expect(await store.applyUndo(plan, false)).toMatchObject({ ok: true });
    expect(await read('crlf.txt')).toBe('one\r\ntwo\r\n');
  });

  it('can undo a file too large for the old limit', async () => {
    const before = 'a'.repeat(3 * 1024 * 1024);
    await put('big.txt', before);
    const store = snapshots();
    await turn(store, () => put('big.txt', 'small'));
    await store.applyUndo(await planOf(store), false);
    expect(await read('big.txt')).toBe(before);
  });

  it('still notices a file removed between captures', async () => {
    await put('a.txt', 'a');
    await put('b.txt', 'b');
    const store = snapshots();
    await turn(store, () => rm(join(root, 'b.txt')));
    await store.applyUndo(await planOf(store), false);
    expect(await read('b.txt')).toBe('b');
  });

  it('survives what a killed git left behind', async () => {
    await put('a.txt', 'a');
    const store = snapshots();
    await turn(store, () => put('a.txt', 'b'));
    await writeFile(join(shadow, 'snapshots', 'capture-index.lock'), '');
    await turn(store, () => put('a.txt', 'c'));
    await store.applyUndo(await planOf(store), false);
    expect(await read('a.txt')).toBe('b');
  });

  it('notices and undoes a change of the executable bit', async () => {
    await put('run.sh', 'echo');
    const store = snapshots();
    const turnId = newId('trn');
    await store.turnStarted(turnId);
    await chmod(join(root, 'run.sh'), 0o755);
    await store.turnEnded(turnId);
    await store.applyUndo(await planOf(store), false);
    expect((await stat(join(root, 'run.sh'))).mode & 0o111).toBe(0);
  });

  it('takes away the directories it made for a file, and only those', async () => {
    await put('keep/a.txt', 'a');
    const store = snapshots();
    await turn(store, async () => {
      await put('keep/new/deep/b.txt', 'b');
      await put('fresh/deep/c.txt', 'c');
    });
    await store.applyUndo(await planOf(store), false);
    expect(await exists('keep/a.txt')).toBe(true);
    expect(await exists('keep/new')).toBe(false);
    expect(await exists('fresh')).toBe(false);
  });

  it('leaves out what a crashed write left behind', async () => {
    await put('a.txt', 'a');
    const store = new WorkspaceSnapshots({
      repositoryRoot: root,
      directory: join(shadow, 'snapshots'),
      index: index(),
      git: createSubprocessRunner(),
      files: createWorkspaceFiles(root),
      shadow: createShadowFiles(join(shadow, 'snapshots')),
      rules: [...PROTECTED_WRITE_RULES, ...DEFAULT_REPOSITORY_EXCLUSIONS],
      now: () => new Date('2026-11-04T00:00:00.000Z'),
    });
    await turn(store, () => put('.0123.multiagentos-write', 'partial'));
    expect((await planOf(store)).files).toEqual([]);
  });

  it('says so when a Turn has no snapshot, and the Turn goes on', async () => {
    const said: string[] = [];
    const store = new WorkspaceSnapshots({
      repositoryRoot: root,
      directory: join(shadow, 'snapshots'),
      index: index(),
      git: {
        run: () => Promise.resolve({ exitCode: 1, signal: null, stdout: '', truncated: false }),
      },
      files: createWorkspaceFiles(root),
      shadow: createShadowFiles(join(shadow, 'snapshots')),
      rules: [],
      now: () => new Date('2026-11-04T00:00:00.000Z'),
      diagnostic: (line) => said.push(line),
    });
    await store.turnStarted('trn_1');
    expect(said.join('')).toContain('cannot be undone');
    await expect(store.turnEnded('trn_1')).resolves.toEqual({});
    await expect(store.diffTurn(1)).resolves.toBeUndefined();
    await expect(store.planUndo('LAST')).resolves.toEqual({ kind: 'NOT_UNDOABLE' });
  });
});
