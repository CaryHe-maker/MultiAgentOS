import { realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { isValidExclusionRule } from '@multiagentos/contracts';

/** What the system knows about the machine, for the checks of an external read (Kernel/Core 5h). */
export interface ExternalSupport {
  /** The user's home directory; its dot-files and the directory itself are never readable. */
  readonly homeDir: string;
  /** System data directory (M2Design 6.1): never readable, wherever it is. */
  readonly dataDir?: string;
}

/** Rules every external root gets on top of the repository defaults: where credentials live. */
const EXTERNAL_EXCLUSIONS: readonly string[] = Object.freeze([
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/.kube/**',
  '**/.docker/**',
  '**/.npmrc',
  '**/.netrc',
  '**/.pgpass',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
]);

/** Top-level folders of a Linux system that no external read may enter, with everything below. */
const SYSTEM_FOLDERS: ReadonlySet<string> = new Set([
  'proc',
  'sys',
  'dev',
  'etc',
  'root',
  'boot',
  'run',
  'var',
  'bin',
  'sbin',
  'lib',
  'lib32',
  'lib64',
  'libx32',
  'snap',
]);
/** The folders of a Windows drive (seen from WSL as `/mnt/c`) that belong to the system. */
const WINDOWS_FOLDERS: ReadonlySet<string> = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'recovery',
]);

const segmentsOf = (path: string): string[] => path.split('/').filter((part) => part !== '');

/** `C:\a\b` and `C:/a/b` mean `/mnt/c/a/b` where Windows drives are mounted under `/mnt`. */
function posixForm(raw: string): string | undefined {
  if (raw.includes('\u0000') || raw.length === 0 || raw.length > 1024) return undefined;
  const drive = /^([A-Za-z]):[\\/]/u.exec(raw);
  const slashes = raw.replaceAll('\\', '/');
  const text = drive === null ? raw : `/mnt/${(drive[1] ?? '').toLowerCase()}/${slashes.slice(3)}`;
  return text.startsWith('/') ? posix.normalize(text) : undefined;
}

/**
 * True for what no external read may reach, with everything below it (Kernel/Core 5h): the system's
 * root and its top-level folders, a folder too broad to be one project, the home directory itself and
 * everything in it that starts with a dot, the data directory, and the system folders of a Windows
 * drive. `path` is a real path; the checks apply to it, never to what the model wrote.
 */
export function isDeniedRoot(path: string, support: ExternalSupport): boolean {
  const parts = segmentsOf(path);
  const [first = ''] = parts;
  // `/`, `/opt`, `/home`, `/tmp`: one segment is a whole class of things, not a project.
  if (parts.length < 2) return true;
  if (SYSTEM_FOLDERS.has(first)) return true;
  // `/home/name` and `/Users/name` are somebody's home, with the secrets it holds.
  if ((first === 'home' || first === 'Users') && parts.length < 3) return true;
  if (first === 'mnt') {
    const [, drive = '', top = '', , inUser = ''] = parts.map((part) => part.toLowerCase());
    // `/mnt/c` is the drive, `/mnt/wsl` is the system's own mount.
    if (!/^[a-z]$/u.test(drive) || parts.length < 3) return true;
    if (WINDOWS_FOLDERS.has(top)) return true;
    if (top === 'users' && (parts.length < 5 || inUser.startsWith('.') || inUser === 'appdata'))
      return true;
  }
  const home = segmentsOf(support.homeDir);
  if (home.length > 0 && home.every((part, index) => parts[index] === part)) {
    if (parts.length === home.length) return true;
    if ((parts[home.length] ?? '').startsWith('.')) return true;
  }
  const data = support.dataDir === undefined ? [] : segmentsOf(support.dataDir);
  return data.length > 0 && data.every((part, index) => parts[index] === part);
}

/** The nearest folder at or above `directory` that holds a `.git`, below the broad ones. */
async function gitRootOf(directory: string, support: ExternalSupport): Promise<string | undefined> {
  let current = directory;
  for (;;) {
    if (isDeniedRoot(current, support)) return undefined;
    const found = await stat(posix.join(current, '.git')).catch(() => undefined);
    if (found !== undefined) return current;
    const parent = posix.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

const isUnder = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

/** What a model-written absolute path comes to, once the system has looked at it. */
export type ExternalResolution =
  | { readonly ok: false }
  | {
      readonly ok: true;
      /** The real path of the folder the answer allows; every call below it is covered. */
      readonly root: string;
      /** The requested path, relative to `root` ('' for the root itself). */
      readonly path: string;
      readonly isDirectory: boolean;
      /** Rules on top of the defaults: the credential places and the data directory below the root. */
      readonly exclusions: readonly string[];
    };

/**
 * Turns the path the model gave into the folder that is asked about and the path below it. The one
 * place that decides, so a refusal never says why: a path that does not exist, is not absolute, lies
 * in the workspace or in what is never readable gets the same answer (`{ ok: false }`).
 *
 * `granted` are the roots the user allowed in this run: a path below one of them keeps that root, so
 * one answer covers a repository whatever file inside it the model names next.
 */
export async function resolveExternal(
  raw: string,
  context: {
    readonly support: ExternalSupport;
    /** The real path of the workspace: reading it is what `read_file` is for. */
    readonly repositoryRoot: string;
    readonly granted: readonly string[];
  },
): Promise<ExternalResolution> {
  const wanted = posixForm(raw);
  if (wanted === undefined) return { ok: false };
  let real: string;
  let isDirectory: boolean;
  try {
    real = await realpath(wanted);
    const found = await stat(real);
    if (!found.isDirectory() && !found.isFile()) return { ok: false };
    isDirectory = found.isDirectory();
  } catch {
    return { ok: false };
  }
  const repositoryRoot = await realpath(context.repositoryRoot).catch(() => context.repositoryRoot);
  const support: ExternalSupport = {
    ...context.support,
    homeDir: await realpath(context.support.homeDir).catch(() => context.support.homeDir),
  };
  if (isUnder(real, repositoryRoot)) return { ok: false };
  if (isDeniedRoot(real, support)) return { ok: false };
  const covering = context.granted
    .filter((root) => isUnder(real, root))
    .sort((a, b) => b.length - a.length)[0];
  let root = covering;
  if (root === undefined) {
    root = isDirectory
      ? real
      : ((await gitRootOf(posix.dirname(real), support)) ?? posix.dirname(real));
    if (isDeniedRoot(root, support) || isUnder(root, repositoryRoot)) return { ok: false };
  }
  const below = posix.relative(root, real);
  const exclusions = [...EXTERNAL_EXCLUSIONS];
  if (support.dataDir !== undefined && isUnder(support.dataDir, root) && support.dataDir !== root) {
    const rule = `${posix.relative(root, support.dataDir)}/**`;
    // A data directory whose name no rule can state would be left readable: the root is refused.
    if (!isValidExclusionRule(rule)) return { ok: false };
    exclusions.push(rule);
  }
  return { ok: true, root, path: below, isDirectory, exclusions };
}
