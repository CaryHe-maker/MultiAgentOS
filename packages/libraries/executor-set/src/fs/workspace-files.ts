import { randomBytes } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  excludesDirectory,
  isExcluded,
  type WorkspaceFile,
  type WorkspaceFiles,
} from '@multiagentos/contracts';

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** Refuses a link on the way; a missing directory ends the walk, as nothing can be below it. */
async function assertNoLinks(root: string, path: string): Promise<void> {
  let current = root;
  for (const segment of path.split('/').slice(0, -1)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`A link on the way to ${path}`);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

/**
 * The repository as snapshots and undo see it (Kernel/Execution 6b, 6c). Nothing here follows a
 * link, and undo writes the way `file-write` does: a reader or a crash sees the old file or the
 * new one. Which files to touch and whether they are as expected is the caller's business.
 */
export function createWorkspaceFiles(repositoryRoot: string): WorkspaceFiles {
  const rootOf = () => realpath(repositoryRoot);

  async function walk(
    root: string,
    directory: string,
    rules: readonly string[],
    found: WorkspaceFile[],
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, directory), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (isExcluded(path, rules)) continue;
      if (entry.isDirectory()) {
        if (!excludesDirectory(path, rules)) await walk(root, path, rules, found);
      } else if (entry.isFile()) {
        const { size } = await lstat(join(root, path)).catch(() => ({ size: 0 }));
        found.push({ path, size });
      }
    }
  }

  return {
    list: async (rules) => {
      const found: WorkspaceFile[] = [];
      await walk(await rootOf(), '', rules, found);
      return found;
    },
    read: async (path) => {
      const root = await rootOf();
      await assertNoLinks(root, path);
      try {
        const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          return await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    write: async (path, content, mode) => {
      const root = await rootOf();
      await assertNoLinks(root, path);
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await assertNoLinks(root, path);
      const kept = await lstat(absolute).catch(() => undefined);
      if (kept?.isSymbolicLink() === true) throw new Error(`${path} is a link`);
      const temporary = join(
        dirname(absolute),
        `.${randomBytes(8).toString('hex')}.multiagentos-write`,
      );
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o666,
      );
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await chmod(temporary, mode ?? kept?.mode ?? 0o644);
        await rename(temporary, absolute);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    remove: async (path) => {
      const root = await rootOf();
      await assertNoLinks(root, path);
      await rm(join(root, path), { force: true });
    },
  };
}
