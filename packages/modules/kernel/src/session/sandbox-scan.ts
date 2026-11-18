import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import {
  DEFAULT_REPOSITORY_EXCLUSIONS,
  isExcluded,
  type SandboxProfile,
} from '@multiagentos/contracts';
import { readTree } from './tree-read.js';

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

/**
 * Every entry below `relative`, several directories at a time. What is found goes into lists that
 * the callers sort or turn into a set, and the entries are counted as they are listed, so the
 * result and the answer to "too big" do not depend on the order directories are read in.
 */
async function walk(
  root: string,
  relative: string,
  rules: readonly string[],
  exclusions: readonly string[],
  found: Found,
  budget: { left: number; exhausted: boolean },
): Promise<void> {
  await readTree(root, relative, (directory, entries) => {
    const below: string[] = [];
    for (const entry of entries) {
      if (budget.left <= 0) {
        budget.exhausted = true;
        return Promise.resolve([]);
      }
      budget.left -= 1;
      const path = directory === '' ? entry.name : posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (PROTECTED_DIRECTORY_NAMES.has(entry.name)) found.protectedPaths.push(path);
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (isExcluded(path, rules)) {
          found.maskedDirs.push(path);
          continue;
        }
        below.push(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (isExcluded(path, rules)) found.masked.push(path);
        else if (PROTECTED_FILE_NAMES.has(entry.name) && !isExcluded(path, exclusions))
          found.protectedPaths.push(path);
      }
    }
    return Promise.resolve(below);
  });
}

export async function scanRepository(options: ScanOptions): Promise<SandboxScan> {
  const found: Found = { masked: [], maskedDirs: [], protectedPaths: [] };
  const budget = { left: options.maxEntries, exhausted: false };
  await walk(
    options.repositoryRoot,
    '',
    secretRules([...options.extraSecretRules]),
    options.exclusions,
    found,
    budget,
  );
  // A secret deeper in the tree would not be masked: no command runs on a partial scan.
  if (budget.exhausted) throw new Error('SANDBOX_SCAN_INCOMPLETE');
  return {
    maskedFiles: found.masked.sort(),
    maskedDirs: found.maskedDirs.sort(),
    protectedExisting: found.protectedPaths.sort(),
  };
}

/** Protected paths that exist now, for the before-and-after comparison around a command. */
export async function protectedPathsOf(options: ScanOptions): Promise<ReadonlySet<string>> {
  const found: Found = { masked: [], maskedDirs: [], protectedPaths: [] };
  const budget = { left: options.maxEntries, exhausted: false };
  await walk(options.repositoryRoot, '', [], options.exclusions, found, budget);
  if (budget.exhausted) throw new Error('SANDBOX_SCAN_INCOMPLETE');
  return new Set(found.protectedPaths);
}

/** `rename` fails across file systems (a repository on another mount): copy, then remove. */
async function moveAway(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch {
    await cp(source, target, { recursive: true, verbatimSymlinks: true });
    await rm(source, { recursive: true, force: true });
  }
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
  // Sorted: the scan reads directories in no fixed order, and a parent comes before what is in it.
  const created = [...after].filter((path) => !before.has(path)).sort();
  const moved: string[] = [];
  for (const path of created) {
    const target = join(quarantineDir, `${String(Date.now())}-${path.replaceAll('/', '__')}`);
    try {
      await lstat(join(options.repositoryRoot, path));
      await mkdir(quarantineDir, { recursive: true });
      await moveAway(join(options.repositoryRoot, path), target);
    } catch {
      // Could not be moved or removed: it stays, and the report still names it.
    }
    moved.push(path);
  }
  return moved;
}
