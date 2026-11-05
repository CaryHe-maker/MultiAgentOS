import {
  MEDIA_TYPES,
  isExcluded,
  type Executor,
  type ExecutorEnvironment,
  type GitInspectInput,
} from '@multiagentos/contracts';
import { completed, guarded, rejected, throwIfAborted, violation } from '../outcome/outcomes.js';
import { previewLimitsOf, retainBytes } from '../retention/retention.js';
import { resolveRepositoryScope } from '../repository-access/repository-scope.js';

/** Settings of the user, of the system and of a repository must not reach `git` (M2Design 8.1). */
const SAFE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C.UTF-8',
};

const SAFE_GIT_FLAGS = [
  '--no-pager',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
];

/** The argument list of one action: fixed words, and values the schema already limited. */
export function gitArguments(input: GitInspectInput, rules: readonly string[]): string[] {
  const exclude = excludePathspecs(rules);
  switch (input.action) {
    case 'status':
      return ['status', '--porcelain=v1', '--branch', '--', ...exclude];
    case 'diff':
      return [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        ...(input.staged === true ? ['--staged'] : []),
        '--',
        ...(input.path === undefined ? ['.'] : [input.path]),
        ...exclude,
      ];
    case 'log':
      return [
        'log',
        '--no-ext-diff',
        '--no-textconv',
        '--stat',
        `-n${String(input.limit ?? 20)}`,
        '--',
        ...(input.path === undefined ? ['.'] : [input.path]),
        ...exclude,
      ];
    case 'show':
      return [
        'show',
        '--no-ext-diff',
        '--no-textconv',
        '--stat',
        '--patch',
        `${input.rev ?? 'HEAD'}`,
        '--',
        ...(input.path === undefined ? ['.'] : [input.path]),
        ...exclude,
      ];
    case 'blame':
      return [
        'blame',
        '--no-textconv',
        ...(input.lines === undefined ? [] : [`-L${input.lines}`]),
        ...(input.rev === undefined ? [] : [input.rev]),
        '--',
        input.path ?? '',
      ];
  }
}

/** A pathspec that leaves out what the exclusion rules hide, so `.env` never leaves in a diff. */
function excludePathspecs(rules: readonly string[]): string[] {
  return rules.map((rule) => `:(exclude,glob)${rule}`);
}

/**
 * GIT_INSPECT (ExecutorSet 5c): read-only, fixed sub-commands, no free-form arguments. A blame of
 * an excluded file is refused here, because blame has no pathspec to exclude with.
 */
export function createGitInspectExecutor(): Executor<'GIT_INSPECT'> {
  return {
    executionKind: 'GIT_INSPECT',
    execute: (input, environment) =>
      guarded(async () => {
        const { scope } = environment;
        if (scope.kind !== 'REPOSITORY') return violation('SCOPE_MISSING');
        const resolved = await resolveRepositoryScope(scope);
        if (resolved === undefined) return violation('SCOPE_MISSING');
        if (
          input.path !== undefined &&
          (input.path.startsWith('/') ||
            // `:(top)` and `:!x` are pathspec magic, not file names.
            input.path.startsWith(':') ||
            input.path.split('/').includes('..') ||
            isExcluded(input.path, resolved.rules))
        )
          return rejected('OUT_OF_SCOPE');
        throwIfAborted(environment.signal);
        const limits = previewLimitsOf(environment);
        const probe = await environment.subprocess.run('git', ['rev-parse', '--git-dir'], {
          cwd: scope.repositoryRoot,
          signal: environment.signal,
          maxOutputBytes: 4096,
          env: SAFE_GIT_ENV,
        });
        if (probe.exitCode !== 0) return rejected('NOT_A_GIT_REPOSITORY');
        const ran = await environment.subprocess.run(
          'git',
          [...SAFE_GIT_FLAGS, ...gitArguments(input, resolved.rules)],
          {
            cwd: scope.repositoryRoot,
            signal: environment.signal,
            maxOutputBytes: fullLimit(environment),
            env: SAFE_GIT_ENV,
          },
        );
        throwIfAborted(environment.signal);
        const text = ran.stdout;
        const mediaType = MEDIA_TYPES.fileText;
        if (ran.exitCode !== 0 && text === '')
          return completed({
            output: { action: input.action },
            artifact: {
              mediaType,
              text: `git ${input.action} failed (exit code ${String(ran.exitCode)}). Check that the revision and the path exist.`,
            },
          });
        const body = text === '' ? '(no output)' : text;
        const kept = retainBytes(body, Math.max(1, limits.maxBytes - 400), 'HEAD');
        if (kept.omittedBytes === 0 && !ran.truncated)
          return completed({
            output: { action: input.action },
            artifact: { mediaType, text: body },
          });
        const notice = `\n[${String(kept.omittedBytes)} bytes left out. The full output is kept for 7 days; read it with read_output.]`;
        return completed({
          output: {
            action: input.action,
            retention: {
              strategy: 'HEAD',
              unit: 'BYTES',
              limit: limits.maxBytes,
              retained: Buffer.byteLength(kept.head, 'utf8'),
              omitted: Math.max(1, kept.omittedBytes),
              fullOutputTruncated: ran.truncated,
            },
          },
          artifact: { mediaType, text: `${kept.head}${notice}` },
          fullOutput: { text: body },
        });
      }),
  };
}

const fullLimit = (environment: ExecutorEnvironment): number =>
  'maxFullOutputBytes' in environment.limits
    ? environment.limits.maxFullOutputBytes
    : environment.limits.maxOutputBytes;
