import { constants } from 'node:fs';
import { open, readlink, realpath, stat, type FileHandle } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isExcluded, type ExecutorOutcome } from '@multiagentos/contracts';
import { rejected, violation } from '../outcome/outcomes.js';
import { isText } from '../text/text-document.js';
import { normalizeRequestPath } from './request-path.js';
import type { RepositoryScope } from './repository-scope.js';

/** Larger files are refused by FILE_READ with LIMIT_EXCEEDED (issue #26, A4). */
export const MAX_READ_FILE_BYTES = 16 * 1024 * 1024;

export interface GuardedContent {
  /** Normalized request path, relative to the root and `/`-separated. */
  readonly path: string;
  readonly content: Buffer;
}

export type GuardedRead =
  | { readonly ok: true; readonly file: GuardedContent }
  | { readonly ok: false; readonly outcome: ExecutorOutcome };

/** Test seam: runs between the checks on the path and the open, to model a swapped file. */
export interface GuardHooks {
  readonly beforeOpen?: (realPath: string) => Promise<void>;
}

const refuse = (outcome: ExecutorOutcome): GuardedRead => ({ ok: false, outcome });

/** True when `real` is the root or lies below it. */
export function isInside(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The `/`-separated path of `real` relative to the root. */
export function relativeToRoot(root: string, real: string): string {
  return relative(root, real).split(sep).join('/');
}

/**
 * Steps 2–7 of ExecutorSet 3.2 for one path asked for by a model, reading the whole file
 * through the descriptor that passed step 7 (a binary file fails step 6 once its first bytes
 * are known). Step 1 (the scope) is checked by the caller.
 *
 * Step 7 compares the identity (`dev`, `ino`) of the opened descriptor with the file that passed
 * step 5, and on Linux also the path behind `/proc/self/fd` (issue #26, A1): replacing the file
 * or a directory on its path after the checks changes the identity, which is a violation, not a
 * normal rejection, because it means something is racing the guard.
 */
export async function readGuardedFile(
  scope: RepositoryScope,
  requested: string,
  hooks: GuardHooks = {},
): Promise<GuardedRead> {
  const path = normalizeRequestPath(requested);
  if (path === undefined) return refuse(rejected('OUT_OF_SCOPE'));
  if (path !== '.' && isExcluded(path, scope.rules)) return refuse(rejected('OUT_OF_SCOPE'));
  const lexical = join(scope.root, path);
  // A normalized path without `..` can only stay inside the root; anything else means the guard
  // itself is wrong.
  if (!isInside(scope.root, lexical)) return refuse(violation('GUARD_FAILURE'));

  let real: string;
  try {
    real = await realpath(lexical);
  } catch (error) {
    return refuse(rejected(isMissing(error) ? 'NOT_FOUND' : 'UNSUPPORTED_FILE'));
  }
  if (!isInside(scope.root, real)) return refuse(rejected('OUT_OF_SCOPE'));
  const realRelative = relativeToRoot(scope.root, real);
  if (realRelative !== '' && isExcluded(realRelative, scope.rules))
    return refuse(rejected('OUT_OF_SCOPE'));

  const checked = await stat(real, { bigint: true });
  if (!checked.isFile()) return refuse(rejected('UNSUPPORTED_FILE'));
  if (checked.size > BigInt(MAX_READ_FILE_BYTES)) return refuse(rejected('LIMIT_EXCEEDED'));

  await hooks.beforeOpen?.(real);
  let handle: FileHandle;
  try {
    // O_NOFOLLOW: `real` has no links left, so a link here was put in after step 5.
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // A file deleted after the checks cannot lead outside the root; a link put in its place can.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return refuse(rejected('NOT_FOUND'));
    if (code === 'ENOTDIR' || code === 'ELOOP') return refuse(violation('PATH_ESCAPE'));
    return refuse(rejected('UNSUPPORTED_FILE'));
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== checked.dev || opened.ino !== checked.ino || !opened.isFile())
      return refuse(violation('PATH_ESCAPE'));
    if (process.platform === 'linux') {
      const behind = await readlink(`/proc/self/fd/${handle.fd}`);
      if (behind !== real) return refuse(violation('PATH_ESCAPE'));
    }
    const content = await handle.readFile();
    if (!isText(content)) return refuse(rejected('UNSUPPORTED_FILE'));
    return { ok: true, file: { path, content } };
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
