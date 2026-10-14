import type { SubprocessRunner } from '@multiagentos/contracts';
import { throwIfAborted } from '../outcome/outcomes.js';
import {
  readSnapshotFile,
  type FileSet,
  type RepositoryFile,
} from '../repository-access/file-set.js';
import type { RepositoryScope } from '../repository-access/repository-scope.js';
import { parseText } from '../text/text-document.js';
import { lineTester, type LineQuery } from './search-query.js';

/** Both backends skip larger files, as `rg --max-filesize 1M` does (issue #26, A4). */
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
/** Files scanned between two yields to the event loop, so aborts and deadlines are seen. */
const SCAN_CHUNK_FILES = 32;

/** Matching line numbers per path, for paths of the file set only. */
export interface LineMatches {
  readonly lines: Map<string, number[]>;
  /** The backend stopped early (its output limit), so some matches may be missing. */
  readonly incomplete: boolean;
}

export interface SearchRequest {
  readonly scope: RepositoryScope;
  readonly set: FileSet;
  readonly line: LineQuery;
  readonly signal: AbortSignal;
}

const searchable = (file: RepositoryFile) => file.size > 0 && file.size <= MAX_SEARCH_FILE_BYTES;

/**
 * The deterministic Node.js scan of ExecutorSet 3.3: every searchable file of the set, in path
 * order, in chunks with a yield in between.
 */
export async function scanSearch(request: SearchRequest): Promise<LineMatches> {
  const test = lineTester(request.line);
  const lines = new Map<string, number[]>();
  const files = request.set.files.filter(searchable);
  for (let index = 0; index < files.length; index += 1) {
    if (index % SCAN_CHUNK_FILES === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfAborted(request.signal);
    }
    const file = files[index] as RepositoryFile;
    const content = await readSnapshotFile(request.scope, file);
    if (content === undefined) continue;
    const matched: number[] = [];
    parseText(content).lines.forEach((text, line) => {
      if (test(text)) matched.push(line + 1);
    });
    if (matched.length > 0) lines.set(file.path, matched);
  }
  return { lines, incomplete: false };
}

const available = new WeakMap<SubprocessRunner, Promise<boolean>>();

/**
 * Whether `rg` can be started through this runner; asked once per runner. The probe has its own
 * short timeout instead of the execution's signal, so an aborted first search cannot leave
 * "no rg" cached for the rest of the process.
 */
export function hasRipgrep(runner: SubprocessRunner): Promise<boolean> {
  let known = available.get(runner);
  if (known === undefined) {
    known = runner
      .run('rg', ['--version'], {
        cwd: '/',
        signal: AbortSignal.timeout(5000),
        maxOutputBytes: 4096,
      })
      .then((result) => result.exitCode === 0)
      .catch(() => false);
    available.set(runner, known);
  }
  return known;
}

/**
 * The arguments of ExecutorSet 3.3, plus three that keep `rg` equivalent to the scan
 * (issue #26, A4): `--no-config` so a user's RIPGREP_CONFIG_PATH cannot change the search,
 * `--text` so binary detection is left to the file set (rg would also skip files with a NUL
 * after the first 8 KiB), and for case folding the ASCII-only `(?i-u)` instead of `-i`.
 */
export function ripgrepArguments(line: LineQuery, rules: readonly string[]): string[] {
  const pattern =
    line.kind === 'SYMBOL'
      ? line.pattern.replaceAll('\\b', '(?-u:\\b)')
      : line.ignoreCase
        ? `(?i-u)${escapeRustRegex(line.pattern)}`
        : line.pattern;
  return [
    '--json',
    '--no-follow',
    '--no-ignore',
    '--hidden',
    '--no-config',
    '--text',
    '--max-filesize',
    '1M',
    ...rules.flatMap((rule) => ['-g', `!${rule}`]),
    ...(line.kind === 'TEXT' && !line.ignoreCase ? ['--fixed-strings'] : []),
    '--',
    pattern,
    '.',
  ];
}

function escapeRustRegex(text: string): string {
  return text.replace(/[\\.+*?()|[\]{}^$#&\-~]/gu, '\\$&');
}

/**
 * Runs `rg` and keeps the matches that belong to the file set. Undefined when `rg` failed in a
 * way that says nothing about the matches (exit code 2 without output, killed without abort),
 * so the caller falls back to the scan.
 */
export async function ripgrepSearch(
  request: SearchRequest,
  runner: SubprocessRunner,
  maxOutputBytes: number,
): Promise<LineMatches | undefined> {
  const result = await runner.run('rg', ripgrepArguments(request.line, request.scope.rules), {
    cwd: request.scope.root,
    signal: request.signal,
    maxOutputBytes,
  });
  throwIfAborted(request.signal);
  if (result.exitCode === null && !result.truncated) return undefined;
  if (result.exitCode === 2 && result.stdout.length === 0) return undefined;
  const members = new Map(request.set.files.filter(searchable).map((file) => [file.path, file]));
  const lines = new Map<string, number[]>();
  const records = result.stdout.split('\n');
  // A truncated output ends in a partial record, which is dropped.
  if (result.truncated) records.pop();
  for (const record of records) {
    const match = parseMatch(record);
    if (match === undefined || !members.has(match.path)) continue;
    const list = lines.get(match.path) ?? [];
    if (list[list.length - 1] !== match.line) list.push(match.line);
    lines.set(match.path, list);
  }
  for (const list of lines.values()) list.sort((left, right) => left - right);
  return { lines, incomplete: result.truncated };
}

function parseMatch(record: string): { path: string; line: number } | undefined {
  if (!record.startsWith('{"type":"match"')) return undefined;
  try {
    const parsed = JSON.parse(record) as {
      data?: { path?: { text?: unknown }; line_number?: unknown };
    };
    const path = parsed.data?.path?.text;
    const line = parsed.data?.line_number;
    if (typeof path !== 'string' || typeof line !== 'number') return undefined;
    return { path: path.startsWith('./') ? path.slice(2) : path, line };
  } catch {
    return undefined;
  }
}
