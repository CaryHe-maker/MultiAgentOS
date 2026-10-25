import type { SearchMode } from '@multiagentos/contracts';

/**
 * The keywords of the SYMBOL pattern of ExecutorSet 3.3, plus `func`, `trait`, `namespace` and
 * `module` so Go, Rust traits, C++ and Ruby declarations are found too.
 */
const DECLARATION_KEYWORDS =
  'function|class|interface|type|const|let|var|def|fn|func|struct|enum|trait|namespace|module';
const MODIFIERS = 'public|private|protected|static|final|abstract|async|override|export';

/**
 * Declarations of `name` (a regex-escaped identifier), as one pattern that means the same in
 * JavaScript and in ripgrep's Rust regex (no look-around, ASCII classes only):
 *
 * - `<keyword> name` — the pattern of ExecutorSet 3.3;
 * - `func (receiver) name` — Go methods;
 * - `#define name` — C macros;
 * - `type name(` at column 0 — C and C++ functions, which have no keyword;
 * - `<modifier> ... name(` — Java, C# and TypeScript methods.
 */
export function declarationPattern(name: string): string {
  return [
    `\\b(?:${DECLARATION_KEYWORDS})[ \\t]+${name}\\b`,
    `\\bfunc[ \\t]*\\([^)]*\\)[ \\t]*${name}\\b`,
    `#[ \\t]*define[ \\t]+${name}\\b`,
    `^[A-Za-z_][A-Za-z0-9_ \\t*]*[ \\t*]${name}[ \\t]*\\(`,
    `^[ \\t]*(?:${MODIFIERS})\\b[A-Za-z0-9_ \\t<>,*\\[\\]]*[ \\t]${name}[ \\t]*\\(`,
  ].join('|');
}

/** The SYMBOL query as a pattern, or undefined when it is not an identifier. */
export function escapeIdentifier(query: string): string | undefined {
  return SYMBOL_QUERY.test(query) ? query.replace(/[.$]/gu, '\\$&') : undefined;
}

/**
 * A SYMBOL query must be an ASCII identifier, optionally qualified with `.` or `::`. Anything
 * else cannot form the declaration pattern and is INVALID_QUERY. Keeping the query to these
 * characters also makes the pattern mean the same in JavaScript and in ripgrep's Rust regex.
 */
const SYMBOL_QUERY = /^[A-Za-z_$][A-Za-z0-9_$.:]{0,199}$/u;

/** How one line is tested; shared by the scan backend and the arguments given to `rg`. */
export interface LineQuery {
  readonly kind: 'TEXT' | 'SYMBOL';
  /** The fixed string (TEXT) or the regular expression source (SYMBOL). */
  readonly pattern: string;
  /**
   * Case-insensitive when the query is ASCII without upper-case letters (issue #26, E17):
   * `parse config` finds `parseConfig`-style prose and `ParseConfig`, while `ParseConfig`
   * stays exact. ASCII-only keeps the folding identical in JavaScript and ripgrep.
   */
  readonly ignoreCase: boolean;
}

export interface PreparedQuery {
  readonly query: string;
  readonly mode: SearchMode;
  /** TEXT or SYMBOL line matching; undefined for PATH. */
  readonly line?: LineQuery;
  /** Whether paths are matched (PATH and AUTO). */
  readonly matchPaths: boolean;
}

/** Undefined means INVALID_QUERY. */
export function prepareQuery(raw: string, mode: SearchMode): PreparedQuery | undefined {
  const query = raw.trim();
  if (query.length === 0) return undefined;
  const ignoreCase = foldsCase(query);
  if (mode === 'SYMBOL') {
    const escaped = escapeIdentifier(query);
    if (escaped === undefined) return undefined;
    // `[ \t]+` rather than `\s+`, whose Unicode sets differ between the two engines.
    return {
      query,
      mode,
      line: { kind: 'SYMBOL', pattern: declarationPattern(escaped), ignoreCase: false },
      matchPaths: false,
    };
  }
  if (mode === 'PATH') return { query, mode, matchPaths: true };
  return {
    query,
    mode,
    line: { kind: 'TEXT', pattern: query, ignoreCase },
    matchPaths: mode === 'AUTO',
  };
}

/** A line tester for the scan backend. */
export function lineTester(line: LineQuery): (text: string) => boolean {
  if (line.kind === 'SYMBOL') {
    const expression = new RegExp(line.pattern);
    return (text) => expression.test(text);
  }
  if (line.ignoreCase) {
    const needle = asciiLower(line.pattern);
    return (text) => asciiLower(text).includes(needle);
  }
  return (text) => text.includes(line.pattern);
}

/** Path matching for PATH and AUTO: a substring of the path, folded like TEXT. */
export function pathTester(query: PreparedQuery): (path: string) => boolean {
  const ignoreCase = foldsCase(query.query);
  const needle = ignoreCase ? asciiLower(query.query) : query.query;
  return (path) => (ignoreCase ? asciiLower(path) : path).includes(needle);
}

/**
 * Folds only A–Z. ripgrep runs the same comparison as `(?i-u)`, so both backends agree on
 * every line, including ones with non-ASCII letters whose Unicode folding differs.
 */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function foldsCase(query: string): boolean {
  return /^[\x20-\x7e]*$/u.test(query) && query === asciiLower(query);
}
