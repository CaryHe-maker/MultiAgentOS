import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorEnvironment } from '@multiagentos/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryGuardExpectations } from '../harnesses/executor-contract.js';
import { FIXTURE_FILES, createFixtureRepository } from './repository.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'fixture-repository-'));
  roots.push(base);
  const root = join(base, 'repository');
  return await createFixtureRepository(root, join(base, 'outside.txt'));
}

const environment = (_kind: string, scope: ExecutorEnvironment['scope']): ExecutorEnvironment => ({
  scope,
  limits: { deadline: '2099-01-01T00:00:00.000Z', maxOutputBytes: 16_384 },
  signal: new AbortController().signal,
  subprocess: {
    run: () => Promise.resolve({ exitCode: null, signal: null, stdout: '', truncated: false }),
  },
  credentials: { apiKeyFor: () => undefined },
  now: () => new Date('2026-01-01T00:00:00.000Z'),
});

describe('fixture repository', () => {
  it('writes every file kind the repository Executors must tell apart', async () => {
    const repository = await fixture();
    for (const [path, content] of Object.entries(FIXTURE_FILES.text))
      expect(await readFile(join(repository.root, path), 'utf8')).toBe(content);
    expect(await readFile(join(repository.root, '.env'), 'utf8')).toContain('SECRET');
    expect((await readFile(join(repository.root, 'assets/logo.bin'))).includes(0)).toBe(true);
    if (repository.escapingLink !== undefined)
      expect(await readFile(join(repository.root, repository.escapingLink), 'utf8')).toBe(
        'outside the repository\n',
      );
  });

  it('comes with the guard verdicts of ExecutorSet for all three repository Executors', async () => {
    const repository = await fixture();
    const expectations = repositoryGuardExpectations(repository, environment);
    expect(new Set(expectations.map((expectation) => expectation.kind))).toEqual(
      new Set(['FILE_READ', 'REPOSITORY_SEARCH', 'REPOSITORY_ORIENT']),
    );
    const verdicts = new Set(
      expectations.map(({ expected }) =>
        expected.outcome === 'COMPLETED'
          ? 'COMPLETED'
          : `${expected.outcome}:${expected.reasonCode}`,
      ),
    );
    for (const verdict of [
      'COMPLETED',
      'REJECTED:OUT_OF_SCOPE',
      'REJECTED:NOT_FOUND',
      'REJECTED:UNSUPPORTED_FILE',
      'REJECTED:INVALID_RANGE',
      'REJECTED:INVALID_QUERY',
      'REJECTED:LIMIT_EXCEEDED',
      'VIOLATION:SCOPE_MISSING',
    ])
      expect(verdicts).toContain(verdict);
    // Every case names a distinct situation, so a failure points at one rule.
    expect(new Set(expectations.map((expectation) => expectation.name)).size).toBe(
      expectations.length,
    );
  });
});
