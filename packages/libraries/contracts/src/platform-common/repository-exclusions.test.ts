import { describe, expect, it } from 'vitest';
import { AuthorizationRequestSchema } from '../kernel-control/interaction-events.js';
import { KernelConfigSchema } from '../platform-config/system-config.js';
import {
  DEFAULT_REPOSITORY_EXCLUSIONS,
  ExclusionRuleSchema,
  excludesDirectory,
  isExcluded,
  isValidExclusionRule,
} from './repository-exclusions.js';
import { validate } from './validation.js';

const defaults = DEFAULT_REPOSITORY_EXCLUSIONS;

describe('repository exclusions', () => {
  it('excludes the dangerous files that path.matchesGlob lets through (issue #24)', () => {
    expect(isExcluded('.hidden/x.pem', defaults)).toBe(true);
    expect(isExcluded('.cfg/node_modules/a.js', defaults)).toBe(true);
    expect(isExcluded('src/.git/config', defaults)).toBe(true);
    expect(isExcluded('vendor/lib/.git', defaults)).toBe(true);
    expect(isExcluded('.git', defaults)).toBe(true);
  });

  it('ignores case, so an upper-case secret is excluded too', () => {
    expect(isExcluded('A.PEM', defaults)).toBe(true);
    expect(isExcluded('deploy/.ENV.production', defaults)).toBe(true);
    expect(isExcluded('home/ID_RSA', defaults)).toBe(true);
  });

  it('keeps ordinary files', () => {
    for (const path of [
      'README.md',
      'src/env.ts',
      'docs/keys.md',
      'src/gitignore.ts',
      'a/.github/ci.yml',
    ])
      expect(isExcluded(path, defaults), path).toBe(false);
  });

  it('matches * and ? inside one segment and ** across segments', () => {
    expect(isExcluded('a/b/c.log', ['**/*.log'])).toBe(true);
    expect(isExcluded('c.log', ['**/*.log'])).toBe(true);
    expect(isExcluded('a/c.log', ['*.log'])).toBe(false);
    expect(isExcluded('a1.txt', ['a?.txt'])).toBe(true);
    expect(isExcluded('a12.txt', ['a?.txt'])).toBe(false);
    expect(isExcluded('build/out/x', ['build/**'])).toBe(true);
    expect(isExcluded('src/build/x', ['build/**'])).toBe(false);
  });

  it('treats regular expression characters in a rule literally', () => {
    expect(isExcluded('a+b(1).txt', ['a+b(1).txt'])).toBe(true);
    expect(isExcluded('aab1.txt', ['a+b(1).txt'])).toBe(false);
  });

  it('tells which directories a walk can skip', () => {
    expect(excludesDirectory('node_modules', defaults)).toBe(true);
    expect(excludesDirectory('pkg/.git', defaults)).toBe(true);
    expect(excludesDirectory('src', defaults)).toBe(false);
    expect(excludesDirectory('anything', ['**'])).toBe(true);
  });

  it('rejects rules the matcher cannot apply exactly as written', () => {
    for (const rule of [
      '',
      '/abs',
      'a//b',
      './a',
      'a/../b',
      '**/*.{pem,key}',
      'id_[rd]sa',
      '!keep',
      'a\\b',
    ])
      expect(isValidExclusionRule(rule), rule).toBe(false);
    for (const rule of defaults) expect(isValidExclusionRule(rule), rule).toBe(true);
    expect(() => isExcluded('a', ['[x]'])).toThrow('Invalid exclusion rule');
  });

  it('enforces valid rules in the configuration and in the authorization question', () => {
    expect(validate(ExclusionRuleSchema, '**/*.pem').ok).toBe(true);
    expect(validate(ExclusionRuleSchema, '**/*.{pem,key}').ok).toBe(false);
    const question = {
      type: 'AuthorizationRequest',
      questionId: 'qst_123456',
      capability: 'repo.read',
      repositoryPath: '/repo',
      exclusions: [...defaults],
      provider: 'deepseek',
      expiresAt: '2026-10-14T00:00:00.000Z',
    };
    expect(validate(AuthorizationRequestSchema, question).ok).toBe(true);
    expect(validate(AuthorizationRequestSchema, { ...question, exclusions: ['!x'] }).ok).toBe(
      false,
    );
    const exclusions = KernelConfigSchema.properties.repositoryExclusions;
    expect(validate(exclusions, ['**/*.log']).ok).toBe(true);
    expect(validate(exclusions, ['id_[rd]sa']).ok).toBe(false);
  });
});
