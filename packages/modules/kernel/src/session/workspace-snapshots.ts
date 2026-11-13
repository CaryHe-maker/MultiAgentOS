import { createHash } from 'node:crypto';
import { MAX_WORKSPACE_FILE_BYTES } from '@multiagentos/contracts';
import type {
  AppendLogPort,
  ShadowFiles,
  SnapshotIndexLine,
  SubprocessRunner,
  WorkspaceFiles,
} from '@multiagentos/contracts';

/**
 * A file larger than this enters a snapshot only when the one before already holds it. It is the
 * limit of the file tools, so everything they can write can be undone.
 */
export const MAX_UNTRACKED_SNAPSHOT_BYTES = MAX_WORKSPACE_FILE_BYTES;
/** The actor holds every message during a capture, so a stuck git must not hold it for ever. */
const GIT_TIMEOUT_MS = 300_000;
/** Enough for the snapshots at hand; a tree can always be read again. */
const MAX_CACHED_TREES = 8;
const INDEX_FILE = 'capture-index';
/** A snapshot holds the bytes on disk, whatever the repository's .gitattributes would make of them. */
const RAW_ATTRIBUTES = '* -text !eol -ident -filter -working-tree-encoding\n';
const MAX_LIST_BYTES = 64 * 1024 * 1024;
const MAX_BLOB_BYTES = 256 * 1024 * 1024;

/** A file as a snapshot holds it. */
interface Entry {
  readonly mode: string;
  readonly sha: string;
}

export type FileChange = 'ADDED' | 'MODIFIED' | 'DELETED';

export type CheckpointKind = 'INPUT' | 'ROOT_SPAWN' | 'HUMAN_ANSWER' | 'TEMPLATE';

/** One line of the list of checkpoints (Orchestration 7.4). */
export interface CheckpointPoint {
  readonly seq: number;
  readonly kind: CheckpointKind;
  readonly label: string;
  readonly at: string;
  readonly changedFiles?: number;
}

/**
 * A point the workspace can go back to (Orchestration 7.1): each input of the user, and each cut
 * inside a run. Its stretch runs to the next point, or to where the run went still (`end`).
 */
interface Point {
  readonly checkpointId: string;
  readonly kind: CheckpointKind;
  readonly label: string;
  readonly snapshot?: string;
  readonly at: string;
  /** The Turn an older index line named; only to read what it reverted. */
  readonly turnId?: string;
  end?: string;
}

/** What the stretch since the latest input left behind, when the run went still. */
export interface SettledSnapshots {
  readonly startSnapshot?: string;
  readonly endSnapshot?: string;
  readonly changedFileCount?: number;
}

interface PlannedFile {
  readonly path: string;
  /** Absent when the file did not exist at the checkpoint. */
  readonly target?: Entry;
}

/** A way back to a checkpoint, found before anything is written (Kernel/Execution 6c). */
export interface RollBackPlan {
  readonly checkpointId: string;
  readonly label: string;
  /** An undo: the checkpoint itself is taken back, and the work from it on. */
  readonly inclusive: boolean;
  readonly files: readonly PlannedFile[];
  /** The workspace as the plan saw it; a file differing from it at write time stops the undo. */
  readonly currentTree: string;
  readonly external: readonly {
    readonly path: string;
    readonly change: FileChange | 'UNKNOWN';
  }[];
}

export type RollBackPlanResult =
  | { readonly kind: 'PLAN'; readonly plan: RollBackPlan }
  | { readonly kind: 'NOTHING_TO_UNDO' }
  | { readonly kind: 'NOT_UNDOABLE' };

export type RollBackApplied =
  | { readonly ok: true; readonly files: readonly string[]; readonly backupSnapshot?: string }
  | { readonly ok: false };

export interface StretchDiff {
  readonly files: readonly { readonly path: string; readonly change: FileChange }[];
  readonly diff: string;
}

export interface WorkspaceSnapshotsDeps {
  readonly repositoryRoot: string;
  /** The shadow git directory: `sessions/<id>/kernel-execution/snapshots`. */
  readonly directory: string;
  readonly index: AppendLogPort<SnapshotIndexLine>;
  readonly git: SubprocessRunner;
  readonly files: WorkspaceFiles;
  readonly shadow: ShadowFiles;
  /** Everything a snapshot leaves out. */
  readonly rules: readonly string[];
  readonly now: () => Date;
  /** Says that a checkpoint has no way back; the work itself goes on. */
  readonly diagnostic?: (line: string) => void;
}

class SnapshotFailed extends Error {}

/** What git calls this content, without asking git. */
const blobId = (content: Buffer): string =>
  createHash('sha1')
    .update(`blob ${String(content.length)}\0`)
    .update(content)
    .digest('hex');

const sameEntry = (left: Entry | undefined, right: Entry | undefined): boolean =>
  left?.sha === right?.sha && left?.mode === right?.mode;

function changesBetween(
  from: ReadonlyMap<string, Entry>,
  to: ReadonlyMap<string, Entry>,
): readonly { readonly path: string; readonly change: FileChange }[] {
  const changes: { path: string; change: FileChange }[] = [];
  for (const [path, entry] of to) {
    const before = from.get(path);
    if (before === undefined) changes.push({ path, change: 'ADDED' });
    else if (!sameEntry(before, entry)) changes.push({ path, change: 'MODIFIED' });
  }
  for (const path of from.keys()) if (!to.has(path)) changes.push({ path, change: 'DELETED' });
  return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The id of the input checkpoint an older index line's Turn stands for. */
export const inputCheckpointOf = (turnId: string): string =>
  `ckp_${turnId.slice(turnId.indexOf('_') + 1)}`;

/**
 * The shadow git repository of one Session (Kernel/Execution 6b, 6c). It needs nothing of the
 * analysed repository, not even that it is one, and only ever runs at a still point: the actor
 * holds every message until a capture is done. Its points are checkpoints only; an undo and a
 * rewind are the same way back (Orchestration 7.5, D8).
 */
export class WorkspaceSnapshots {
  readonly #deps: WorkspaceSnapshotsDeps;
  readonly #points: Point[] = [];
  readonly #trees = new Map<string, ReadonlyMap<string, Entry>>();
  /** The snapshot a rollback left, where no point marks it: the workspace as the system put it. */
  #restored: string | undefined;
  #ready = false;

  public constructor(deps: WorkspaceSnapshotsDeps) {
    this.#deps = deps;
  }

  /**
   * Reads the index; this works after a restart, without the Workflow log. Older indexes speak
   * of Turns: a Turn's start is an input checkpoint, its end settles it, a revert takes it back.
   */
  async load(): Promise<void> {
    await this.#deps.index.repairTail();
    for await (const line of this.#deps.index.readAll()) {
      switch (line.kind) {
        // The Session was opened in another folder: what came before has no way back from here.
        case 'EPOCH':
          this.#points.length = 0;
          this.#restored = undefined;
          break;
        case 'TURN_STARTED':
          this.#add({
            checkpointId: inputCheckpointOf(line.turnId),
            kind: 'INPUT',
            label: 'user input',
            ...(line.startSnapshot === undefined ? {} : { snapshot: line.startSnapshot }),
            at: line.at,
            turnId: line.turnId,
          });
          break;
        case 'TURN_ENDED':
          this.#settle(line.endSnapshot);
          break;
        case 'SETTLED':
          this.#settle(line.snapshot);
          break;
        case 'CHECKPOINT':
          this.#add({
            checkpointId: line.checkpointId,
            kind: line.ckpKind,
            label: line.label,
            ...(line.snapshot === undefined ? {} : { snapshot: line.snapshot }),
            at: line.at,
            ...(line.turnId === undefined ? {} : { turnId: line.turnId }),
          });
          break;
        case 'ROLLED_BACK_TO':
          this.#rolledBack(line.checkpointId, line.inclusive === true);
          break;
        case 'REVERTED': {
          const first = this.#points.find(
            (point) =>
              point.kind === 'INPUT' &&
              point.turnId !== undefined &&
              line.revertedTurnIds.includes(point.turnId),
          );
          if (first !== undefined) this.#rolledBack(first.checkpointId, true);
          break;
        }
      }
    }
  }

  #add(point: Point): void {
    this.#points.push(point);
    this.#restored = undefined;
  }

  #settle(snapshot: string | undefined): void {
    const last = this.#points.at(-1);
    if (last === undefined) return;
    if (snapshot === undefined) delete last.end;
    else last.end = snapshot;
    this.#restored = undefined;
  }

  /** The points after the one gone back to are gone; an undo takes that one too. */
  #rolledBack(checkpointId: string, inclusive: boolean): void {
    const at = this.#points.findIndex((point) => point.checkpointId === checkpointId);
    if (at < 0) return;
    const target = this.#points[at];
    this.#points.splice(inclusive ? at : at + 1);
    if (!inclusive) {
      const kept = this.#points.at(-1);
      if (kept !== undefined) delete kept.end;
    }
    // The workspace is where the target was taken; after an undo, nothing else marks that.
    this.#restored = target?.snapshot;
  }

  /**
   * The Session is opened in another folder (M2Design 2.3). The checkpoints so far were taken of
   * the old one: they stay in the index and the repository, and none of them can be gone back to
   * or diffed from now on. The first snapshot of the new folder starts a chain of its own.
   */
  async startEpoch(): Promise<void> {
    await this.#deps.index.append({
      kind: 'EPOCH',
      repositoryRoot: this.#deps.repositoryRoot,
      at: this.#deps.now().toISOString(),
    });
    this.#points.length = 0;
    this.#restored = undefined;
  }

  async #git(
    args: readonly string[],
    options: {
      readonly stdin?: string;
      readonly encoding?: 'utf8' | 'base64';
      readonly maxOutputBytes?: number;
    } = {},
  ): Promise<string> {
    const { directory, repositoryRoot } = this.#deps;
    const result = await this.#deps.git.run('git', args, {
      cwd: repositoryRoot,
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      maxOutputBytes: options.maxOutputBytes ?? MAX_LIST_BYTES,
      env: {
        GIT_DIR: directory,
        GIT_WORK_TREE: repositoryRoot,
        GIT_INDEX_FILE: `${directory}/${INDEX_FILE}`,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.encoding === undefined ? {} : { encoding: options.encoding }),
    });
    if (result.exitCode !== 0 || result.truncated)
      throw new SnapshotFailed(`git ${args[0] ?? ''} failed`);
    return result.stdout;
  }

  async #prepare(): Promise<void> {
    if (this.#ready) return;
    await this.#git(['init', '-q']);
    await this.#git(['config', 'gc.auto', '0']);
    await this.#git(['config', 'core.autocrlf', 'false']);
    await this.#deps.shadow.write('info/attributes', RAW_ATTRIBUTES);
    this.#ready = true;
  }

  async #entries(tree: string): Promise<ReadonlyMap<string, Entry>> {
    const known = this.#trees.get(tree);
    if (known !== undefined) {
      this.#trees.delete(tree);
      this.#trees.set(tree, known);
      return known;
    }
    const entries = new Map<string, Entry>();
    for (const line of (await this.#git(['ls-tree', '-r', '-z', tree])).split('\0')) {
      if (line === '') continue;
      const tab = line.indexOf('\t');
      const [mode, , sha] = line.slice(0, tab).split(' ');
      if (mode === undefined || sha === undefined) throw new SnapshotFailed('ls-tree output');
      entries.set(line.slice(tab + 1), { mode, sha });
    }
    this.#trees.set(tree, entries);
    for (const oldest of this.#trees.keys()) {
      if (this.#trees.size <= MAX_CACHED_TREES) break;
      this.#trees.delete(oldest);
    }
    return entries;
  }

  /** Anything going wrong is the one failure callers know: this point has no way back. */
  async #capture(): Promise<string> {
    try {
      return await this.#captureTree();
    } catch (error) {
      if (error instanceof SnapshotFailed) throw error;
      throw new SnapshotFailed(String(error));
    }
  }

  /**
   * The index stays between captures, so git hashes again only what changed. One capture runs at
   * a time under the Session's lock, so a lock file here is what a killed git left behind.
   */
  async #captureTree(): Promise<string> {
    await this.#prepare();
    await this.#deps.shadow.remove(`${INDEX_FILE}.lock`);
    const last = this.#latestSnapshot();
    const previous = last === undefined ? new Map<string, Entry>() : await this.#entries(last);
    const files = await this.#deps.files.list(this.#deps.rules);
    const paths = files
      .filter((file) => file.size <= MAX_UNTRACKED_SNAPSHOT_BYTES || previous.has(file.path))
      .map((file) => file.path);
    const wanted = new Set(paths);
    const gone = (await this.#git(['ls-files', '-z']))
      .split('\0')
      .filter((path) => path !== '' && !wanted.has(path));
    if (gone.length > 0)
      await this.#git(['update-index', '--force-remove', '-z', '--stdin'], {
        stdin: `${gone.join('\0')}\0`,
      });
    // --remove: a file that went between the walk and here is simply not there.
    if (paths.length > 0)
      await this.#git(['update-index', '--add', '--remove', '-z', '--stdin'], {
        stdin: `${paths.join('\0')}\0`,
      });
    return (await this.#git(['write-tree'])).trim();
  }

  /** The workspace as the system last knew it. */
  #latestSnapshot(): string | undefined {
    if (this.#restored !== undefined) return this.#restored;
    for (let i = this.#points.length - 1; i >= 0; i -= 1) {
      const point = this.#points[i];
      const tree = point?.end ?? point?.snapshot;
      if (tree !== undefined) return tree;
    }
    return undefined;
  }

  /**
   * A checkpoint (Orchestration 7.1): a snapshot taken at a still point, or while the run holds
   * its mutating work. A failed capture is only a checkpoint with no way back; the run goes on.
   */
  async checkpoint(
    checkpointId: string,
    kind: CheckpointKind,
    label: string,
  ): Promise<string | undefined> {
    const snapshot = await this.#capture().catch(() => undefined);
    if (snapshot === undefined)
      this.#deps.diagnostic?.(`Checkpoint ${checkpointId}: no snapshot, so no way back to it.\n`);
    const at = this.#deps.now().toISOString();
    await this.#deps.index.append({
      kind: 'CHECKPOINT',
      checkpointId,
      ckpKind: kind,
      label,
      ...(snapshot === undefined ? {} : { snapshot }),
      at,
    });
    this.#add({ checkpointId, kind, label, ...(snapshot === undefined ? {} : { snapshot }), at });
    return snapshot;
  }

  /**
   * The run went still (it waits for the user, or ended): the stretch of the latest checkpoint
   * ends here. What changed since the latest input is said back.
   */
  async settle(): Promise<SettledSnapshots> {
    if (this.#points.length === 0) return {};
    let end = await this.#capture().catch(() => undefined);
    const input = [...this.#points].reverse().find((point) => point.kind === 'INPUT');
    let changedFileCount: number | undefined;
    if (input?.snapshot !== undefined && end !== undefined)
      try {
        changedFileCount = changesBetween(
          await this.#entries(input.snapshot),
          await this.#entries(end),
        ).length;
      } catch (error) {
        if (!(error instanceof SnapshotFailed)) throw error;
        end = undefined;
      }
    if (end === undefined) this.#deps.diagnostic?.('The run went still: no snapshot.\n');
    await this.#deps.index.append({
      kind: 'SETTLED',
      ...(end === undefined ? {} : { snapshot: end }),
      at: this.#deps.now().toISOString(),
    });
    this.#settle(end);
    return {
      ...(input?.snapshot === undefined ? {} : { startSnapshot: input.snapshot }),
      ...(end === undefined ? {} : { endSnapshot: end }),
      ...(changedFileCount === undefined ? {} : { changedFileCount }),
    };
  }

  /** Where the stretch of the point at `index` starts and ends; each end needs its snapshot. */
  #stretch(index: number): { readonly from?: string; readonly to?: string } {
    const point = this.#points[index];
    const next = this.#points[index + 1];
    const to = next === undefined ? point?.end : next.snapshot;
    return {
      ...(point?.snapshot === undefined ? {} : { from: point.snapshot }),
      ...(to === undefined ? {} : { to }),
    };
  }

  async listCheckpoints(): Promise<readonly CheckpointPoint[]> {
    const listed: CheckpointPoint[] = [];
    for (const [index, point] of this.#points.entries()) {
      const { from, to } = this.#stretch(index);
      let changedFiles: number | undefined;
      if (from !== undefined && to !== undefined)
        try {
          changedFiles = changesBetween(await this.#entries(from), await this.#entries(to)).length;
        } catch (error) {
          if (!(error instanceof SnapshotFailed)) throw error;
        }
      listed.push({
        seq: index + 1,
        kind: point.kind,
        label: point.label,
        at: point.at,
        ...(changedFiles === undefined ? {} : { changedFiles }),
      });
    }
    return listed;
  }

  /** What the stretch of the `seq`-th point changed; undefined without both of its snapshots. */
  async diffCheckpoint(seq: number): Promise<StretchDiff | undefined> {
    if (seq < 1) return undefined;
    const { from, to } = this.#stretch(seq - 1);
    if (from === undefined || to === undefined) return undefined;
    try {
      const files = changesBetween(await this.#entries(from), await this.#entries(to));
      const diff = await this.#git([
        'diff-tree',
        '-p',
        '-r',
        '--no-renames',
        '--no-color',
        '--no-ext-diff',
        from,
        to,
      ]);
      return { files, diff };
    } catch (error) {
      if (error instanceof SnapshotFailed) return undefined;
      throw error;
    }
  }

  /** The stretch of the n-th latest point (`/diff n`); in a chat, the n-th latest exchange. */
  async diffLatest(n: number): Promise<StretchDiff | undefined> {
    return this.diffCheckpoint(this.#points.length - n + 1);
  }

  /**
   * An undo (Kernel/Execution 6c, steps 1 and 2): back to the latest checkpoint, or the first,
   * taking it back too. It compares the files with what the system left and names those changed
   * outside it, so the user decides before they are overwritten.
   */
  async planUndo(scope: 'LAST' | 'ALL'): Promise<RollBackPlanResult> {
    const target = scope === 'ALL' ? this.#points[0] : this.#points.at(-1);
    if (target === undefined) return { kind: 'NOTHING_TO_UNDO' };
    if (target.snapshot === undefined) return { kind: 'NOT_UNDOABLE' };
    try {
      const currentTree = await this.#capture();
      const current = await this.#entries(currentTree);
      const start = await this.#entries(target.snapshot);
      const left = this.#points.at(-1)?.end;
      // Nothing says what the system left (it stopped before the run went still): every change
      // since the checkpoint may be the system's or not.
      const expected = left === undefined ? undefined : await this.#entries(left);
      const touched = changesBetween(start, expected ?? current).map((change) => change.path);
      const external: { path: string; change: FileChange | 'UNKNOWN' }[] = [];
      for (const path of touched) {
        const now = current.get(path);
        const wanted = expected?.get(path);
        if (expected === undefined) external.push({ path, change: 'UNKNOWN' });
        else if (!sameEntry(now, wanted))
          external.push({
            path,
            change: now === undefined ? 'DELETED' : wanted === undefined ? 'ADDED' : 'MODIFIED',
          });
      }
      return {
        kind: 'PLAN',
        plan: {
          checkpointId: target.checkpointId,
          label: target.label,
          inclusive: true,
          files: touched.map((path) => {
            const entry = start.get(path);
            return { path, ...(entry === undefined ? {} : { target: entry }) };
          }),
          currentTree,
          external,
        },
      };
    } catch (error) {
      if (error instanceof SnapshotFailed) return { kind: 'NOT_UNDOABLE' };
      throw error;
    }
  }

  /**
   * A rewind (Orchestration 7.5): back to the `seq`-th point, which stays, so the work goes on
   * from it. Every file that changed since its snapshot is put back; what the workspace held
   * before is kept as a backup snapshot, so a change made outside is never lost.
   */
  async planRewind(seq: number): Promise<RollBackPlanResult> {
    const target = seq < 1 ? undefined : this.#points[seq - 1];
    if (target === undefined) return { kind: 'NOTHING_TO_UNDO' };
    if (target.snapshot === undefined) return { kind: 'NOT_UNDOABLE' };
    try {
      const currentTree = await this.#capture();
      const start = await this.#entries(target.snapshot);
      const changes = changesBetween(start, await this.#entries(currentTree));
      return {
        kind: 'PLAN',
        plan: {
          checkpointId: target.checkpointId,
          label: target.label,
          inclusive: false,
          files: changes.map(({ path }) => {
            const entry = start.get(path);
            return { path, ...(entry === undefined ? {} : { target: entry }) };
          }),
          currentTree,
          external: [],
        },
      };
    } catch (error) {
      if (error instanceof SnapshotFailed) return { kind: 'NOT_UNDOABLE' };
      throw error;
    }
  }

  async #restoreEntry(path: string, entry: Entry | undefined): Promise<void> {
    if (entry === undefined) {
      await this.#deps.files.remove(path);
      return;
    }
    const body = await this.#git(['cat-file', 'blob', entry.sha], {
      encoding: 'base64',
      maxOutputBytes: MAX_BLOB_BYTES,
    });
    await this.#deps.files.write(path, Buffer.from(body, 'base64'), entry.mode === '100755');
  }

  /**
   * Kernel/Execution 6c, steps 3 to 5, for an undo and a rewind alike. A file that changed since
   * the plan stops it, and what was written is put back. Forced, or a rewind, it first keeps what
   * it overwrites in a backup snapshot.
   */
  async applyRollBack(plan: RollBackPlan, forced: boolean): Promise<RollBackApplied> {
    const backup = forced || !plan.inclusive;
    try {
      const before = backup ? await this.#capture() : plan.currentTree;
      const base = await this.#entries(before);
      const written: string[] = [];
      for (const file of plan.files) {
        const content = await this.#deps.files.read(file.path).catch(() => undefined);
        const found = content === undefined ? undefined : blobId(content);
        if (found !== base.get(file.path)?.sha) {
          for (const path of written) await this.#restoreEntry(path, base.get(path));
          return { ok: false };
        }
        await this.#restoreEntry(file.path, file.target);
        written.push(file.path);
      }
      await this.#deps.index.append({
        kind: 'ROLLED_BACK_TO',
        checkpointId: plan.checkpointId,
        ...(plan.inclusive ? { inclusive: true } : {}),
        ...(forced ? { forced: true } : {}),
        ...(backup ? { backupSnapshot: before } : {}),
        at: this.#deps.now().toISOString(),
      });
      this.#rolledBack(plan.checkpointId, plan.inclusive);
      return { ok: true, files: written, ...(backup ? { backupSnapshot: before } : {}) };
    } catch (error) {
      if (error instanceof SnapshotFailed) return { ok: false };
      throw error;
    }
  }

  /** What changed since this Session last went still (M2Design 2.3); empty when unknowable. */
  async divergedFiles(): Promise<readonly string[]> {
    const baseline = this.#latestSnapshot();
    if (baseline === undefined) return [];
    try {
      const now = await this.#capture();
      const changes = changesBetween(await this.#entries(baseline), await this.#entries(now));
      return changes.map((change) => change.path);
    } catch (error) {
      if (error instanceof SnapshotFailed) return [];
      throw error;
    }
  }
}
