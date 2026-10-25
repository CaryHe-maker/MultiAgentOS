import {
  sha256Hex,
  type Executor,
  type ExecutorEnvironment,
  type OrientContextPack,
  type OrientExecutorInput,
} from '@multiagentos/contracts';
import {
  draftTokens,
  finishItems,
  fitToBudget,
  newContextPackId,
  packArtifact,
  packTokens,
  type ItemDraft,
} from '../context-pack/pack-builder.js';
import { completed, guarded, rejected, throwIfAborted, violation } from '../outcome/outcomes.js';
import {
  buildFileSet,
  readSnapshotFile,
  type FileDigestCache,
  type FileSet,
  type RepositoryFile,
} from '../repository-access/file-set.js';
import {
  resolveRepositoryScope,
  type RepositoryScope,
} from '../repository-access/repository-scope.js';
import { lineRangeText, numberLines, parseText } from '../text/text-document.js';
import { renderTree, topLevelSummary } from './directory-tree.js';

type OrientDraft = ItemDraft<OrientContextPack['items'][number]>;

/** Lines of each README and manifest excerpt (ExecutorSet 4.1). */
export const EXCERPT_LINES = 40;

/**
 * Root-level files that say what a repository is and how it is built (issue #26, D16), in the
 * order their excerpts are offered to the budget.
 */
const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'CMakeLists.txt',
  'Makefile',
];
const README = /^readme(?:\.[a-z0-9]+)?$/iu;
const SUMMARY_LIMIT = 4000;

/**
 * Tree shapes tried from the most to the least detailed until the tree fits the budget:
 * `[root entries, entries per second-level directory]`.
 */
const TREE_SHAPES: readonly (readonly [number, number])[] = [
  [100, 30],
  [60, 12],
  [40, 4],
  [25, 0],
  [10, 0],
];

/**
 * REPOSITORY_ORIENT (ExecutorSet 4.1): the snapshot, a depth-2 tree and the first lines of the
 * README and the build manifests, as ORIENT items cut to `tokenBudget`.
 */
export function createOrientExecutor(cache: FileDigestCache): Executor<'REPOSITORY_ORIENT'> {
  return {
    executionKind: 'REPOSITORY_ORIENT',
    execute: (input, environment) => guarded(() => orient(input, environment, cache)),
  };
}

async function orient(
  input: OrientExecutorInput,
  environment: ExecutorEnvironment,
  cache: FileDigestCache,
) {
  throwIfAborted(environment.signal);
  const scope = await resolveRepositoryScope(environment.scope);
  if (scope === undefined) return violation('SCOPE_MISSING');
  const maxFiles = 'maxFiles' in environment.limits ? environment.limits.maxFiles : undefined;
  const built = await buildFileSet(scope, { signal: environment.signal, maxFiles, cache });
  if (!built.ok) return rejected('LIMIT_EXCEEDED');
  const set = built.set;

  const provenance = (path: string, endLine: number, contentSha256: string) => ({
    path,
    startLine: 1,
    endLine,
    contentSha256,
    snapshotId: set.snapshotId,
    retrieval: 'TREE' as const,
  });

  let truncated = false;
  let tree: OrientDraft | undefined;
  for (const [rootLimit, childLimit] of TREE_SHAPES) {
    const rendered = renderTree(set, rootLimit, childLimit);
    const content = `${header(set)}\n${rendered.text}`;
    const draft: OrientDraft = {
      segment: 'ORIENT',
      role: 'user',
      content,
      reason: 'repository layout',
      provenance: provenance('.', 1, sha256Hex(content)),
    };
    if (fitToBudget([draft], input.tokenBudget).kept.length === 1) {
      tree = draft;
      truncated ||= rendered.elided;
      break;
    }
    truncated = true;
  }

  const excerpts = await excerptDrafts(scope, set, provenance, environment.signal);
  const remaining = input.tokenBudget - (tree === undefined ? 0 : draftTokens(tree));
  const fitted = fitToBudget(excerpts, Math.max(remaining, 0));
  const drafts = [...(tree === undefined ? [] : [tree]), ...fitted.kept];
  const droppedCount = fitted.dropped + (tree === undefined ? 1 : 0);
  truncated ||= droppedCount > 0;

  const contextPackId = newContextPackId();
  const items = finishItems<OrientContextPack['items'][number]>(contextPackId, drafts);
  const pack: OrientContextPack = {
    contextPackId,
    operation: 'ORIENT',
    snapshotId: set.snapshotId,
    tokenCount: packTokens(items),
    tokenBudget: input.tokenBudget,
    truncated,
    droppedCount,
    items,
    createdAt: environment.now().toISOString(),
  };
  const read = fitted.kept.map((draft) => draft.provenance.path);
  return completed({
    output: {
      snapshotId: set.snapshotId,
      fileCount: set.files.length,
      totalBytes: set.totalBytes,
      summary: summarize(set, read),
      tokenCount: pack.tokenCount,
      truncated,
    },
    artifact: packArtifact(pack),
  });
}

function header(set: FileSet): string {
  return `Repository snapshot ${set.snapshotId}: ${set.files.length} files, ${set.totalBytes} bytes.`;
}

/** README first, then the manifests in MANIFESTS order; each one's first EXCERPT_LINES lines. */
async function excerptDrafts(
  scope: RepositoryScope,
  set: FileSet,
  provenance: (path: string, endLine: number, contentSha256: string) => OrientDraft['provenance'],
  signal: AbortSignal,
): Promise<OrientDraft[]> {
  const rootFiles = set.files.filter((file) => !file.path.includes('/'));
  const chosen: RepositoryFile[] = [];
  const readme = rootFiles.find((file) => README.test(file.path));
  if (readme !== undefined) chosen.push(readme);
  for (const name of MANIFESTS) {
    const file = rootFiles.find((candidate) => candidate.path === name);
    if (file !== undefined) chosen.push(file);
  }
  const drafts: OrientDraft[] = [];
  for (const file of chosen) {
    throwIfAborted(signal);
    const content = await readSnapshotFile(scope, file);
    if (content === undefined) continue;
    const document = parseText(content);
    const total = document.lines.length;
    if (total === 0) continue;
    const endLine = Math.min(EXCERPT_LINES, total);
    const excerpt = lineRangeText(document, 1, endLine);
    const more =
      endLine < total ? `\n[${total - endLine} more lines; use read_file to see them]` : '';
    drafts.push({
      segment: 'ORIENT',
      role: 'user',
      content: `${file.path} (lines 1-${endLine} of ${total})\n${numberLines(document.lines.slice(0, endLine), 1)}${more}`,
      reason: README.test(file.path) ? 'project readme' : 'build manifest',
      provenance: provenance(file.path, endLine, sha256Hex(excerpt)),
    });
  }
  return drafts;
}

function summarize(set: FileSet, read: readonly string[]): string {
  const parts = [
    `${set.files.length} files, ${set.totalBytes} bytes.`,
    `Top level: ${topLevelSummary(set)}.`,
    ...(read.length === 0 ? [] : [`Excerpts: ${read.join(', ')}.`]),
  ];
  const summary = parts.join(' ');
  return summary.length <= SUMMARY_LIMIT ? summary : `${summary.slice(0, SUMMARY_LIMIT - 1)}…`;
}
