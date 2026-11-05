import { lstat, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { DEFAULT_REPOSITORY_EXCLUSIONS, isExcluded } from '@multiagentos/contracts';

/**
 * Which files a command changed (M2Design 7.1, "change detection"): the write roots of its
 * AgentRun are scanned before and after, and the difference is the answer. Running AgentRuns hold
 * disjoint roots and commands that write run one at a time, so a change belongs to whoever ran.
 * A file is known by its size, its times and its inode, which change with any write.
 */
export type Fingerprints = ReadonlyMap<string, string>;

export interface ChangeScanOptions {
  readonly repositoryRoot: string;
  /** The Session's own exclusion rules, on top of the default ones. */
  readonly exclusions: readonly string[];
  readonly maxEntries: number;
}

/** Not traversed: `.git` is protected as a whole, and dependencies are reported by no one. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

async function walk(
  options: ChangeScanOptions,
  rules: readonly string[],
  relative: string,
  found: Map<string, string>,
  budget: { left: number; exhausted: boolean },
): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(options.repositoryRoot, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0) {
      budget.exhausted = true;
      return;
    }
    budget.left -= 1;
    const path = relative === '' ? entry.name : posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || isExcluded(path, rules)) continue;
      await walk(options, rules, path, found, budget);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (isExcluded(path, rules)) continue;
      try {
        const stats = await lstat(join(options.repositoryRoot, path));
        found.set(
          path,
          `${String(stats.size)}:${String(stats.mtimeMs)}:${String(stats.ctimeMs)}:${String(stats.ino)}`,
        );
      } catch {
        // Gone between the listing and the stat: the next scan sees it as removed.
      }
    }
  }
}

/** The files under the roots (`.` for the whole repository), or undefined when the tree is too big. */
export async function fingerprintRoots(
  options: ChangeScanOptions,
  roots: readonly string[],
): Promise<Fingerprints | undefined> {
  const rules = [...DEFAULT_REPOSITORY_EXCLUSIONS, ...options.exclusions];
  const found = new Map<string, string>();
  const budget = { left: options.maxEntries, exhausted: false };
  for (const root of roots) {
    const relative = root === '.' ? '' : root;
    let stats;
    try {
      stats = await lstat(join(options.repositoryRoot, relative));
    } catch {
      continue;
    }
    if (stats.isDirectory()) await walk(options, rules, relative, found, budget);
    else if (!isExcluded(relative, rules))
      found.set(
        relative,
        `${String(stats.size)}:${String(stats.mtimeMs)}:${String(stats.ctimeMs)}:${String(stats.ino)}`,
      );
  }
  return budget.exhausted ? undefined : found;
}

/** Added, modified and removed files, sorted. */
export function changesBetween(before: Fingerprints, after: Fingerprints): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}
