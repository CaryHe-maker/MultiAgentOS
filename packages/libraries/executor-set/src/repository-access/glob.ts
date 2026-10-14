/**
 * Matcher for the exclusion rules of ExecutorSet 3.2, with the semantics decided in issue #24:
 *
 * - a rule is relative to the repository root and uses `/` as separator;
 * - `**` is a whole segment and matches zero or more segments, `*` matches any characters inside
 *   one segment and `?` exactly one character;
 * - segments starting with a dot are matched like any other (minimatch `dot: true`), so the
 *   default rule for `.pem` files also covers `.config/server.pem`;
 * - matching is case-sensitive, as the file systems of the acceptance platform are;
 * - every other character, including `{`, `[` and `!`, is literal.
 *
 * Node's `path.matchesGlob` is not used: its `**` skips dot directories, which would let
 * `.hidden/key.pem` through the default rules.
 */
export type GlobMatcher = (path: string) => boolean;

const compiled = new Map<string, GlobMatcher>();

export function compileGlob(pattern: string): GlobMatcher {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  const segments = pattern
    .split('/')
    .map((segment) => (segment === '**' ? null : segmentRegExp(segment)));
  const matcher: GlobMatcher = (path) => matchSegments(segments, 0, path.split('/'), 0);
  compiled.set(pattern, matcher);
  return matcher;
}

function segmentRegExp(segment: string): RegExp {
  let source = '';
  for (const character of segment) {
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += character.replace(/[.+^${}()|[\]\\/]/gu, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}

/** `null` stands for `**`. */
function matchSegments(
  pattern: readonly (RegExp | null)[],
  patternIndex: number,
  path: readonly string[],
  pathIndex: number,
): boolean {
  if (patternIndex === pattern.length) return pathIndex === path.length;
  const segment = pattern[patternIndex];
  if (segment === null) {
    for (let next = pathIndex; next <= path.length; next += 1)
      if (matchSegments(pattern, patternIndex + 1, path, next)) return true;
    return false;
  }
  const part = path[pathIndex];
  if (part === undefined || segment === undefined || !segment.test(part)) return false;
  return matchSegments(pattern, patternIndex + 1, path, pathIndex + 1);
}

/** True when `path` (relative, `/`-separated) is hit by any of the rules. */
export function isExcluded(path: string, rules: readonly string[]): boolean {
  return rules.some((rule) => compileGlob(rule)(path));
}

/**
 * True when every path below the directory `directory` is excluded, so a walk can skip it
 * without reading it. Only rules of the form `<prefix>/**` (and `**` itself) can say that.
 */
export function excludesDirectory(directory: string, rules: readonly string[]): boolean {
  return rules.some((rule) => {
    if (rule === '**') return true;
    if (!rule.endsWith('/**')) return false;
    return compileGlob(rule.slice(0, -3))(directory);
  });
}
