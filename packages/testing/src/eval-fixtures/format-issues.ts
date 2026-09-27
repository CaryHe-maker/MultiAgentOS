import type { FixtureIssue } from './eval-task-rules.js';

export interface IssueSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly lines: readonly string[];
}

/** 按来源文件分组输出，便于一眼看出哪道题有问题。 */
export function summarizeIssues(issues: readonly FixtureIssue[]): IssueSummary {
  const byOrigin = new Map<string, FixtureIssue[]>();
  for (const issue of issues)
    byOrigin.set(issue.origin, [...(byOrigin.get(issue.origin) ?? []), issue]);
  const lines: string[] = [];
  for (const origin of [...byOrigin.keys()].sort()) {
    lines.push(origin);
    for (const issue of byOrigin.get(origin) ?? [])
      lines.push(`  ${issue.severity === 'ERROR' ? 'x' : '!'} [${issue.code}] ${issue.message}`);
  }
  const errors = issues.filter((issue) => issue.severity === 'ERROR').length;
  return { errors, warnings: issues.length - errors, lines };
}
