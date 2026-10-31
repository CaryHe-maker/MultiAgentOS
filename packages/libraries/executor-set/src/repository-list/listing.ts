import type { RepositoryListInput, RepositoryListOutput } from '@multiagentos/contracts';
import { normalizeRequestPath } from '../repository-access/request-path.js';
import { retainItems, type PreviewLimits } from '../retention/retention.js';

const DEFAULT_DEPTH = 2;

export interface Listing {
  readonly output: RepositoryListOutput;
  readonly preview: string;
  /** Present exactly when the preview left something out (ExecutorSet 4). */
  readonly full?: string;
}

/** `*` and `?` stay inside a path segment; `**` crosses segments. */
export function globMatcher(glob: string): (path: string) => boolean {
  const source = glob.replace(/[.+^${}()|[\]\\]|\*\*\/?|\*|\?/gu, (token) => {
    if (token.startsWith('**')) return token.endsWith('/') ? '(?:.*/)?' : '.*';
    if (token === '*') return '[^/]*';
    if (token === '?') return '[^/]';
    return `\\${token}`;
  });
  const pattern = new RegExp(`^${source}$`, 'u');
  return (path) => pattern.test(path);
}

interface Directory {
  count: number;
  readonly directories: Map<string, Directory>;
  readonly files: string[];
}
const newDirectory = (): Directory => ({ count: 0, directories: new Map(), files: [] });
const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function render(directory: Directory, depth: number, indent: string, lines: string[]): void {
  for (const [name, child] of [...directory.directories].sort(([a], [b]) => byName(a, b))) {
    lines.push(`${indent}${name}/ [${String(child.count)} files]`);
    if (depth > 1) render(child, depth - 1, `${indent}  `, lines);
  }
  for (const file of [...directory.files].sort(byName)) lines.push(`${indent}${file}`);
}

function countDirectories(directory: Directory): number {
  let total = directory.directories.size;
  for (const child of directory.directories.values()) total += countDirectories(child);
  return total;
}

/**
 * The tree of `list_files` over the same file set the other repository Executors see, so
 * excluded files stay invisible. Undefined when the path leaves the repository or names nothing:
 * the two cases are not told apart (ExecutorSet 5).
 */
export function renderListing(
  paths: readonly string[],
  input: RepositoryListInput,
  limits: PreviewLimits,
): Listing | undefined {
  const base = normalizeRequestPath(input.path ?? '.');
  if (base === undefined) return undefined;
  const prefix = base === '.' ? '' : `${base}/`;
  const inside = paths.filter((path) => path.startsWith(prefix));
  if (inside.length === 0 && base !== '.') return undefined;
  const matches = input.glob === undefined ? () => true : globMatcher(input.glob);

  const root = newDirectory();
  for (const path of inside) {
    const relative = path.slice(prefix.length);
    if (!matches(relative)) continue;
    const parts = relative.split('/');
    let current = root;
    current.count += 1;
    for (const part of parts.slice(0, -1)) {
      const child = current.directories.get(part) ?? newDirectory();
      current.directories.set(part, child);
      child.count += 1;
      current = child;
    }
    current.files.push(parts.at(-1) ?? relative);
  }

  const lines: string[] = [];
  render(root, input.depth ?? DEFAULT_DEPTH, '', lines);
  const retained = retainItems(lines, limits);
  const output: RepositoryListOutput = {
    path: base,
    directoryCount: countDirectories(root),
    fileCount: root.count,
    omittedEntries: retained.omittedItems,
  };
  const text = lines.join('\n');
  if (retained.omittedItems === 0) return { output, preview: text };
  const notice =
    `… ${String(retained.omittedItems)} more entries omitted. ` +
    'Narrow `path` or `depth`, or read the full output with read_output for 7 days.';
  return { output, preview: [...retained.kept, notice].join('\n'), full: text };
}
