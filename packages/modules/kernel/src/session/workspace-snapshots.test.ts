import { createHash } from 'node:crypto';
import type {
  AppendLogPort,
  ShadowFiles,
  SnapshotIndexLine,
  SubprocessRunner,
  WorkspaceFiles,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { WorkspaceSnapshots } from './workspace-snapshots.js';

/**
 * The snapshots of a Session across a change of folder (M2Design 2.3). A small git in memory
 * stands in for the real one, so every case runs the real snapshot code: capture, undo, the
 * check for what changed outside, and what is read back from the index after a restart.
 */
const blobOf = (content: Buffer): string =>
  createHash('sha1')
    .update(`blob ${String(content.length)}\0`)
    .update(content)
    .digest('hex');

function world() {
  /** The files of the folder the Session is worked on in now. */
  let folder = new Map<string, Buffer>();
  let vanished = false;
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const staged = new Map<string, string>();
  const lines: SnapshotIndexLine[] = [];
  let gitFails = false;

  const git: SubprocessRunner = {
    run: (_command, args, options) => {
      const ok = (stdout = '') =>
        Promise.resolve({ exitCode: 0, signal: null, stdout, truncated: false });
      if (gitFails)
        return Promise.resolve({ exitCode: 1, signal: null, stdout: '', truncated: false });
      switch (args[0]) {
        case 'ls-files':
          return ok([...staged.keys()].map((path) => `${path}\0`).join(''));
        case 'update-index': {
          const paths = (options.stdin ?? '').split('\0').filter((path) => path !== '');
          if (args.includes('--force-remove')) for (const path of paths) staged.delete(path);
          else
            for (const path of paths) {
              const content = folder.get(path);
              if (content === undefined) staged.delete(path);
              else {
                blobs.set(blobOf(content), content);
                staged.set(path, blobOf(content));
              }
            }
          return ok();
        }
        case 'write-tree': {
          const entries = new Map(staged);
          const id = createHash('sha1')
            .update(
              [...entries]
                .sort()
                .map(([path, sha]) => `${path}:${sha}`)
                .join('\n'),
            )
            .digest('hex');
          trees.set(id, entries);
          return ok(`${id}\n`);
        }
        case 'ls-tree': {
          const entries = trees.get(args.at(-1) ?? '');
          if (entries === undefined)
            return Promise.resolve({ exitCode: 1, signal: null, stdout: '', truncated: false });
          return ok([...entries].map(([path, sha]) => `100644 blob ${sha}\t${path}\0`).join(''));
        }
        case 'cat-file':
          return ok((blobs.get(args.at(-1) ?? '') ?? Buffer.alloc(0)).toString('base64'));
        default:
          return ok();
      }
    },
  };
  const files: WorkspaceFiles = {
    list: () => {
      if (vanished) return Promise.reject(new Error('ENOENT: the folder is gone'));
      return Promise.resolve(
        [...folder].map(([path, content]) => ({ path, size: content.length })),
      );
    },
    read: (path) => Promise.resolve(folder.get(path)),
    write: (path, content) => {
      folder.set(path, content);
      return Promise.resolve();
    },
    remove: (path) => {
      folder.delete(path);
      return Promise.resolve();
    },
  };
  const shadow: ShadowFiles = { write: () => Promise.resolve(), remove: () => Promise.resolve() };
  const index: AppendLogPort<SnapshotIndexLine> = {
    append: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    async *readAll() {
      await Promise.resolve();
      yield* lines;
    },
    repairTail: () => Promise.resolve({ truncatedBytes: 0 }),
  };
  let clock = 0;
  const open = (repositoryRoot: string) =>
    new WorkspaceSnapshots({
      repositoryRoot,
      directory: '/shadow',
      index,
      git,
      files,
      shadow,
      rules: [],
      now: () => new Date(Date.parse('2026-11-10T00:00:00.000Z') + (clock += 1000)),
    });
  return {
    lines,
    open,
    folder: () => folder,
    /** The Session is now worked on in another folder, which holds `content`. */
    moveTo: (content: Record<string, string>) => {
      folder = new Map(Object.entries(content).map(([path, text]) => [path, Buffer.from(text)]));
      vanished = false;
    },
    set: (path: string, text: string) => void folder.set(path, Buffer.from(text)),
    text: (path: string) => folder.get(path)?.toString('utf8'),
    vanish: () => {
      vanished = true;
    },
    breakGit: (value: boolean) => {
      gitFails = value;
    },
  };
}

/** A Turn that changes `path` to `text`. */
async function turn(
  snapshots: WorkspaceSnapshots,
  w: ReturnType<typeof world>,
  turnId: string,
  path: string,
  text: string,
) {
  await snapshots.turnStarted(turnId);
  w.set(path, text);
  await snapshots.turnEnded(turnId);
}

const undoAll = async (snapshots: WorkspaceSnapshots) => {
  const planned = await snapshots.planUndo('ALL');
  if (planned.kind !== 'PLAN') return planned.kind;
  const applied = await snapshots.applyUndo(planned.plan, false);
  return applied.ok ? planned.plan.turnIds : 'FAILED';
};

describe('without a change of folder', () => {
  it('undoes a Turn and puts the file back', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'a.txt', 'two');
    expect(await undoAll(snapshots)).toEqual(['trn_1']);
    expect(w.text('a.txt')).toBe('one');
  });
});

describe('checkpoints inside a Turn (Orchestration 7.1)', () => {
  it('records a snapshot of the moment, and leaves the Turn undoable after a restart', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    await snapshots.turnStarted('trn_1');
    w.set('a.txt', 'two');
    const snapshot = await snapshots.checkpoint('ckp_1', 'trn_1', 'ROOT_SPAWN', 'before the split');
    expect(typeof snapshot).toBe('string');
    w.set('a.txt', 'three');
    await snapshots.turnEnded('trn_1');
    expect(w.lines.find((line) => line.kind === 'CHECKPOINT')).toMatchObject({
      checkpointId: 'ckp_1',
      turnId: 'trn_1',
      ckpKind: 'ROOT_SPAWN',
      snapshot,
    });
    const restarted = w.open('/a');
    await restarted.load();
    expect(await undoAll(restarted)).toEqual(['trn_1']);
    expect(w.text('a.txt')).toBe('one');
  });
});

describe('a Session opened in another folder', () => {
  it('has nothing to undo from the folder before, and its files are left alone', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'a.txt', 'two');
    // The user opens the Session in another folder.
    w.moveTo({ 'a.txt': 'something else', 'b.txt': 'b' });
    await snapshots.startEpoch();
    expect(await undoAll(snapshots)).toBe('NOTHING_TO_UNDO');
    expect(w.text('a.txt')).toBe('something else');
  });

  it('does not report the whole new folder as changed from outside', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one', 'old.txt': 'x' });
    const snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'a.txt', 'two');
    expect(await snapshots.divergedFiles()).toEqual([]);
    w.moveTo({ 'z.txt': 'z' });
    await snapshots.startEpoch();
    expect(await snapshots.divergedFiles()).toEqual([]);
  });

  it('undoes its own Turns and only those', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'a.txt', 'two');
    w.moveTo({ 'a.txt': 'b version', 'c.txt': 'c' });
    await snapshots.startEpoch();
    await turn(snapshots, w, 'trn_2', 'c.txt', 'changed in b');
    expect(await undoAll(snapshots)).toEqual(['trn_2']);
    expect(w.text('c.txt')).toBe('c');
    expect(w.text('a.txt')).toBe('b version');
    expect(await undoAll(snapshots)).toBe('NOTHING_TO_UNDO');
  });

  it('is the same after a restart: the index says where the epoch began', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const first = w.open('/a');
    await turn(first, w, 'trn_1', 'a.txt', 'two');
    w.moveTo({ 'b.txt': 'b' });
    await first.startEpoch();
    await turn(first, w, 'trn_2', 'b.txt', 'b2');
    const restarted = w.open('/b');
    await restarted.load();
    expect(await undoAll(restarted)).toEqual(['trn_2']);
    expect(w.text('b.txt')).toBe('b');
    expect(await undoAll(restarted)).toBe('NOTHING_TO_UNDO');
  });

  it('does not touch what was written before: the old lines stay in the index', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'a.txt', 'two');
    const before = w.lines.length;
    await snapshots.startEpoch();
    expect(w.lines.slice(0, before).map((line) => line.kind)).toEqual([
      'TURN_STARTED',
      'TURN_ENDED',
    ]);
    expect(w.lines.at(-1)).toMatchObject({ kind: 'EPOCH', repositoryRoot: '/a' });
  });
});

describe('going back and forth between folders', () => {
  it('begins again every time, and never undoes across a change', async () => {
    const w = world();
    const content = (tag: string) => ({ 'f.txt': tag });
    w.moveTo(content('a0'));
    let snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'f.txt', 'a1');
    const folders = ['/b', '/a', '/b', '/a'];
    for (const [step, root] of folders.entries()) {
      w.moveTo(content(`${root}-${String(step)}`));
      snapshots = w.open(root);
      await snapshots.load();
      await snapshots.startEpoch();
      expect(await undoAll(snapshots)).toBe('NOTHING_TO_UNDO');
      await turn(snapshots, w, `trn_${String(step + 2)}`, 'f.txt', `done-${String(step)}`);
    }
    expect(w.lines.filter((line) => line.kind === 'EPOCH')).toHaveLength(4);
    // Only the Turn of the last stay can be undone, and it puts back what the last folder held.
    const last = w.open('/a');
    await last.load();
    expect(await undoAll(last)).toEqual(['trn_5']);
    expect(w.text('f.txt')).toBe('/a-3');
    expect(await undoAll(last)).toBe('NOTHING_TO_UNDO');
  });

  it('repeats an epoch without harm: a crash between the epoch and the change of binding', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'a.txt', 'two');
    for (let i = 0; i < 3; i += 1) {
      const again = w.open('/b');
      await again.load();
      await again.startEpoch();
    }
    const reopened = w.open('/b');
    await reopened.load();
    expect(await undoAll(reopened)).toBe('NOTHING_TO_UNDO');
  });
});

describe('undoing, then changing folder', () => {
  it('leaves a reverted Turn reverted, and the new folder clean', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'a.txt', 'two');
    expect(await undoAll(snapshots)).toEqual(['trn_1']);
    w.moveTo({ 'b.txt': 'b' });
    await snapshots.startEpoch();
    const reopened = w.open('/b');
    await reopened.load();
    expect(await undoAll(reopened)).toBe('NOTHING_TO_UNDO');
    expect(await reopened.divergedFiles()).toEqual([]);
  });

  it('undoes the Turns of the new folder one at a time, as ever', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'a.txt', 'two');
    w.moveTo({ 'b.txt': 'b0' });
    await snapshots.startEpoch();
    await turn(snapshots, w, 'trn_2', 'b.txt', 'b1');
    await turn(snapshots, w, 'trn_3', 'b.txt', 'b2');
    const last = await snapshots.planUndo('LAST');
    if (last.kind !== 'PLAN') throw new Error('no plan');
    expect(last.plan.turnIds).toEqual(['trn_3']);
    expect((await snapshots.applyUndo(last.plan, false)).ok).toBe(true);
    expect(w.text('b.txt')).toBe('b1');
  });
});

describe('a folder that goes away', () => {
  it('in the middle of a Turn: the Turn ends, only without a way back', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    await snapshots.turnStarted('trn_1');
    w.vanish();
    const ended = await snapshots.turnEnded('trn_1');
    expect(ended).toEqual(expect.objectContaining({}));
    expect(ended.endSnapshot).toBeUndefined();
    expect(await snapshots.planUndo('LAST')).toEqual({ kind: 'NOT_UNDOABLE' });
  });

  it('before a Turn begins: nothing can be undone, and nothing is thrown', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    w.vanish();
    await expect(snapshots.turnStarted('trn_1')).resolves.toBeUndefined();
    await expect(snapshots.turnEnded('trn_1')).resolves.toEqual({});
    expect(await snapshots.planUndo('ALL')).toEqual({ kind: 'NOT_UNDOABLE' });
    expect(await snapshots.divergedFiles()).toEqual([]);
  });

  it('and the Session is opened in another folder: its snapshots begin again and work', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'a.txt', 'two');
    w.vanish();
    await expect(snapshots.turnStarted('trn_2')).resolves.toBeUndefined();
    w.moveTo({ 'b.txt': 'b' });
    const elsewhere = w.open('/b');
    await elsewhere.load();
    await elsewhere.startEpoch();
    await turn(elsewhere, w, 'trn_3', 'b.txt', 'b2');
    expect(await undoAll(elsewhere)).toEqual(['trn_3']);
    expect(w.text('b.txt')).toBe('b');
  });

  it('is recreated empty at the same path: what was there is reported as changed from outside', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one', 'b.txt': 'two' });
    const snapshots = w.open('/a');
    await turn(snapshots, w, 'trn_1', 'a.txt', 'three');
    w.moveTo({});
    const reopened = w.open('/a');
    await reopened.load();
    expect([...(await reopened.divergedFiles())].sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('is such that git itself fails: the same, a Turn without a way back', async () => {
    const w = world();
    w.moveTo({ 'a.txt': 'one' });
    const snapshots = w.open('/a');
    w.breakGit(true);
    await snapshots.turnStarted('trn_1');
    await expect(snapshots.turnEnded('trn_1')).resolves.toEqual({});
    expect(await snapshots.planUndo('LAST')).toEqual({ kind: 'NOT_UNDOABLE' });
  });
});
