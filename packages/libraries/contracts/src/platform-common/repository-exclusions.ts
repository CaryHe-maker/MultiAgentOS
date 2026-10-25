import { Type } from 'typebox';
import { text } from './schema-helpers.js';

/**
 * Exclusion rules of repository access (M1Interface 3.5). Core shows them to the user and puts
 * them into every REPOSITORY scope; the Executors apply them. Both sides use this one list and
 * this one matcher, so the range the user agreed to is the range that is read.
 *
 * Semantics:
 * - a rule is relative to the repository root and uses `/` as separator;
 * - `**` is a whole segment and matches zero or more segments, `*` matches any characters
 *   inside one segment and `?` exactly one character;
 * - segments starting with a dot are matched like any other, so `**` also enters `.config/`;
 * - matching ignores case: excluding too much is safe, excluding too little leaks a secret;
 * - `{`, `}`, `[`, `]`, `!` and `\` are not supported, and a rule containing one is invalid.
 */
export const DEFAULT_REPOSITORY_EXCLUSIONS: readonly string[] = Object.freeze([
  '**/.git',
  '**/.git/**',
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/node_modules/**',
]);

const UNSUPPORTED = /[{}[\]!\\]/u;

/** False for a rule the matcher cannot apply exactly as written. */
export function isValidExclusionRule(rule: string): boolean {
  if (rule.length === 0 || rule.length > 512 || UNSUPPORTED.test(rule)) return false;
  return rule.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** One exclusion rule; the Schemas of every field that carries rules use it. */
export const ExclusionRuleSchema = Type.Refine(
  text(512),
  isValidExclusionRule,
  () => 'exclusion rule must be relative, without empty, "." or ".." segments and without {}[]!\\',
);

type Matcher = (segments: readonly string[]) => boolean;
const compiled = new Map<string, Matcher>();

function compile(rule: string): Matcher {
  const cached = compiled.get(rule);
  if (cached !== undefined) return cached;
  if (!isValidExclusionRule(rule)) throw new Error(`Invalid exclusion rule: ${rule}`);
  const pattern = rule.split('/').map((segment) => (segment === '**' ? null : segmentOf(segment)));
  const matcher: Matcher = (segments) => matchFrom(pattern, 0, segments, 0);
  compiled.set(rule, matcher);
  return matcher;
}

function segmentOf(segment: string): RegExp {
  let source = '';
  for (const character of segment) {
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[.+^$()|/]/gu, '\\$&');
  }
  return new RegExp(`^${source}$`, 'iu');
}

/** `null` stands for `**`. */
function matchFrom(
  pattern: readonly (RegExp | null)[],
  patternIndex: number,
  segments: readonly string[],
  segmentIndex: number,
): boolean {
  if (patternIndex === pattern.length) return segmentIndex === segments.length;
  const part = pattern[patternIndex];
  if (part === null) {
    for (let next = segmentIndex; next <= segments.length; next += 1)
      if (matchFrom(pattern, patternIndex + 1, segments, next)) return true;
    return false;
  }
  const segment = segments[segmentIndex];
  if (part === undefined || segment === undefined || !part.test(segment)) return false;
  return matchFrom(pattern, patternIndex + 1, segments, segmentIndex + 1);
}

/**
 * True when `path` (relative to the repository root, `/`-separated) is hit by any rule.
 * Throws for an invalid rule: the Schemas keep invalid rules out, so one here is a defect.
 */
export function isExcluded(path: string, rules: readonly string[]): boolean {
  const segments = path.split('/');
  return rules.some((rule) => compile(rule)(segments));
}

/**
 * True when every path below `directory` is excluded, so a walk can skip it without reading
 * it. Only a rule of the form `<prefix>/**` whose prefix matches the directory can say that.
 */
export function excludesDirectory(directory: string, rules: readonly string[]): boolean {
  const segments = directory.split('/');
  return rules.some((rule) => {
    if (rule === '**') return true;
    return rule.endsWith('/**') && compile(rule.slice(0, -3))(segments);
  });
}
