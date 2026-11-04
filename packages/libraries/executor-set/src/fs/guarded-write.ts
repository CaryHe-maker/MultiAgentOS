import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  isValidExclusionRule,
  isWritable,
  sha256Hex,
  type ExecutionScope,
  type ExecutorOutcome,
} from '@multiagentos/contracts';
import { rejected, throwIfAborted, violation } from '../outcome/outcomes.js';
import { MAX_READ_FILE_BYTES, isInside } from '../repository-access/guarded-file.js';

/** What a write may touch, once the scope has been checked. */
export interface WorkspaceScope {
  /** `scope.repositoryRoot` resolved with `realpath`. */
  readonly root: string;
  readonly writeRoots: readonly string[];
  readonly exclusions: readonly string[];
}

/** Undefined is a security violation: Core must always derive a valid scope for these kinds. */
export async function resolveWorkspaceScope(
  scope: ExecutionScope,
): Promise<WorkspaceScope | undefined> {
  if (scope.kind !== 'WORKSPACE' || !isAbsolute(scope.repositoryRoot)) return undefined;
  if (!scope.exclusions.every(isValidExclusionRule)) return undefined;
  try {
    return {
      root: await realpath(scope.repositoryRoot),
      writeRoots: scope.writableRoots,
      exclusions: scope.exclusions,
    };
  } catch {
    return undefined;
  }
}

/** One writer per path at a time: the check against the base and the rename are one step. */
export class PathLocks {
  readonly #tails = new Map<string, Promise<unknown>>();

  async hold<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const run = previous.then(body, body);
    const tail = run.catch(() => undefined);
    this.#tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

/** Test seam: each runs at the point of the race it models. */
export interface WriteHooks {
  readonly beforeCommit?: (absolutePath: string) => Promise<void>;
  readonly afterRename?: (absolutePath: string) => Promise<void>;
}

export interface WriteExpectation {
  readonly baseSha?: string;
  readonly expectAbsent?: true;
}

export interface WriteRequest {
  readonly scope: WorkspaceScope;
  readonly path: string;
  readonly expected: WriteExpectation;
  readonly signal: AbortSignal;
  /** The new bytes from the current ones, or a refusal that leaves the file alone. */
  readonly produce: (current: Buffer | undefined) => Buffer | ExecutorOutcome;
}

export type WriteResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly existed: boolean;
      readonly sha256: string;
    }
  | { readonly ok: false; readonly outcome: ExecutorOutcome };

const refuse = (outcome: ExecutorOutcome): WriteResult => ({ ok: false, outcome });

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const lstatOf = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/**
 * Step 3: no segment from the root down may be a link. A missing directory ends the walk, because
 * nothing can be below it; the Executor creates it only once the rest has passed.
 */
async function checkSegments(
  root: string,
  path: string,
): Promise<{ readonly missingFrom: number | undefined } | ExecutorOutcome> {
  const segments = path.split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const found = await lstatOf(current);
    if (found === undefined) return { missingFrom: index };
    if (found.isSymbolicLink()) return rejected('OUT_OF_SCOPE');
    const isLast = index === segments.length - 1;
    if (isLast ? !found.isFile() : !found.isDirectory()) return rejected('UNSUPPORTED_FILE');
  }
  return { missingFrom: undefined };
}

async function readCurrent(absolute: string): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

const matches = (current: Buffer | undefined, expected: WriteExpectation): boolean =>
  expected.expectAbsent === true
    ? current === undefined
    : current !== undefined && sha256Hex(current) === expected.baseSha;

/** Creates one directory at a time, so that a link put in meanwhile is seen and not followed. */
async function createParents(root: string, path: string, from: number): Promise<boolean> {
  const segments = path.split('/').slice(0, -1);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    if (index < from) continue;
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const found = await lstat(current);
      if (found.isSymbolicLink() || !found.isDirectory()) return false;
    }
  }
  return true;
}

/**
 * The write check of ExecutorSet 5b, in order; a refusal touches nothing. The first steps are
 * repeated by nobody else: Core judged the same `isWritable` before it asked, and this one holds
 * for what happens after. Whatever is written lands by rename, so a reader or a crash sees the
 * old file or the new one.
 */
export async function writeGuarded(
  request: WriteRequest,
  locks: PathLocks,
  hooks: WriteHooks = {},
): Promise<WriteResult> {
  const { scope, expected, signal, produce } = request;
  const access = isWritable(
    { writeRoots: scope.writeRoots, exclusions: scope.exclusions },
    request.path,
  );
  if (!access.writable) return refuse(rejected(access.reasonCode));
  const { path } = access;
  const absolute = join(scope.root, path);
  // A normalized path without `..` can only stay inside the root.
  if (!isInside(scope.root, absolute)) return refuse(violation('GUARD_FAILURE'));

  return locks.hold(absolute, async () => {
    throwIfAborted(signal);
    const checked = await checkSegments(scope.root, path);
    if ('outcome' in checked) return refuse(checked);

    if (((await lstatOf(absolute))?.size ?? 0) > MAX_READ_FILE_BYTES)
      return refuse(rejected('LIMIT_EXCEEDED'));
    const current = await readCurrent(absolute);
    if (current !== undefined && current.length > MAX_READ_FILE_BYTES)
      return refuse(rejected('LIMIT_EXCEEDED'));
    if (!matches(current, expected)) return refuse(rejected('FILE_CHANGED'));
    const produced = produce(current);
    if (!Buffer.isBuffer(produced)) return refuse(produced);
    if (produced.length > MAX_READ_FILE_BYTES) return refuse(rejected('LIMIT_EXCEEDED'));

    if (checked.missingFrom !== undefined) {
      const created = await createParents(scope.root, path, checked.missingFrom);
      if (!created) return refuse(rejected('OUT_OF_SCOPE'));
    }
    const committed = await commit(absolute, produced, expected, current, signal, hooks);
    if (committed !== undefined) return refuse(committed);

    const parent = await realpath(dirname(absolute));
    if (!isInside(scope.root, parent) || parent !== dirname(absolute))
      return refuse(violation('GUARD_FAILURE'));
    return {
      ok: true,
      path,
      existed: current !== undefined,
      sha256: sha256Hex(produced),
    } as const;
  });
}

/** Step 5: a temporary file beside the target, checked once more, then renamed over it. */
async function commit(
  absolute: string,
  content: Buffer,
  expected: WriteExpectation,
  before: Buffer | undefined,
  signal: AbortSignal,
  hooks: WriteHooks,
): Promise<ExecutorOutcome | undefined> {
  const temporary = join(
    dirname(absolute),
    `.${randomBytes(8).toString('hex')}.multiagentos-write`,
  );
  const mode = before === undefined ? undefined : (await lstat(absolute)).mode & 0o7777;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o666,
  );
  try {
    try {
      await handle.writeFile(content);
      if (mode !== undefined) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(signal);
    await hooks.beforeCommit?.(absolute);
    const found = await lstatOf(absolute);
    if (found?.isSymbolicLink() === true) return rejected('OUT_OF_SCOPE');
    if (!matches(await readCurrent(absolute), expected)) return rejected('FILE_CHANGED');
    await rename(temporary, absolute);
    await hooks.afterRename?.(absolute);
    return undefined;
  } finally {
    // After a successful rename the name is gone and this does nothing.
    await rm(temporary, { force: true });
  }
}

/** The `/`-separated path as Workflow and the user read it. */
export const displayPath = (root: string, absolute: string): string =>
  relative(root, absolute).split(sep).join('/');
