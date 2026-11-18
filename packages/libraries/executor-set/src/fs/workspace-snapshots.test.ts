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

/** One input of the user (a checkpoint), in whose stretch `change` happens, until the run is still. */
async function turn(store: WorkspaceSnapshots, change: () => Promise<void>): Promise<string> {
  const checkpointId = newId('ckp');
  await store.checkpoint(checkpointId, 'INPUT', 'user input');
  await change();
  await store.settle();
  return checkpointId;
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

describe('the stretch of a checkpoint', () => {
  it('records what it added, changed and deleted, without needing a git repository', async () => {
    await put('keep.txt', 'keep');
    await put('change.txt', 'old');
    await put('delete.txt', 'bye');
    const store = snapshots();
    await store.checkpoint(newId('ckp'), 'INPUT', 'user input');
    await put('change.txt', 'new');
    await put('sub/add.txt', 'hello');
    await rm(join(root, 'delete.txt'));
    expect(await store.settle()).toMatchObject({
      startSnapshot: expect.any(String) as string,
      endSnapshot: expect.any(String) as string,
      changedFileCount: 3,
    });
    expect(lines.at(-1)).toMatchObject({ kind: 'SETTLED' });
    expect((await store.diffLatest(1))?.files).toEqual([
      { path: 'change.txt', change: 'MODIFIED' },
      { path: 'delete.txt', change: 'DELETED' },
      { path: 'sub/add.txt', change: 'ADDED' },
    ]);
    expect(await exists('.git')).toBe(false);
  });

  it('leaves excluded files, links and oversized new files out', async () => {
    await put('.env', 'SECRET');
    await put('node_modules/a/index.js', 'x');
    await put('big.bin', Buffer.alloc(17 * 1024 * 1024, 1));
    await put('a.txt', 'a');
    await symlink(join(root, 'a.txt'), join(root, 'link.txt')).catch(() => undefined);
    const store = snapshots();
    await turn(store, async () => {
      await put('.env', 'CHANGED');
      await put('node_modules/a/index.js', 'y');
      await put('big.bin', Buffer.alloc(17 * 1024 * 1024, 2));
    });
    expect((await store.diffLatest(1))?.files).toEqual([]);
  });

  it('still reads settings of nobody: a repository config cannot reach it', async () => {
    await put('.git/config', '[core]\n\tautocrlf = true\n');
    await put('a.txt', 'one\n');
    const store = snapshots();
    await turn(store, () => put('a.txt', 'two\r\n'));
    expect((await store.diffLatest(1))?.files).toEqual([{ path: 'a.txt', change: 'MODIFIED' }]);
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
    expect(lines[0]).not.toHaveProperty('snapshot');
    expect(await broken.planUndo('LAST')).toEqual({ kind: 'NOT_UNDOABLE' });
  });
});

describe('undo', () => {
  it('restores only what the stretch changed, bytes and all', async () => {
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
    expect(await store.applyRollBack(plan, false)).toMatchObject({ ok: true });
    expect(await readFile(join(root, 'a.bin'))).toEqual(binary);
    expect(await read('b.txt')).toBe('old');
    expect(await exists('c.txt')).toBe(false);
    expect(await read('untouched-later.txt')).toBe('by the user');
    expect(lines.at(-1)).toMatchObject({ kind: 'ROLLED_BACK_TO', inclusive: true });
    expect(lines.at(-1)).not.toHaveProperty('forced');
  });

  it('goes back one checkpoint at a time, and all at once', async () => {
    await put('a.txt', '0');
    const store = snapshots();
    await turn(store, () => put('a.txt', '1'));
    await turn(store, () => put('a.txt', '2'));
    await turn(store, () => put('a.txt', '3'));
    await store.applyRollBack(await planOf(store), false);
    expect(await read('a.txt')).toBe('2');
    await store.applyRollBack(await planOf(store, 'ALL'), false);
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
    const applied = await store.applyRollBack(plan, true);
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
    expect(await store.applyRollBack(plan, false)).toEqual({ ok: false });
    expect(await read('a.txt')).toBe('a1');
    expect(await read('b.txt')).toBe('changed meanwhile');
    expect(lines.at(-1)).not.toMatchObject({ kind: 'ROLLED_BACK_TO' });
  });

  it('survives a restart: the index alone is enough', async () => {
    await put('a.txt', 'old');
    await turn(snapshots(), () => put('a.txt', 'new'));
    const reopened = snapshots();
    await reopened.load();
    await reopened.applyRollBack(await planOf(reopened), false);
    expect(await read('a.txt')).toBe('old');
  });

  it('treats a stretch left by an exit as all external, when nothing follows it', async () => {
    await put('a.txt', 'old');
    const store = snapshots();
    await store.checkpoint(newId('ckp'), 'INPUT', 'user input');
    await put('a.txt', 'new');
    const reopened = snapshots();
    await reopened.load();
    expect((await planOf(reopened)).external).toEqual([{ path: 'a.txt', change: 'UNKNOWN' }]);
    await reopened.applyRollBack(await planOf(reopened), true);
    expect(await read('a.txt')).toBe('old');
  });

  it('measures a stretch left by an exit against the next checkpoint', async () => {
    await put('a.txt', 'old');
    const first = snapshots();
    await first.checkpoint(newId('ckp'), 'INPUT', 'user input');
    await put('a.txt', 'crashed');
    const second = snapshots();
    await second.load();
    await turn(second, () => put('b.txt', 'next'));
    const plan = await planOf(second, 'ALL');
    expect(plan.external).toEqual([]);
    await second.applyRollBack(plan, false);
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
    await store.applyRollBack(plan, false).catch(() => undefined);
    await expect(stat(join(outside, 'a.txt'))).rejects.toThrow();
    await rm(outside, { recursive: true, force: true });
  });
});

describe('a diff', () => {
  it('shows a stretch, the latest first, skipping what was undone', async () => {
    await put('a.txt', 'zero\n');
    const store = snapshots();
    await turn(store, () => put('a.txt', 'one\n'));
    await turn(store, () => put('a.txt', 'two\n'));
    expect(await store.diffLatest(1)).toMatchObject({
      files: [{ path: 'a.txt', change: 'MODIFIED' }],
      diff: expect.stringContaining('+two') as string,
    });
    expect(await store.diffLatest(2)).toMatchObject({
      diff: expect.stringContaining('+one') as string,
    });
    expect(await store.diffLatest(3)).toBeUndefined();
    await store.applyRollBack(await planOf(store), false);
    expect(await store.diffLatest(1)).toMatchObject({
      diff: expect.stringContaining('+one') as string,
    });
    expect(await store.diffCheckpoint(1)).toEqual(await store.diffLatest(1));
  });
});

describe('a rewind and an undo are the same way back (Orchestration 7.5, D8)', () => {
  it('keeps the checkpoint a rewind goes back to, and keeps a backup of what it overwrote', async () => {
    await put('a.txt', '0');
    const store = snapshots();
    await turn(store, () => put('a.txt', '1'));
    await store.checkpoint(newId('ckp'), 'ROOT_SPAWN', 'before starting writer');
    await put('a.txt', '2');
    await put('new.txt', 'by a task');
    const planned = await store.planRewind(2);
    if (planned.kind !== 'PLAN') throw new Error(planned.kind);
    expect(await store.applyRollBack(planned.plan, false)).toMatchObject({
      ok: true,
      files: ['a.txt', 'new.txt'],
      backupSnapshot: expect.any(String) as string,
    });
    expect(await read('a.txt')).toBe('1');
    expect(await exists('new.txt')).toBe(false);
    expect((await store.listCheckpoints()).map((point) => point.kind)).toEqual([
      'INPUT',
      'ROOT_SPAWN',
    ]);
    // The work goes on from it, and an undo then takes back the whole exchange.
    await put('a.txt', '3');
    await store.settle();
    await store.applyRollBack(await planOf(store), false);
    expect(await read('a.txt')).toBe('1');
    await store.applyRollBack(await planOf(store), false);
    expect(await read('a.txt')).toBe('0');
    expect(await store.planUndo('LAST')).toEqual({ kind: 'NOTHING_TO_UNDO' });
  });

  it('reads an index written with Turns, and undoes them the same way', async () => {
    await put('a.txt', '0');
    const store = snapshots();
    await turn(store, () => put('a.txt', '1'));
    await turn(store, () => put('a.txt', '2'));
    // The same index, as a Session written before checkpoints replaced Turns would hold it.
    const [first, , second, ,] = lines;
    if (first?.kind !== 'CHECKPOINT' || second?.kind !== 'CHECKPOINT') throw new Error('index');
    const ends = lines.filter((line) => line.kind === 'SETTLED');
    lines = [
      {
        kind: 'TURN_STARTED',
        turnId: 'trn_A',
        turnSeq: 1,
        viewId: 'main',
        ...(first.snapshot === undefined ? {} : { startSnapshot: first.snapshot }),
        at: first.at,
      },
      {
        kind: 'TURN_ENDED',
        turnId: 'trn_A',
        ...(ends[0]?.kind === 'SETTLED' && ends[0].snapshot !== undefined
          ? { endSnapshot: ends[0].snapshot }
          : {}),
        changedFiles: [],
        at: first.at,
      },
      {
        kind: 'TURN_STARTED',
        turnId: 'trn_B',
        turnSeq: 2,
        viewId: 'main',
        ...(second.snapshot === undefined ? {} : { startSnapshot: second.snapshot }),
        at: second.at,
      },
      {
        kind: 'TURN_ENDED',
        turnId: 'trn_B',
        ...(ends[1]?.kind === 'SETTLED' && ends[1].snapshot !== undefined
          ? { endSnapshot: ends[1].snapshot }
          : {}),
        changedFiles: [],
        at: second.at,
      },
      { kind: 'REVERTED', revertedTurnIds: ['trn_B'], forced: false, at: second.at },
    ];
    await put('a.txt', '1');
    const reopened = snapshots();
    await reopened.load();
    expect(await reopened.listCheckpoints()).toEqual([
      { seq: 1, kind: 'INPUT', label: 'user input', at: first.at, changedFiles: 1 },
    ]);
    const plan = await planOf(reopened);
    expect(plan.checkpointId).toBe('ckp_A');
    await reopened.applyRollBack(plan, false);
    expect(await read('a.txt')).toBe('0');
  });
});

describe('opening a Session', () => {
  it('finds what changed since it was last still', async () => {
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
    await store.applyRollBack(await planOf(store), false);
    const opened = snapshots();
    await opened.load();
    expect(await opened.divergedFiles()).toEqual([]);
  });

  it('has nothing to say for a Session with no checkpoint', async () => {
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
    expect(await store.applyRollBack(plan, false)).toMatchObject({ ok: true });
    expect(await read('crlf.txt')).toBe('one\r\ntwo\r\n');
  });

  it('can undo a file too large for the old limit', async () => {
    const before = 'a'.repeat(3 * 1024 * 1024);
    await put('big.txt', before);
    const store = snapshots();
    await turn(store, () => put('big.txt', 'small'));
    await store.applyRollBack(await planOf(store), false);
    expect(await read('big.txt')).toBe(before);
  });

  it('still notices a file removed between captures', async () => {
    await put('a.txt', 'a');
    await put('b.txt', 'b');
    const store = snapshots();
    await turn(store, () => rm(join(root, 'b.txt')));
    await store.applyRollBack(await planOf(store), false);
    expect(await read('b.txt')).toBe('b');
  });

  it('survives what a killed git left behind', async () => {
    await put('a.txt', 'a');
    const store = snapshots();
    await turn(store, () => put('a.txt', 'b'));
    await writeFile(join(shadow, 'snapshots', 'capture-index.lock'), '');
    await turn(store, () => put('a.txt', 'c'));
    await store.applyRollBack(await planOf(store), false);
    expect(await read('a.txt')).toBe('b');
  });

  it('notices and undoes a change of the executable bit', async () => {
    await put('run.sh', 'echo');
    const store = snapshots();
    await turn(store, () => chmod(join(root, 'run.sh'), 0o755));
    await store.applyRollBack(await planOf(store), false);
    expect((await stat(join(root, 'run.sh'))).mode & 0o111).toBe(0);
  });

  it('takes away the directories it made for a file, and only those', async () => {
    await put('keep/a.txt', 'a');
    const store = snapshots();
    await turn(store, async () => {
      await put('keep/new/deep/b.txt', 'b');
      await put('fresh/deep/c.txt', 'c');
    });
    await store.applyRollBack(await planOf(store), false);
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

  it('says so when a checkpoint has no snapshot, and the work goes on', async () => {
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
    await store.checkpoint('ckp_1', 'INPUT', 'user input');
    expect(said.join('')).toContain('no way back');
    await expect(store.settle()).resolves.toEqual({});
    await expect(store.diffLatest(1)).resolves.toBeUndefined();
    await expect(store.planUndo('LAST')).resolves.toEqual({ kind: 'NOT_UNDOABLE' });
  });
});
