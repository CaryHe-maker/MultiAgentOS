import { mkdir, mkdtemp, readdir, lstat, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { DEFAULT_REPOSITORY_EXCLUSIONS, isExcluded } from '@multiagentos/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fingerprintRoots } from './change-scan.js';
import { protectedPathsOf, scanRepository, secretRules } from './sandbox-scan.js';

/**
 * The scans around a command read several directories at a time (tree-read.ts). These are the
 * scans as they were, one directory and one file after another: on any tree, and under any
 * entry budget, the new ones must find exactly what these find, and give up exactly when these do.
 */
const SKIPPED = new Set(['.git', 'node_modules']);
const PROTECTED_DIRS = new Set(['.git', '.multiagentos']);
const PROTECTED_FILES = new Set(['AGENTS.md']);

async function oldFingerprints(
  root: string,
  roots: readonly string[],
  exclusions: readonly string[],
  maxEntries: number,
): Promise<Map<string, string> | undefined> {
  const rules = [...DEFAULT_REPOSITORY_EXCLUSIONS, ...exclusions];
  const found = new Map<string, string>();
  const budget = { left: maxEntries, exhausted: false };
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
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
        if (SKIPPED.has(entry.name) || isExcluded(path, rules)) continue;
        await walk(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (isExcluded(path, rules)) continue;
        const stats = await lstat(join(root, path));
        found.set(
          path,
          `${String(stats.size)}:${String(stats.mtimeMs)}:${String(stats.ctimeMs)}:${String(stats.ino)}`,
        );
      }
    }
  };
  for (const each of roots) {
    const relative = each === '.' ? '' : each;
    const stats = await lstat(join(root, relative)).catch(() => undefined);
    if (stats?.isDirectory() === true) await walk(relative);
    else if (stats !== undefined && !isExcluded(relative, rules))
      found.set(
        relative,
        `${String(stats.size)}:${String(stats.mtimeMs)}:${String(stats.ctimeMs)}:${String(stats.ino)}`,
      );
  }
  return budget.exhausted ? undefined : found;
}

async function oldScan(root: string, rules: readonly string[], maxEntries: number) {
  const found = {
    masked: [] as string[],
    maskedDirs: [] as string[],
    protectedPaths: [] as string[],
  };
  const budget = { left: maxEntries, exhausted: false };
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
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
        if (PROTECTED_DIRS.has(entry.name)) found.protectedPaths.push(path);
        if (SKIPPED.has(entry.name)) continue;
        if (isExcluded(path, rules)) {
          found.maskedDirs.push(path);
          continue;
        }
        await walk(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (isExcluded(path, rules)) found.masked.push(path);
        else if (PROTECTED_FILES.has(entry.name)) found.protectedPaths.push(path);
      }
    }
  };
  await walk('');
  return budget.exhausted
    ? undefined
    : {
        maskedFiles: found.masked.sort(),
        maskedDirs: found.maskedDirs.sort(),
        protectedExisting: found.protectedPaths.sort(),
      };
}

/** Names that hit every kind of rule: protected, skipped, secret, excluded by default, plain. */
const NAMES = [
  'a',
  'b',
  'src',
  'AGENTS.md',
  '.git',
  '.multiagentos',
  'node_modules',
  '.env',
  'k.pem',
  'dist',
  'x.ts',
];
const tree = fc.array(
  fc.record({
    path: fc.array(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 4 }),
    kind: fc.constantFrom('file', 'dir', 'link'),
  }),
  { maxLength: 40 },
);

async function build(entries: { path: string[]; kind: string }[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mao-tree-'));
  for (const { path, kind } of entries) {
    const target = join(root, ...path);
    await mkdir(join(root, ...path.slice(0, -1)), { recursive: true }).catch(() => undefined);
    if (kind === 'dir') await mkdir(target, { recursive: true }).catch(() => undefined);
    else if (kind === 'file') await writeFile(target, path.join('/')).catch(() => undefined);
    else await symlink('/etc', target).catch(() => undefined);
  }
  return root;
}

describe('the scans around a command, read several directories at a time', () => {
  it('find what the scans one directory after another find, and give up when they do', async () => {
    await fc.assert(
      fc.asyncProperty(tree, fc.integer({ min: 1, max: 60 }), async (entries, maxEntries) => {
        const root = await build(entries);
        try {
          expect(
            await fingerprintRoots({ repositoryRoot: root, exclusions: [], maxEntries }, ['.']),
          ).toEqual(await oldFingerprints(root, ['.'], [], maxEntries));
          expect(
            await fingerprintRoots({ repositoryRoot: root, exclusions: ['b/**'], maxEntries }, [
              'src',
              'a',
            ]),
          ).toEqual(await oldFingerprints(root, ['src', 'a'], ['b/**'], maxEntries));
          const options = {
            repositoryRoot: root,
            extraSecretRules: [],
            exclusions: [],
            maxEntries,
          };
          const expected = await oldScan(root, secretRules([]), maxEntries);
          if (expected === undefined)
            await expect(scanRepository(options)).rejects.toThrow('SANDBOX_SCAN_INCOMPLETE');
          else expect(await scanRepository(options)).toEqual(expected);
          // Without secret rules: it walks into what the secret scan masks.
          const plain = await oldScan(root, [], maxEntries);
          if (plain === undefined)
            await expect(protectedPathsOf(options)).rejects.toThrow('SANDBOX_SCAN_INCOMPLETE');
          else
            expect([...(await protectedPathsOf(options))].sort()).toEqual(plain.protectedExisting);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 60 },
    );
  });
});
