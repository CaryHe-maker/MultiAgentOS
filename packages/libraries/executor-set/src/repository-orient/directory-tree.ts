import type { FileSet } from '../repository-access/file-set.js';

interface Directory {
  readonly files: string[];
  readonly directories: Map<string, Directory>;
  count: number;
}

function newDirectory(): Directory {
  return { files: [], directories: new Map(), count: 0 };
}

function buildTree(set: FileSet): Directory {
  const root = newDirectory();
  for (const file of set.files) {
    const parts = file.path.split('/');
    let current = root;
    current.count += 1;
    for (const part of parts.slice(0, -1)) {
      let child = current.directories.get(part);
      if (child === undefined) {
        child = newDirectory();
        current.directories.set(part, child);
      }
      child.count += 1;
      current = child;
    }
    current.files.push(parts[parts.length - 1] as string);
  }
  return root;
}

interface Entry {
  readonly label: string;
  readonly directory?: Directory;
}

const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Directories first, then files, both by name; a directory shows its file count. */
function entries(directory: Directory): Entry[] {
  const directories = [...directory.directories.entries()]
    .sort(([left], [right]) => byName(left, right))
    .map(([name, child]) => ({ label: `${name}/ [${child.count} files]`, directory: child }));
  return [...directories, ...[...directory.files].sort(byName).map((label) => ({ label }))];
}

/**
 * The depth-2 tree of ExecutorSet 4.1 with at most `rootLimit` root entries and `childLimit`
 * entries per root directory; `elided` tells whether any entry was left out.
 */
export function renderTree(
  set: FileSet,
  rootLimit: number,
  childLimit: number,
): { text: string; elided: boolean } {
  const root = buildTree(set);
  const lines: string[] = ['Directory tree (depth 2):'];
  let elided = false;
  const rootEntries = entries(root);
  for (const entry of rootEntries.slice(0, rootLimit)) {
    lines.push(entry.label);
    if (entry.directory === undefined) continue;
    const childEntries = entries(entry.directory);
    for (const nested of childEntries.slice(0, childLimit)) lines.push(`  ${nested.label}`);
    if (childEntries.length > childLimit) {
      elided = true;
      if (childLimit > 0) lines.push(`  … ${childEntries.length - childLimit} more`);
    }
  }
  if (rootEntries.length > rootLimit) {
    elided = true;
    lines.push(`… ${rootEntries.length - rootLimit} more`);
  }
  return { text: lines.join('\n'), elided };
}

/** The root entries in one line, for `RepositoryOrientOutput.summary`. */
export function topLevelSummary(set: FileSet): string {
  const all = entries(buildTree(set)).map((entry) => entry.label);
  const shown = all.slice(0, 40).join(', ');
  return all.length > 40 ? `${shown}, … ${all.length - 40} more` : shown || '(empty)';
}
