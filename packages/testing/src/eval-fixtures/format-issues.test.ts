import { describe, expect, it } from 'vitest';
import { summarizeIssues } from './format-issues.js';

describe('summarizeIssues', () => {
  it('groups issues by origin and counts severities', () => {
    const summary = summarizeIssues([
      { code: 'B', severity: 'WARNING', origin: 'tasks/dev/F2-001.yaml', message: 'w' },
      { code: 'A', severity: 'ERROR', origin: 'tasks/dev/F1-001.yaml', message: 'e' },
    ]);
    expect(summary).toEqual({
      errors: 1,
      warnings: 1,
      lines: ['tasks/dev/F1-001.yaml', '  x [A] e', 'tasks/dev/F2-001.yaml', '  ! [B] w'],
    });
  });
});
