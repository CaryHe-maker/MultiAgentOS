import { posix } from 'node:path';
import {
  sha256Hex,
  type Executor,
  type ExecutorEnvironment,
  type SearchContextPack,
  type SearchExecutorInput,
  type SearchHit,
} from '@multiagentos/contracts';
import {
  draftTokens,
  finishItems,
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
import { lineRangeText, numberLines, parseText, type TextDocument } from '../text/text-document.js';
import {
  hasRipgrep,
  ripgrepSearch,
  scanSearch,
  type LineMatches,
  type SearchRequest,
} from './search-backends.js';
import {
  asciiLower,
  declarationPattern,
  escapeIdentifier,
  pathTester,
  prepareQuery,
  type PreparedQuery,
} from './search-query.js';

type SearchDraft = ItemDraft<SearchContextPack['items'][number]>;
type MatchKind = SearchHit['matchKind'];

/** Lines of context on each side of a matching line (ExecutorSet 4.2). */
export const CONTEXT_LINES = 2;
/** Matches closer than this merge into one hit; a merged hit never exceeds MAX_HIT_LINES. */
const MAX_HIT_LINES = 15;
/** A PATH hit shows the first lines of the file. */
const PATH_HIT_LINES = 5;

const BASE_SCORE: Record<MatchKind, number> = { SYMBOL: 1, PATH: 0.9, TEXT: 0.7 };
/** Build output and vendored code usually repeat the source; their hits rank lower. */
const GENERATED_DIRECTORIES = new Set(['dist', 'build', 'out', 'target', 'coverage', 'vendor']);

/** Which backend answered; exposed for the parity tests. */
export type SearchBackend = 'ripgrep' | 'scan';

export interface SearchExecutorOptions {
  readonly cache: FileDigestCache;
  /** Forces a backend; by default `rg` is used when the runner can start it. */
  readonly backend?: SearchBackend;
}

/**
 * REPOSITORY_SEARCH (ExecutorSet 3.3, 4.2): matches from `rg` or the scan, merged into hits
 * with two lines of context, scored only from match kind, match count and path, cut to
 * `maxItems` and `tokenBudget`.
 */
export function createSearchExecutor(
  options: SearchExecutorOptions,
): Executor<'REPOSITORY_SEARCH'> {
  return {
    executionKind: 'REPOSITORY_SEARCH',
    execute: (input, environment) => guarded(() => search(input, environment, options)),
  };
}

interface Candidate {
  readonly file: RepositoryFile;
  readonly kind: MatchKind;
  readonly startLine: number;
  /** Before clamping to the file's length, which is known only once the file is read. */
  readonly endLine: number;
  readonly score: number;
}

async function search(
  input: SearchExecutorInput,
  environment: ExecutorEnvironment,
  options: SearchExecutorOptions,
) {
  throwIfAborted(environment.signal);
  const scope = await resolveRepositoryScope(environment.scope);
  if (scope === undefined) return violation('SCOPE_MISSING');
  const query = prepareQuery(input.query, input.mode);
  if (query === undefined) return rejected('INVALID_QUERY');
  const maxFiles = 'maxFiles' in environment.limits ? environment.limits.maxFiles : undefined;
  const built = await buildFileSet(scope, {
    signal: environment.signal,
    maxFiles,
    cache: options.cache,
  });
  if (!built.ok) return rejected('LIMIT_EXCEEDED');
  const set = built.set;

  let incomplete = false;
  const documents = new Map<string, TextDocument | undefined>();
  const candidates: Candidate[] = [];
  if (query.matchPaths) candidates.push(...pathCandidates(set, query));
  if (query.line !== undefined) {
    const request: SearchRequest = { scope, set, line: query.line, signal: environment.signal };
    const matches = await findLines(request, environment, options.backend);
    incomplete = matches.incomplete;
    const files = new Map(set.files.map((file) => [file.path, file]));
    const declaration = declarationTester(query);
    for (const [path, lines] of matches.lines) {
      const file = files.get(path);
      if (file === undefined) continue;
      throwIfAborted(environment.signal);
      const document = await documentOf(scope, file, documents);
      if (document === undefined) continue;
      candidates.push(...lineCandidates(file, document, lines, query.line.kind, declaration));
    }
  }

  const ranked = dedupe(candidates.sort(byRank));
  const hits: { candidate: Candidate; endLine: number; document: TextDocument }[] = [];
  let skipped = 0;
  for (const candidate of ranked) {
    if (hits.length === input.maxItems) {
      skipped += 1;
      continue;
    }
    throwIfAborted(environment.signal);
    const document = await documentOf(scope, candidate.file, documents);
    if (document === undefined || document.lines.length === 0) continue;
    hits.push({
      candidate,
      endLine: Math.min(candidate.endLine, document.lines.length),
      document,
    });
  }

  // Greedy fit as in orient: a hit that does not fit is skipped, smaller ones after it may fit.
  const kept: SearchDraft[] = [];
  const keptHits: SearchHit[] = [];
  let used = 0;
  let overBudget = 0;
  for (const { candidate, endLine, document } of hits) {
    const { file, kind, startLine, score } = candidate;
    const draft: SearchDraft = {
      segment: 'SEARCH_HIT',
      role: 'user',
      content: `${file.path}:${startLine}-${endLine} [${kind}, score ${score}]\n${numberLines(document.lines.slice(startLine - 1, endLine), startLine)}`,
      reason: `${kind.toLowerCase()} match for the query`,
      score,
      provenance: {
        path: file.path,
        startLine,
        endLine,
        contentSha256: sha256Hex(lineRangeText(document, startLine, endLine)),
        snapshotId: set.snapshotId,
        retrieval: kind,
      },
    };
    const tokens = draftTokens(draft);
    if (used + tokens > input.tokenBudget) {
      overBudget += 1;
      continue;
    }
    used += tokens;
    kept.push(draft);
    keptHits.push({ path: file.path, startLine, endLine, score, matchKind: kind });
  }
  const truncated = incomplete || skipped > 0 || overBudget > 0;

  const contextPackId = newContextPackId();
  const items = finishItems<SearchContextPack['items'][number]>(contextPackId, kept);
  const pack: SearchContextPack = {
    contextPackId,
    operation: 'SEARCH',
    snapshotId: set.snapshotId,
    tokenCount: packTokens(items),
    tokenBudget: input.tokenBudget,
    truncated,
    droppedCount: skipped + overBudget,
    items,
    createdAt: environment.now().toISOString(),
  };
  return completed({
    output: { snapshotId: set.snapshotId, hits: keptHits, truncated },
    artifact: packArtifact(pack),
  });
}

async function findLines(
  request: SearchRequest,
  environment: ExecutorEnvironment,
  backend: SearchBackend | undefined,
): Promise<LineMatches> {
  const useRipgrep =
    backend === 'ripgrep' || (backend === undefined && (await hasRipgrep(environment.subprocess)));
  if (useRipgrep) {
    const found = await ripgrepSearch(
      request,
      environment.subprocess,
      environment.limits.maxOutputBytes,
    );
    if (found !== undefined) return found;
  }
  return scanSearch(request);
}

function pathCandidates(set: FileSet, query: PreparedQuery): Candidate[] {
  const matches = pathTester(query);
  const wanted = asciiLower(query.query);
  return set.files
    .filter((file) => file.size > 0 && matches(file.path))
    .map((file) => {
      const name = posix.basename(file.path);
      const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
      const exact = asciiLower(name) === wanted || asciiLower(stem) === wanted;
      return {
        file,
        kind: 'PATH' as const,
        startLine: 1,
        endLine: PATH_HIT_LINES,
        score: score('PATH', file.path, 1, exact),
      };
    });
}

/**
 * Windows of ±CONTEXT_LINES around each matching line; overlapping windows merge up to
 * MAX_HIT_LINES. In TEXT and AUTO mode a window whose match declares the queried identifier
 * counts as a SYMBOL match, so a search for a name ranks its definition above its uses; the
 * decision reads the line itself, so both backends rank alike.
 */
function lineCandidates(
  file: RepositoryFile,
  document: TextDocument,
  lines: readonly number[],
  kind: 'TEXT' | 'SYMBOL',
  declaration: ((text: string) => boolean) | undefined,
): Candidate[] {
  const total = document.lines.length;
  const windows: { start: number; end: number; declares: boolean }[] = [];
  for (const line of lines) {
    if (line > total) continue;
    const declares = declaration?.(document.lines[line - 1] ?? '') ?? false;
    const from = Math.max(1, line - CONTEXT_LINES);
    const to = Math.min(total, line + CONTEXT_LINES);
    const last = windows[windows.length - 1];
    if (last !== undefined && from <= last.end + 1 && to - last.start + 1 <= MAX_HIT_LINES) {
      last.end = to;
      last.declares ||= declares;
    } else windows.push({ start: from, end: to, declares });
  }
  return windows.map((window) => {
    const windowKind: MatchKind = kind === 'SYMBOL' || window.declares ? 'SYMBOL' : 'TEXT';
    return {
      file,
      kind: windowKind,
      startLine: window.start,
      endLine: window.end,
      score: score(windowKind, file.path, lines.length, false),
    };
  });
}

function declarationTester(query: PreparedQuery): ((text: string) => boolean) | undefined {
  if (query.line?.kind !== 'TEXT') return undefined;
  const escaped = escapeIdentifier(query.query);
  if (escaped === undefined) return undefined;
  const expression = new RegExp(declarationPattern(escaped));
  return (text) => expression.test(text);
}

/** Issue #26, E17: base(kind) × file-name factor × path factor × count factor, in 0..1. */
function score(kind: MatchKind, path: string, count: number, exactName: boolean): number {
  let value = BASE_SCORE[kind] * Math.min(1, 0.6 + 0.1 * count);
  if (exactName) value *= 1.1;
  // Test files are not demoted: F2 and F4 ask for them (issue #26, E).
  const lower = asciiLower(path);
  if (lower.split('/').some((segment) => GENERATED_DIRECTORIES.has(segment))) value *= 0.8;
  return Math.round(Math.min(1, value) * 10_000) / 10_000;
}

function byRank(left: Candidate, right: Candidate): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.file.path !== right.file.path) return left.file.path < right.file.path ? -1 : 1;
  return left.startLine - right.startLine;
}

/** AUTO: of two hits on overlapping lines of one file, only the higher-ranked one stays. */
function dedupe(ranked: readonly Candidate[]): Candidate[] {
  const kept: Candidate[] = [];
  const byFile = new Map<string, Candidate[]>();
  for (const candidate of ranked) {
    const others = byFile.get(candidate.file.path) ?? [];
    const overlaps = others.some(
      (other) => other.startLine <= candidate.endLine && candidate.startLine <= other.endLine,
    );
    if (overlaps) continue;
    others.push(candidate);
    byFile.set(candidate.file.path, others);
    kept.push(candidate);
  }
  return kept;
}

async function documentOf(
  scope: RepositoryScope,
  file: RepositoryFile,
  documents: Map<string, TextDocument | undefined>,
): Promise<TextDocument | undefined> {
  if (documents.has(file.path)) return documents.get(file.path);
  const content = await readSnapshotFile(scope, file);
  const document = content === undefined ? undefined : parseText(content);
  documents.set(file.path, document);
  return document;
}
