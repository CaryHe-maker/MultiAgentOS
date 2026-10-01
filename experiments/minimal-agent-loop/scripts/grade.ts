// Grades a C review report against evals/c-review-answer-key.json.
// An issue counts as found when any one of its patterns matches the report.
//
// Regrade saved runs (from repo root). Accepts this experiment's runs/*.json and
// mini-agent's runs/ablation-*.json, so both projects are scored by the same key:
//   pnpm exec tsx experiments/minimal-agent-loop/scripts/grade.ts <file.json>...

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

/** One run from either project, reduced to the fields both record. */
export interface ComparableRun {
  readonly label: string;
  readonly answer?: string;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly seconds: number;
  readonly fileReads?: { total: number; duplicates: number };
}

interface M0Run {
  caseId: string;
  repeat: number;
  answer?: string;
  modelCalls: number;
  inputTokens: number;
  output: number;
  costUsd: number;
  wallMs: number;
  calls?: { toolCalls?: string[] }[];
}

interface MiniAgentRecord {
  config: string;
  repeat: number;
  answer?: string;
  error?: string;
  model_calls?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  seconds?: number;
}

export function loadComparableRuns(data: unknown): ComparableRun[] {
  if (Array.isArray(data)) {
    return (data as M0Run[])
      .filter((run) => run.caseId === 'c-review')
      .map((run) => ({
        label: `#${run.repeat}`,
        ...(run.answer === undefined ? {} : { answer: run.answer }),
        modelCalls: run.modelCalls,
        inputTokens: run.inputTokens,
        outputTokens: run.output,
        costUsd: run.costUsd,
        seconds: run.wallMs / 1000,
        fileReads: countFileReads((run.calls ?? []).map((call) => call.toolCalls ?? [])),
      }));
  }
  const records = (data as { records?: MiniAgentRecord[] }).records ?? [];
  return records.map((record) => ({
    label: `${record.config}#${record.repeat + 1}`,
    ...(record.error === undefined && record.answer !== undefined ? { answer: record.answer } : {}),
    modelCalls: record.model_calls ?? 0,
    inputTokens: record.input_tokens ?? 0,
    outputTokens: record.output_tokens ?? 0,
    costUsd: record.cost_usd ?? 0,
    seconds: record.seconds ?? 0,
  }));
}

function regrade(files: readonly string[]): void {
  const issues = loadAnswerKey();
  for (const file of files) {
    const runs = loadComparableRuns(JSON.parse(readFileSync(file, 'utf8')));
    console.log(file);
    const grades: Grade[] = [];
    for (const run of runs) {
      if (run.answer === undefined) {
        console.log(`  ${run.label}  FAILED`);
        continue;
      }
      const grade = gradeReview(run.answer, issues);
      grades.push(grade);
      const reads =
        run.fileReads === undefined
          ? ''
          : `  reads=${run.fileReads.total}(dup ${run.fileReads.duplicates})`;
      console.log(
        `  ${run.label}  ${formatGrade(grade)}${reads}  missed: ${grade.missed.join(', ')}`,
      );
    }
    const mean = (values: readonly number[]): number =>
      values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
    const [first] = grades;
    console.log(
      [
        `  summary: ok=${grades.length}/${runs.length}`,
        `calls=${mean(runs.map((run) => run.modelCalls)).toFixed(1)}`,
        `in=${mean(runs.map((run) => run.inputTokens)).toFixed(0)}`,
        `out=${mean(runs.map((run) => run.outputTokens)).toFixed(0)}`,
        `$${mean(runs.map((run) => run.costUsd)).toFixed(4)}`,
        `${mean(runs.map((run) => run.seconds)).toFixed(1)}s`,
        `core=${mean(grades.map((grade) => grade.coreFound)).toFixed(1)}/${first?.coreTotal ?? 0}`,
        `subtle=${mean(grades.map((grade) => grade.subtleFound)).toFixed(1)}/${first?.subtleTotal ?? 0}`,
      ].join('  '),
    );
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  regrade(process.argv.slice(2));
}
