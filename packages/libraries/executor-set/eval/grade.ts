import { readFileSync } from 'node:fs';

/**
 * The grader of M0 (`experiments/minimal-agent-loop/scripts/grade.ts` on `experiment/M0`), so
 * M1 runs are scored with the same answer key as M0 and mini-agent: an issue counts as found
 * when any of its patterns matches the report text (case-insensitive, dot matches newline).
 */
export interface AnswerKeyIssue {
  readonly id: string;
  readonly tier: 'core' | 'subtle';
  readonly location: string;
  readonly summary: string;
  readonly patterns: readonly string[];
}

export interface Grade {
  readonly found: readonly string[];
  readonly missed: readonly string[];
  readonly coreFound: number;
  readonly coreTotal: number;
  readonly subtleFound: number;
  readonly subtleTotal: number;
}

export function loadAnswerKey(path: string): readonly AnswerKeyIssue[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { issues: AnswerKeyIssue[] }).issues;
}

export function gradeReport(text: string, issues: readonly AnswerKeyIssue[]): Grade {
  const found: string[] = [];
  const missed: string[] = [];
  for (const issue of issues) {
    const hit = issue.patterns.some((pattern) => new RegExp(pattern, 'isu').test(text));
    (hit ? found : missed).push(issue.id);
  }
  const count = (tier: AnswerKeyIssue['tier'], ids: readonly string[]) =>
    issues.filter((issue) => issue.tier === tier && ids.includes(issue.id)).length;
  const all = issues.map((issue) => issue.id);
  return {
    found,
    missed,
    coreFound: count('core', found),
    coreTotal: count('core', all),
    subtleFound: count('subtle', found),
    subtleTotal: count('subtle', all),
  };
}
