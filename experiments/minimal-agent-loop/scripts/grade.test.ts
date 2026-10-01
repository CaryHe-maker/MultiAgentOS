import { describe, expect, it } from 'vitest';

import { countFileReads, gradeReview, loadAnswerKey, loadComparableRuns } from './grade.js';

describe('c-review answer key', () => {
  const issues = loadAnswerKey();

  it('has unique ids and patterns that compile', () => {
    expect(new Set(issues.map((issue) => issue.id)).size).toBe(issues.length);
    for (const issue of issues) {
      expect(issue.patterns.length).toBeGreaterThan(0);
      for (const pattern of issue.patterns) expect(() => new RegExp(pattern, 'isu')).not.toThrow();
    }
  });

  it('credits an issue only when the report describes it', () => {
    const grade = gradeReview(
      [
        'config_destroy 对 entries 重复释放（double free），见 src/parser.c:88-89。',
        'parse_integer 在 free(copy) 之后读取 *end，属于 use-after-free。',
        '第 32 行 entry->name = duplicate_slice(...) 不检查返回值，分配失败时为 NULL。',
      ].join('\n'),
      issues,
    );
    expect(grade.found).toEqual([
      'double-free',
      'append-name-unchecked',
      'parse-integer-use-after-free',
    ]);
  });

  it('credits English descriptions of the same defects', () => {
    const grade = gradeReview(
      [
        '- src/parser.c:16 - undefined behavior - `*end` is dereferenced after `free(copy)`.',
        '- src/parser.c:63-70 - wrong result - `status` is only assigned inside the loop, so it returns an indeterminate value.',
        '- src/util.c:21-24 - leak - when `bytes_read != file_size` it returns NULL without `fclose(file)`.',
      ].join('\n'),
      issues,
    );
    expect(grade.found).toEqual([
      'status-uninit-or-last-only',
      'parse-integer-use-after-free',
      'fread-short-leak',
    ]);
  });

  it('does not credit parse-error-ignored for the empty-file warning', () => {
    const grade = gradeReview(
      'The empty-file case only prints a message and continues with the same NULL buffer.',
      issues,
    );
    expect(grade.found).not.toContain('parse-error-ignored');
  });

  it('does not credit an issue from a shared line number alone', () => {
    const grade = gradeReview(
      '调用点 src/main.c:19 把可能为 NULL 的指针传给下游；duplicate_slice 被 src/parser.c:32 调用。',
      issues,
    );
    expect(grade.found).not.toContain('parse-error-ignored');
    expect(grade.found).not.toContain('append-name-unchecked');
  });
});

describe('countFileReads', () => {
  it('counts reads already covered by an earlier turn as duplicates', () => {
    const read = (path: string, startLine: number, endLine: number): string =>
      `file_read ${JSON.stringify({ path, startLine, endLine })}`;
    const result = countFileReads([
      ['handoff {}'],
      [read('src/a.c', 1, 40), read('src/b.c', 1, 20)],
      [read('src/a.c', 10, 20), read('src/b.c', 15, 30)],
    ]);
    expect(result).toEqual({ total: 4, duplicates: 1 });
  });
});

describe('loadComparableRuns', () => {
  it('reads mini-agent ablation records and keeps failed runs without an answer', () => {
    const runs = loadComparableRuns({
      records: [
        {
          config: 'full',
          repeat: 0,
          answer: 'double free',
          model_calls: 3,
          input_tokens: 900,
          output_tokens: 300,
          cost_usd: 0.001,
          seconds: 4.2,
        },
        { config: 'full', repeat: 1, error: 'HTTP 500' },
      ],
    });
    expect(runs).toEqual([
      {
        label: 'full#1',
        answer: 'double free',
        modelCalls: 3,
        inputTokens: 900,
        outputTokens: 300,
        costUsd: 0.001,
        seconds: 4.2,
      },
      {
        label: 'full#2',
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        seconds: 0,
      },
    ]);
  });
});
