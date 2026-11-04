import { lstat, readdir, rename, mkdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import {
  DEFAULT_REPOSITORY_EXCLUSIONS,
  isExcluded,
  type SandboxProfile,
} from '@multiagentos/contracts';

/**
 * What Execution looks for in the repository before a command (M2Design 6.1): the secret files
 * to mask, and the protected paths that already exist and must stay read-only. It uses the same
 * matcher as the file tools, so a command and a tool see the same secrets.
 */
export type SandboxScan = Pick<SandboxProfile, 'maskedFiles' | 'maskedDirs' | 'protectedExisting'>;

/** Not traversed: `.git` is protected as a whole, and the rest is excluded by default. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules']);
const PROTECTED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['.git', '.multiagentos']);
const PROTECTED_FILE_NAMES: ReadonlySet<string> = new Set(['AGENTS.md']);

/** Rules that hide secrets; `.git` and `node_modules` are handled by their own mounts. */
export const secretRules = (extra: readonly string[]): string[] => [
  ...DEFAULT_REPOSITORY_EXCLUSIONS.filter((rule) => !/\.git|node_modules/u.test(rule)),
  ...extra,
];

export interface ScanOptions {
  readonly repositoryRoot: string;
  /** The Session's own exclusion rules and `sandboxMaskedPatterns`. */
  readonly extraSecretRules: readonly string[];
  readonly exclusions: readonly string[];
  readonly maxEntries: number;
}

interface Found {
  readonly masked: string[];
  readonly maskedDirs: string[];
  readonly protectedPaths: string[];
}

async function walk(
  root: string,
  relative: string,
  rules: readonly string[],
  exclusions: readonly string[],
  found: Found,
  budget: { left: number },
): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0) return;
    budget.left -= 1;
    const path = relative === '' ? entry.name : posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (PROTECTED_DIRECTORY_NAMES.has(entry.name)) found.protectedPaths.push(path);
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (isExcluded(path, rules)) {
        found.maskedDirs.push(path);
        continue;
      }
      await walk(root, path, rules, exclusions, found, budget);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (isExcluded(path, rules)) found.masked.push(path);
      else if (PROTECTED_FILE_NAMES.has(entry.name) && !isExcluded(path, exclusions))
        found.protectedPaths.push(path);
    }
  }
}

export async function scanRepository(options: ScanOptions): Promise<SandboxScan> {
  const found: Found = { masked: [], maskedDirs: [], protectedPaths: [] };
  await walk(
    options.repositoryRoot,
    '',
    secretRules([...options.extraSecretRules]),
    options.exclusions,
    found,
    { left: options.maxEntries },
  );
  return {
    maskedFiles: found.masked.sort(),
    maskedDirs: found.maskedDirs.sort(),
    protectedExisting: found.protectedPaths.sort(),
  };
}

/** Protected paths that exist now, for the before-and-after comparison around a command. */
export async function protectedPathsOf(options: ScanOptions): Promise<ReadonlySet<string>> {
  const found: Found = { masked: [], maskedDirs: [], protectedPaths: [] };
  await walk(options.repositoryRoot, '', [], options.exclusions, found, {
    left: options.maxEntries,
  });
  return new Set(found.protectedPaths);
}

/**
 * A command made a protected path that was not there (M2Design 6.1, "new protection"): it moves
 * out of the repository into the Session's quarantine, so that e.g. a hook it wrote never runs
 * when the user next uses git. Returns what was moved.
 */
export async function quarantineNewProtected(
  options: ScanOptions,
  before: ReadonlySet<string>,
  quarantineDir: string,
): Promise<string[]> {
  const after = await protectedPathsOf(options);
  const created = [...after].filter((path) => !before.has(path));
  const moved: string[] = [];
  for (const path of created) {
    const target = join(quarantineDir, `${String(Date.now())}-${path.replaceAll('/', '__')}`);
    try {
      await lstat(join(options.repositoryRoot, path));
      await mkdir(quarantineDir, { recursive: true });
      await rename(join(options.repositoryRoot, path), target);
      moved.push(path);
    } catch {
      // Left in place: the report still names it.
      moved.push(path);
    }
  }
  return moved;
}
