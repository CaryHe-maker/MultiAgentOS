import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Directories read at once by `readTree`. */
const TREE_READS = 8;

/**
 * Reads the directory tree below `start` (relative to `root`, `''` for the root itself), several
 * directories at a time. `visit` gets each directory's entries and returns the subdirectories to
 * read next; an unreadable directory is skipped, as the scans always did. The order directories
 * are read in is not fixed, so what a scan finds must not depend on it: the scans around a
 * command collect into maps and sets, or sort, and count their entries in `visit` itself.
 */
export async function readTree(
  root: string,
  start: string,
  visit: (relative: string, entries: readonly Dirent[]) => Promise<readonly string[]>,
): Promise<void> {
  const pending: string[] = [start];
  let active = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (pending.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < TREE_READS && pending.length > 0) {
        const relative = pending.pop() as string;
        active += 1;
        void (async () => {
          let entries: Dirent[] | undefined;
          try {
            entries = await readdir(join(root, relative), { withFileTypes: true });
          } catch {
            entries = undefined;
          }
          if (entries !== undefined) pending.push(...(await visit(relative, entries)));
        })().then(() => {
          active -= 1;
          pump();
        }, reject);
      }
    };
    pump();
  });
}

/** Runs `each` over `items`, at most `limit` at a time. */
export async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  each: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await each(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
