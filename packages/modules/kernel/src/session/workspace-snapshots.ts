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
/** Enough for the snapshots of the Turns at hand; a tree can always be read again. */
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

interface Turn {
  readonly turnId: string;
  readonly startSnapshot?: string;
  endSnapshot?: string;
  ended: boolean;
  changedFiles: readonly { readonly path: string; readonly change: FileChange }[];
  reverted: boolean;
}

export interface TurnSnapshots {
  readonly startSnapshot?: string;
  readonly endSnapshot?: string;
  readonly changedFileCount?: number;
}

interface PlannedFile {
  readonly path: string;
  /** Absent when the file did not exist before the first Turn that changed it. */
  readonly target?: Entry;
}

export interface UndoPlan {
  readonly turnIds: readonly string[];
  readonly files: readonly PlannedFile[];
  /** The workspace as the plan saw it; a file differing from it at write time stops the undo. */
  readonly currentTree: string;
  readonly external: readonly {
    readonly path: string;
    readonly change: FileChange | 'UNKNOWN';
  }[];
}

export type UndoPlanResult =
  | { readonly kind: 'PLAN'; readonly plan: UndoPlan }
  | { readonly kind: 'NOTHING_TO_UNDO' }
  | { readonly kind: 'NOT_UNDOABLE' };

export type UndoApplied =
  { readonly ok: true; readonly backupSnapshot?: string } | { readonly ok: false };

export interface TurnDiffResult {
  readonly turnId: string;
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
  /** Says that a Turn has no way back; the work itself goes on. */
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

/**
 * The shadow git repository of one Session (Kernel/Execution 6b, 6c). It needs nothing of the
 * analysed repository, not even that it is one, and only ever runs at a still point: the actor
 * holds every message until a capture is done.
 */
export class WorkspaceSnapshots {
  readonly #deps: WorkspaceSnapshotsDeps;
  readonly #turns: Turn[] = [];
  readonly #trees = new Map<string, ReadonlyMap<string, Entry>>();
  #ready = false;

  public constructor(deps: WorkspaceSnapshotsDeps) {
    this.#deps = deps;
  }

  /** The last line of a Turn wins; this works after a restart, without the Workflow log. */
  async load(): Promise<void> {
    await this.#deps.index.repairTail();
    for await (const line of this.#deps.index.readAll()) {
      if (line.kind === 'TURN_STARTED')
        this.#turns.push({
          turnId: line.turnId,
          ...(line.startSnapshot === undefined ? {} : { startSnapshot: line.startSnapshot }),
          ended: false,
          changedFiles: [],
          reverted: false,
        });
      else if (line.kind === 'TURN_ENDED') {
        const turn = this.#turns.find((each) => each.turnId === line.turnId);
        if (turn === undefined) continue;
        turn.ended = true;
        turn.changedFiles = line.changedFiles;
        if (line.endSnapshot !== undefined) turn.endSnapshot = line.endSnapshot;
      } else
        for (const turn of this.#turns)
          if (line.revertedTurnIds.includes(turn.turnId)) turn.reverted = true;
    }
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

  /** Anything going wrong is the one failure callers know: this Turn has no way back. */
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

  #latestSnapshot(): string | undefined {
    for (let i = this.#turns.length - 1; i >= 0; i -= 1) {
      const turn = this.#turns[i];
      const tree = turn?.endSnapshot ?? turn?.startSnapshot;
      if (tree !== undefined) return tree;
    }
    return undefined;
  }

  /** A failed capture leaves the Turn running, and not undoable (Kernel/Execution 6b). */
  async turnStarted(turnId: string): Promise<void> {
    const startSnapshot = await this.#capture().catch(() => undefined);
    if (startSnapshot === undefined)
      this.#deps.diagnostic?.(`Turn ${turnId}: no snapshot, so it cannot be undone.\n`);
    const turn: Turn = {
      turnId,
      ...(startSnapshot === undefined ? {} : { startSnapshot }),
      ended: false,
      changedFiles: [],
      reverted: false,
    };
    await this.#deps.index.append({
      kind: 'TURN_STARTED',
      turnId,
      turnSeq: this.#turns.length + 1,
      viewId: 'main',
      ...(startSnapshot === undefined ? {} : { startSnapshot }),
      at: this.#deps.now().toISOString(),
    });
    this.#turns.push(turn);
  }

  async turnEnded(turnId: string): Promise<TurnSnapshots> {
    const turn = this.#turns.find((each) => each.turnId === turnId);
    if (turn === undefined) return {};
    let endSnapshot = await this.#capture().catch(() => undefined);
    let changedFiles: Turn['changedFiles'] = [];
    if (turn.startSnapshot !== undefined && endSnapshot !== undefined)
      try {
        changedFiles = changesBetween(
          await this.#entries(turn.startSnapshot),
          await this.#entries(endSnapshot),
        );
      } catch (error) {
        if (!(error instanceof SnapshotFailed)) throw error;
        endSnapshot = undefined;
      }
    if (endSnapshot === undefined) this.#deps.diagnostic?.(`Turn ${turnId}: no end snapshot.\n`);
    await this.#deps.index.append({
      kind: 'TURN_ENDED',
      turnId,
      ...(endSnapshot === undefined ? {} : { endSnapshot }),
      changedFiles: [...changedFiles],
      at: this.#deps.now().toISOString(),
    });
    turn.ended = true;
    turn.changedFiles = changedFiles;
    if (endSnapshot !== undefined) turn.endSnapshot = endSnapshot;
    return {
      ...(turn.startSnapshot === undefined ? {} : { startSnapshot: turn.startSnapshot }),
      ...(endSnapshot === undefined ? {} : { endSnapshot }),
      ...(endSnapshot === undefined ? {} : { changedFileCount: changedFiles.length }),
    };
  }

  /** What a Turn changed, and what it left behind (or the next start, after an exit). */
  async #effectsOf(turn: Turn): Promise<{
    readonly changed: readonly string[];
    readonly after?: string;
  }> {
    if (turn.ended && turn.endSnapshot !== undefined)
      return { changed: turn.changedFiles.map((c) => c.path), after: turn.endSnapshot };
    const next = this.#turns[this.#turns.indexOf(turn) + 1]?.startSnapshot;
    if (turn.startSnapshot === undefined || next === undefined) return { changed: [] };
    const changes = changesBetween(
      await this.#entries(turn.startSnapshot),
      await this.#entries(next),
    );
    return { changed: changes.map((c) => c.path), after: next };
  }

  /** Kernel/Execution 6c, steps 1 and 2. */
  async planUndo(scope: 'LAST' | 'ALL'): Promise<UndoPlanResult> {
    const open = this.#turns.filter((turn) => !turn.reverted);
    if (open.length === 0) return { kind: 'NOTHING_TO_UNDO' };
    const chosen = scope === 'ALL' ? open : open.slice(-1);
    if (chosen.some((turn) => turn.startSnapshot === undefined)) return { kind: 'NOT_UNDOABLE' };
    try {
      return { kind: 'PLAN', plan: await this.#plan(chosen) };
    } catch (error) {
      if (error instanceof SnapshotFailed) return { kind: 'NOT_UNDOABLE' };
      throw error;
    }
  }

  async #plan(chosen: readonly Turn[]): Promise<UndoPlan> {
    const currentTree = await this.#capture();
    const current = await this.#entries(currentTree);
    const targets = new Map<string, Entry | undefined>();
    const expected = new Map<string, Entry | undefined>();
    const unknown = new Set<string>();
    for (const turn of chosen) {
      if (turn.startSnapshot === undefined) throw new SnapshotFailed('no start');
      const start = await this.#entries(turn.startSnapshot);
      const { changed, after } = await this.#effectsOf(turn);
      const lastWithoutEnd = after === undefined;
      // The last Turn left no end and nothing follows: all it could have changed is external.
      const touched = lastWithoutEnd
        ? changesBetween(start, current).map((change) => change.path)
        : changed;
      const left = after === undefined ? undefined : await this.#entries(after);
      for (const path of touched) {
        if (!targets.has(path)) targets.set(path, start.get(path));
        expected.set(path, left?.get(path));
        if (lastWithoutEnd) unknown.add(path);
      }
    }
    const external: { path: string; change: FileChange | 'UNKNOWN' }[] = [];
    for (const [path, wanted] of expected) {
      const now = current.get(path);
      if (unknown.has(path)) external.push({ path, change: 'UNKNOWN' });
      else if (!sameEntry(now, wanted))
        external.push({
          path,
          change: now === undefined ? 'DELETED' : wanted === undefined ? 'ADDED' : 'MODIFIED',
        });
    }
    return {
      turnIds: chosen.map((turn) => turn.turnId),
      files: [...targets].map(([path, target]) => ({
        path,
        ...(target === undefined ? {} : { target }),
      })),
      currentTree,
      external,
    };
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

  /** Kernel/Execution 6c, steps 3 to 5. A forced undo keeps what it overwrites. */
  async applyUndo(plan: UndoPlan, forced: boolean): Promise<UndoApplied> {
    const before = forced ? await this.#capture() : plan.currentTree;
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
      kind: 'REVERTED',
      revertedTurnIds: [...plan.turnIds],
      forced,
      ...(forced ? { backupSnapshot: before } : {}),
      at: this.#deps.now().toISOString(),
    });
    for (const turn of this.#turns) if (plan.turnIds.includes(turn.turnId)) turn.reverted = true;
    return { ok: true, ...(forced ? { backupSnapshot: before } : {}) };
  }

  /** The n-th latest Turn not reverted; undefined when there is none, or it has no snapshots. */
  async diffTurn(n: number): Promise<TurnDiffResult | undefined> {
    const open = this.#turns.filter((turn) => !turn.reverted);
    const turn = open[open.length - n];
    if (turn?.startSnapshot === undefined) return undefined;
    const end = turn.endSnapshot;
    if (end === undefined) return undefined;
    try {
      const diff = await this.#git([
        'diff-tree',
        '-p',
        '-r',
        '--no-renames',
        '--no-color',
        '--no-ext-diff',
        turn.startSnapshot,
        end,
      ]);
      return { turnId: turn.turnId, files: turn.changedFiles, diff };
    } catch (error) {
      if (error instanceof SnapshotFailed) return undefined;
      throw error;
    }
  }

  /** What changed since the last Turn this Session left (M2Design 2.3); empty when unknowable. */
  async divergedFiles(): Promise<readonly string[]> {
    const baseline = this.#baseline();
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

  /** After an undo the workspace is where the oldest reverted Turn of the tail started. */
  #baseline(): string | undefined {
    let baseline: string | undefined;
    for (let i = this.#turns.length - 1; i >= 0; i -= 1) {
      const turn = this.#turns[i];
      if (turn === undefined) break;
      if (!turn.reverted) return baseline ?? turn.endSnapshot ?? turn.startSnapshot;
      baseline = turn.startSnapshot;
    }
    return baseline;
  }
}
