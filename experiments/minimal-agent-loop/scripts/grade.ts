// Grades a C review report against evals/c-review-answer-key.json.
// An issue counts as found when any one of its patterns matches the report.
//
// Regrade saved runs (from repo root):
//   pnpm exec tsx experiments/minimal-agent-loop/scripts/grade.ts <runs/file.json>...

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const experimentDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadAnswerKey(
  path = join(experimentDir, 'evals/c-review-answer-key.json'),
): readonly AnswerKeyIssue[] {
  const key = JSON.parse(readFileSync(path, 'utf8')) as { issues: AnswerKeyIssue[] };
  return key.issues;
}

export function gradeReview(answer: string, issues: readonly AnswerKeyIssue[]): Grade {
  const found: string[] = [];
  const missed: string[] = [];
  for (const issue of issues) {
    const hit = issue.patterns.some((pattern) => new RegExp(pattern, 'isu').test(answer));
    (hit ? found : missed).push(issue.id);
  }
  const count = (tier: AnswerKeyIssue['tier'], ids: readonly string[]): number =>
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

export function formatGrade(grade: Grade): string {
  return `core=${grade.coreFound}/${grade.coreTotal}  subtle=${grade.subtleFound}/${grade.subtleTotal}`;
}

interface ReadRange {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

function parseFileRead(toolCall: string): ReadRange | undefined {
  if (!toolCall.startsWith('file_read ')) return undefined;
  try {
    const args = JSON.parse(toolCall.slice('file_read '.length)) as Record<string, unknown>;
    if (typeof args.path !== 'string') return undefined;
    const start = typeof args.startLine === 'number' ? args.startLine : 1;
    const end = typeof args.endLine === 'number' ? args.endLine : Number.MAX_SAFE_INTEGER;
    return { path: args.path, start, end };
  } catch {
    return undefined;
  }
}

/**
 * Count file_read calls and how many re-read a range already covered by an earlier turn.
 * Each entry is one model turn's tool calls, formatted as "<name> <json arguments>".
 */
export function countFileReads(turns: readonly (readonly string[])[]): {
  total: number;
  duplicates: number;
} {
  const seen: ReadRange[] = [];
  let total = 0;
  let duplicates = 0;
  for (const turn of turns) {
    const ranges = turn.map(parseFileRead).filter((range) => range !== undefined);
    for (const range of ranges) {
      total += 1;
      const covered = seen.some(
        (prior) =>
          prior.path === range.path && prior.start <= range.start && range.end <= prior.end,
      );
      if (covered) duplicates += 1;
    }
    // Reads within one turn run together, so only earlier turns count as already seen.
    seen.push(...ranges);
  }
  return { total, duplicates };
}

function regrade(files: readonly string[]): void {
  const issues = loadAnswerKey();
  for (const file of files) {
    const runs = JSON.parse(readFileSync(file, 'utf8')) as {
      caseId: string;
      repeat: number;
      answer?: string;
      calls?: { toolCalls?: string[] }[];
    }[];
    console.log(file);
    for (const run of runs) {
      if (run.caseId !== 'c-review' || run.answer === undefined) continue;
      const grade = gradeReview(run.answer, issues);
      const reads = countFileReads((run.calls ?? []).map((call) => call.toolCalls ?? []));
      console.log(
        `  #${run.repeat}  ${formatGrade(grade)}  reads=${reads.total}(dup ${reads.duplicates})` +
          `  missed: ${grade.missed.join(', ')}`,
      );
    }
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  regrade(process.argv.slice(2));
}
