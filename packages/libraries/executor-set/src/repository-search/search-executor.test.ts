import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  SearchContextPackSchema,
  validate,
  type ExecutorOutcome,
  type SearchContextPack,
  type SearchExecutorInput,
  type SubprocessRunner,
} from '@multiagentos/contracts';
import { createSubprocessRunner } from '@multiagentos/kernel';
import { describe, expect, it } from 'vitest';
import { FileDigestCache } from '../repository-access/file-set.js';
import { emptyDirectory, environmentFor, repositoryScope } from '../test-support/environments.js';
import { hasRipgrep } from './search-backends.js';
import { createSearchExecutor, type SearchBackend } from './search-executor.js';

const FILES: Record<string, string> = {
  'src/parser.c': [
    '#include "parser.h"',
    '#define MAX_NAME 64',
    '',
    'static int parse_integer(const char *text, int *out)',
    '{',
    '  return parse_digits(text, out);',
    '}',
    '',
    'int main(void) { return parse_integer("1", 0); }',
  ].join('\n'),
  'src/config.ts': [
    "import { readFile } from 'node:fs';",
    'export interface Config { name: string }',
    'export async function loadConfig(path: string): Promise<Config> {',
    '  return parseConfig(await read(path));',
    '}',
    'export function parseConfig(text: string): Config {',
    '  return JSON.parse(text) as Config;',
    '}',
  ].join('\n'),
  'src/server.go': [
    'package main',
    'type Server struct{}',
    'func (s *Server) Start() error { return nil }',
    'func main() { (&Server{}).Start() }',
  ].join('\n'),
  'test/config.test.ts': "import { parseConfig } from '../src/config';\nparseConfig('{}');\n",
  'dist/config.js': 'export function parseConfig(text) { return JSON.parse(text); }\n',
  'docs/Ünïcode.md': 'Kelvin K and long ſ and ParseConfig in prose\n',
  '.env': 'parseConfig=secret\n',
  'node_modules/lib/index.js': 'function parseConfig() {}\n',
};

async function repository(): Promise<string> {
  const root = await emptyDirectory('search');
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const root = await repository();
const runner = createSubprocessRunner();
const ripgrep = await hasRipgrep(runner);

async function search(
  input: Partial<SearchExecutorInput> & { query: string },
  backend: SearchBackend = 'scan',
  subprocess: SubprocessRunner = runner,
): Promise<{ outcome: ExecutorOutcome; pack?: SearchContextPack }> {
  const executor = createSearchExecutor({ cache: new FileDigestCache(), backend });
  const outcome = await executor.execute(
    { mode: 'AUTO', maxItems: 20, tokenBudget: 8_000, ...input },
    environmentFor('REPOSITORY_SEARCH', repositoryScope(root), { subprocess }),
  );
  return outcome.outcome === 'COMPLETED'
    ? { outcome, pack: JSON.parse(outcome.result.artifact.text) as SearchContextPack }
    : { outcome };
}

const hitsOf = (outcome: ExecutorOutcome) =>
  outcome.outcome === 'COMPLETED' && 'hits' in outcome.result.output
    ? outcome.result.output.hits
    : [];

describe('REPOSITORY_SEARCH (ExecutorSet 3.3, 4.2)', () => {
  it('ranks the definition of a name above its uses', async () => {
    const { outcome, pack } = await search({ query: 'parseConfig' });
    expect(validate(SearchContextPackSchema, pack)).toMatchObject({ ok: true });
    const [first] = hitsOf(outcome);
    expect(first).toMatchObject({ path: 'src/config.ts', matchKind: 'SYMBOL' });
    expect(pack?.items[0]?.content).toContain('6 | export function parseConfig');
  });

  it('never returns excluded files', async () => {
    const paths = hitsOf((await search({ query: 'parseConfig' })).outcome).map((hit) => hit.path);
    expect(paths).not.toContain('.env');
    expect(paths.some((path) => path.startsWith('node_modules/'))).toBe(false);
  });

  it('ranks generated copies below the source', async () => {
    const paths = hitsOf((await search({ query: 'parseConfig', mode: 'TEXT' })).outcome).map(
      (hit) => hit.path,
    );
    expect(paths.indexOf('src/config.ts')).toBeLessThan(paths.indexOf('dist/config.js'));
  });

  it('does not demote test files, which F2 and F4 ask for', async () => {
    const hits = hitsOf((await search({ query: 'parseConfig', mode: 'TEXT' })).outcome);
    // Two matching lines: TEXT base 0.7 × count factor 0.8, with no path factor.
    expect(hits.find((hit) => hit.path === 'test/config.test.ts')?.score).toBe(0.56);
  });

  it.each([
    ['parse_integer', 'src/parser.c', 4],
    ['MAX_NAME', 'src/parser.c', 2],
    ['Start', 'src/server.go', 3],
    ['Config', 'src/config.ts', 2],
  ])('finds the declaration of %s with SYMBOL', async (query, path, line) => {
    const hits = hitsOf((await search({ query, mode: 'SYMBOL' })).outcome);
    expect(hits[0]).toMatchObject({ path, matchKind: 'SYMBOL' });
    expect(hits[0]?.startLine).toBeLessThanOrEqual(line);
    expect(hits[0]?.endLine).toBeGreaterThanOrEqual(line);
  });

  it('matches paths in PATH mode, preferring an exact file name', async () => {
    const hits = hitsOf((await search({ query: 'config', mode: 'PATH' })).outcome);
    expect(hits[0]?.path).toBe('src/config.ts');
    expect(hits.map((hit) => hit.path).sort()).toEqual([
      'dist/config.js',
      'src/config.ts',
      'test/config.test.ts',
    ]);
    expect(hits.every((hit) => hit.matchKind === 'PATH')).toBe(true);
  });

  it('folds case only for lower-case ASCII queries', async () => {
    const folded = hitsOf((await search({ query: 'parseconfig', mode: 'TEXT' })).outcome);
    const exact = hitsOf((await search({ query: 'ParseConfig', mode: 'TEXT' })).outcome);
    expect(folded.length).toBeGreaterThan(exact.length);
    expect(exact.map((hit) => hit.path)).toEqual(['docs/Ünïcode.md']);
  });

  it.each([
    ['   ', 'AUTO'],
    ['two words', 'SYMBOL'],
    ['a(b', 'SYMBOL'],
  ] as const)('rejects %j in %s mode as INVALID_QUERY', async (query, mode) => {
    expect((await search({ query, mode })).outcome).toEqual({
      outcome: 'REJECTED',
      reasonCode: 'INVALID_QUERY',
    });
  });

  it('cuts to maxItems and marks the result truncated', async () => {
    const { outcome } = await search({ query: 'e', mode: 'TEXT', maxItems: 2 });
    expect(hitsOf(outcome)).toHaveLength(2);
    expect(outcome).toMatchObject({ result: { output: { truncated: true } } });
  });

  it('keeps the pack within the token budget', async () => {
    const { pack } = await search({ query: 'e', mode: 'TEXT', tokenBudget: 300 });
    expect(pack?.tokenCount).toBeLessThanOrEqual(300);
    expect(pack?.truncated).toBe(true);
  });

  it('gives identical results for identical input', async () => {
    const first = await search({ query: 'parse' });
    const second = await search({ query: 'parse' });
    expect(hitsOf(second.outcome)).toEqual(hitsOf(first.outcome));
  });
});

// quality-gate.yml installs rg; without this check a broken install only skips the tests below.
it.runIf(process.env['CI'] !== undefined)('finds rg in CI', () => {
  expect(ripgrep).toBe(true);
});

describe.skipIf(!ripgrep)('rg and the scan agree (ExecutorSet 6)', () => {
  it.each([
    ['parseConfig', 'AUTO'],
    ['parseconfig', 'TEXT'],
    ['ParseConfig', 'TEXT'],
    ['k', 'TEXT'],
    ['s', 'TEXT'],
    ['parse_integer', 'SYMBOL'],
    ['Start', 'SYMBOL'],
    ['MAX_NAME', 'SYMBOL'],
    ['return', 'TEXT'],
    ['(', 'TEXT'],
    ['config', 'PATH'],
  ] as const)('%s in %s mode', async (query, mode) => {
    const scanned = await search({ query, mode }, 'scan');
    const searched = await search({ query, mode }, 'ripgrep');
    expect(hitsOf(searched.outcome)).toEqual(hitsOf(scanned.outcome));
    expect(searched.pack?.items.map((item) => item.content)).toEqual(
      scanned.pack?.items.map((item) => item.content),
    );
  });

  it('keeps the same matches when the rg output is cut at maxOutputBytes', async () => {
    const cut = async () => {
      const executor = createSearchExecutor({ cache: new FileDigestCache(), backend: 'ripgrep' });
      const environment = environmentFor('REPOSITORY_SEARCH', repositoryScope(root), {
        subprocess: runner,
      });
      return hitsOf(
        await executor.execute(
          { query: 'e', mode: 'TEXT', maxItems: 50, tokenBudget: 100_000 },
          { ...environment, limits: { ...environment.limits, maxOutputBytes: 1_500 } },
        ),
      );
    };
    const first = await cut();
    expect(first.length).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await cut()).toEqual(first);
  });

  it('stops rg when the execution is aborted', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const watching: SubprocessRunner = {
      run: (command, args, options) => {
        seen = options.signal;
        const running = runner.run(command, args, options);
        controller.abort();
        return running;
      },
    };
    const executor = createSearchExecutor({ cache: new FileDigestCache(), backend: 'ripgrep' });
    const outcome = await executor.execute(
      { query: 'parse', mode: 'TEXT', maxItems: 20, tokenBudget: 8_000 },
      environmentFor('REPOSITORY_SEARCH', repositoryScope(root), {
        subprocess: watching,
        signal: controller.signal,
      }),
    );
    expect(seen?.aborted).toBe(true);
    expect(outcome).toEqual({ outcome: 'FAILED', reasonCode: 'INTERNAL', retryable: false });
  });
});

if (!ripgrep)
  it.skip('rg is not installed: the parity tests did not run (see issue #25)', () => undefined);
