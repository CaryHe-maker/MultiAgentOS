import { describe, expect, it } from 'vitest';
import { matchesGlob } from './glob-match.js';

describe('matchesGlob', () => {
  it.each([
    ['.env', '.env*', true],
    ['config/.env.local', '.env*', true],
    ['src/env.ts', '.env*', false],
    ['secrets/token.txt', 'secrets/', true],
    ['app/secrets/token.txt', 'secrets/', true],
    ['secretsauce.ts', 'secrets/', false],
    ['src/a/b/c.ts', 'src/**/*.ts', true],
    ['src/c.ts', 'src/**/*.ts', true],
    ['lib/c.ts', 'src/**/*.ts', false],
    ['src/a.ts', 'src/?.ts', true],
    ['src/ab.ts', 'src/?.ts', false],
    ['a+b(c).ts', 'a+b(c).ts', true],
  ])('%s vs %s -> %s', (path, pattern, expected) => {
    expect(matchesGlob(path, pattern)).toBe(expected);
  });
});
