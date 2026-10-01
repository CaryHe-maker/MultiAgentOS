import { describe, expect, it } from 'vitest';

import { countFileReads, gradeReview, loadAnswerKey } from './grade.js';

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
