import { validate } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import {
  EVAL_CATEGORIES,
  EvalTaskSchema,
  FORBIDDEN_EFFECTS,
  RelativePathSchema,
  WebSnapshotManifestSchema,
  type EvalTask,
} from './eval-task-schema.js';

const valid: EvalTask = {
  schemaVersion: 'v0',
  id: 'F1-001',
  category: 'F1',
  title: 'fee',
  repository: { url: 'https://github.com/example/app', commit: 'c'.repeat(40) },
  question: '计算手续费的函数在金额为零时返回什么？',
  expectedOutcome: 'ANSWERED',
  answerPoints: [{ id: 'P1', text: '返回 0', isRequired: true }],
  evidence: { required: [{ kind: 'CODE', path: 'src/fee.ts', lines: [1, 9] }], optional: [] },
  forbiddenPaths: [],
  forbiddenEffects: ['FILE_WRITE', 'COMMAND', 'TEST', 'NETWORK'],
  budget: { maxSteps: 10 },
  provenance: { author: 'meti', method: 'MANUAL' },
};

const isValid = (value: unknown) => validate(EvalTaskSchema, value).ok;

describe('EvalTaskSchema', () => {
  it('accepts a complete task', () => {
    expect(isValid(valid)).toBe(true);
  });

  it('keeps the category and effect constants in sync with the schema', () => {
    for (const category of EVAL_CATEGORIES) expect(isValid({ ...valid, category })).toBe(true);
    for (const effect of FORBIDDEN_EFFECTS)
      expect(isValid({ ...valid, forbiddenEffects: [effect] })).toBe(true);
  });

  it.each([
    ['extra field', { ...valid, extra: true }],
    ['short commit', { ...valid, repository: { url: valid.repository?.url, commit: 'abc1234' } }],
    ['http url', { ...valid, repository: { url: 'http://x.y/z', commit: 'c'.repeat(40) } }],
    ['bad id', { ...valid, id: 'F6-001' }],
    [
      'zero line',
      {
        ...valid,
        evidence: { required: [{ kind: 'CODE', path: 'a.ts', lines: [0, 3] }], optional: [] },
      },
    ],
    ['no answer points', { ...valid, answerPoints: [] }],
    ['repeated effect', { ...valid, forbiddenEffects: ['TEST', 'TEST'] }],
    ['unknown version', { ...valid, schemaVersion: 'v1' }],
  ])('rejects %s', (_name, value) => {
    expect(isValid(value)).toBe(false);
  });
});

describe('RelativePathSchema', () => {
  it.each(['src/a.ts', 'a', '.github/workflows/ci.yml', 'a/.env.example'])('accepts %s', (path) => {
    expect(validate(RelativePathSchema, path).ok).toBe(true);
  });
  it.each(['/etc/passwd', '../x', 'a/../b', 'a/./b', './a', 'a//b', 'a\\b', 'a/..'])(
    'rejects %s',
    (path) => {
      expect(validate(RelativePathSchema, path).ok).toBe(false);
    },
  );
});

describe('WebSnapshotManifestSchema', () => {
  const manifest = {
    schemaVersion: 'v0',
    snapshotId: 'WEB-001',
    recordedAt: '2026-09-28T00:00:00Z',
    recorder: { tool: 'manual', version: '0' },
    queries: [
      {
        query: 'q',
        engine: 'none',
        resultFile: `search/${'a'.repeat(16)}.json`,
        sha256: 'a'.repeat(64),
      },
    ],
    pages: [],
  };
  it('accepts a manifest and rejects files outside the fixed folders', () => {
    expect(validate(WebSnapshotManifestSchema, manifest).ok).toBe(true);
    const escaped = { ...manifest, queries: [{ ...manifest.queries[0], resultFile: '../x.json' }] };
    expect(validate(WebSnapshotManifestSchema, escaped).ok).toBe(false);
  });
});
