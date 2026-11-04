import { posix } from 'node:path';
import { DEFAULT_REPOSITORY_EXCLUSIONS, isExcluded } from './repository-exclusions.js';

/**
 * The one judgement of what may be written (M2Design 6.3). Core decides with it before it asks,
 * the file Executors decide with it again before they touch anything, and the sandbox binds what
 * `writableRoots` returns, so the three cannot disagree. Pure: symbolic links are the Executor's
 * part, because only it looks at the disk.
 */

/** A write root and a request path are relative and `/`-separated; `.` is the repository root. */
export const REPOSITORY_ROOT_PATH = '.';

/**
 * A path asked for by a model must be relative, free of NUL and of `..` segments once normalized.
 * Backslashes and drive letters are refused as well, so a path means the same thing on every
 * platform. Returns the normalized `/`-separated path, `.` for the root itself, or undefined when
 * the path leaves the repository.
 */
export function normalizeRequestPath(input: string): string | undefined {
  if (input.length === 0 || input.includes('\0') || input.includes('\\')) return undefined;
  if (input.startsWith('/') || /^[A-Za-z]:/u.test(input)) return undefined;
  const normalized = posix.normalize(input).replace(/\/+$/u, '');
  if (normalized === '' || normalized === '.') return REPOSITORY_ROOT_PATH;
  if (normalized.split('/').includes('..')) return undefined;
  return normalized;
}

/** What an AgentRun may write: its write roots, and the rules its Session excludes on top. */
export interface WriteProfile {
  readonly writeRoots: readonly string[];
  readonly exclusions: readonly string[];
}

export type WriteAccess =
  | { readonly writable: true; readonly path: string; readonly writeRoot: string }
  | { readonly writable: false; readonly reasonCode: 'WRITE_OUT_OF_SCOPE' | 'PROTECTED_PATH' };

/** Never writable, whatever the user answers: a snapshot does not cover them (M2Design 6.3). */
const PROTECTED_WRITE_RULES: readonly string[] = Object.freeze([
  '**/.multiagentos',
  '**/.multiagentos/**',
]);

const isBelow = (root: string, path: string): boolean =>
  root === REPOSITORY_ROOT_PATH || path === root || path.startsWith(`${root}/`);

/**
 * The same path as a file system that ignores trailing dots and spaces or reads `name:stream` as
 * `name` would see it, so `.git./config` and `.env::$DATA` meet the rules they are meant to hit.
 */
const asFileSystemsSeeIt = (path: string): string =>
  path
    .normalize('NFC')
    .split('/')
    .map((segment) => (segment.split(':')[0] ?? '').replace(/[. ]+$/u, '') || segment)
    .join('/');

/**
 * The directories an AgentRun may write under, normalized and without one nested in another: the
 * sandbox binds exactly these. Throws for a root outside the repository, which registration has
 * already refused, so one here is a defect.
 */
export function writableRoots(profile: Pick<WriteProfile, 'writeRoots'>): readonly string[] {
  const roots = profile.writeRoots.map((root) => {
    const normalized = normalizeRequestPath(root);
    if (normalized === undefined) throw new Error(`Write root leaves the repository: ${root}`);
    return normalized;
  });
  const unique = [...new Set(roots)].sort();
  return unique.filter(
    (root) => !unique.some((other) => other !== root && isBelow(other, root)),
  );
}

/** Scope first, then protection: which root a path falls under is also its resource key. */
export function isWritable(profile: WriteProfile, requested: string): WriteAccess {
  const path = normalizeRequestPath(requested);
  // The root itself is a directory, and a write always names a file.
  if (path === undefined || path === REPOSITORY_ROOT_PATH)
    return { writable: false, reasonCode: 'WRITE_OUT_OF_SCOPE' };
  const writeRoot = writableRoots(profile).find((root) => isBelow(root, path));
  if (writeRoot === undefined) return { writable: false, reasonCode: 'WRITE_OUT_OF_SCOPE' };
  const rules = [...PROTECTED_WRITE_RULES, ...DEFAULT_REPOSITORY_EXCLUSIONS, ...profile.exclusions];
  if (isExcluded(path, rules) || isExcluded(asFileSystemsSeeIt(path), rules))
    return { writable: false, reasonCode: 'PROTECTED_PATH' };
  return { writable: true, path, writeRoot };
}

/** True when `root` covers `path`, the rule by which an authorization entry covers a write. */
export function writeRootCovers(root: string, path: string): boolean {
  return isBelow(root, path);
}

/** True when some path lies under both sets of roots: running AgentRuns must not (M2Design 6.4). */
export function writeRootsOverlap(left: readonly string[], right: readonly string[]): boolean {
  const others = writableRoots({ writeRoots: right });
  return writableRoots({ writeRoots: left }).some((root) =>
    others.some((other) => isBelow(root, other) || isBelow(other, root)),
  );
}

/** An `AGENTS.md` in any directory: writing one is critical (Kernel/Core 5a.2). Ignores case. */
export function isProjectInstructionPath(path: string): boolean {
  const name = asFileSystemsSeeIt(path).split('/').at(-1);
  return name?.toLowerCase() === 'agents.md';
}
