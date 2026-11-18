/**
 * Reads records and says what they show (docs/M2/Evaluation.md 5): one file summarised per task,
 * two files compared, and the changes that count as regressions under rules that are the same
 * for every task and every mode.
 */
import type { RunRecord } from './spec.js';

export interface TaskSummary {
  readonly taskId: string;
  readonly runs: number;
  readonly passed: number;
  readonly passRate: number;
  readonly meanElapsedMs: number;
  readonly meanRequests: number;
  readonly meanTokens: number;
  /** null when no run had a price. */
  readonly meanCostUsd: number | null;
  /** null when no run had any input. */
  readonly meanCacheHitRate: number | null;
  readonly meanMaxParallel: number;
  /** Tool requests per run. */
  readonly toolsPerRun: Readonly<Record<string, number>>;
  readonly failedChecks: Readonly<Record<string, number>>;
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, each) => total + each, 0) / values.length;
const meanOrNull = (values: readonly (number | null)[]): number | null => {
  const present = values.filter((each): each is number => each !== null);
  return present.length === 0 ? null : mean(present);
};

export function summarize(records: readonly RunRecord[]): TaskSummary[] {
  const byTask = new Map<string, RunRecord[]>();
  for (const record of records)
    byTask.set(record.taskId, [...(byTask.get(record.taskId) ?? []), record]);
  return [...byTask.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([taskId, runs]) => {
      const tools: Record<string, number> = {};
      const failed: Record<string, number> = {};
      for (const run of runs) {
        for (const [name, count] of Object.entries(run.metrics.toolRequests))
          tools[name] = (tools[name] ?? 0) + count;
        for (const check of run.checks)
          if (!check.ok) failed[check.name] = (failed[check.name] ?? 0) + 1;
      }
      for (const name of Object.keys(tools)) tools[name] = (tools[name] ?? 0) / runs.length;
      const passed = runs.filter((run) => run.ok).length;
      return {
        taskId,
        runs: runs.length,
        passed,
        passRate: passed / runs.length,
        meanElapsedMs: mean(runs.map((run) => run.elapsedMs)),
        meanRequests: mean(runs.map((run) => run.metrics.modelRequests)),
        meanTokens: mean(
          runs.map(
            (run) =>
              run.metrics.tokens.input +
              run.metrics.tokens.output +
              run.metrics.tokens.compactionInput +
              run.metrics.tokens.compactionOutput,
          ),
        ),
        meanCostUsd: meanOrNull(runs.map((run) => run.metrics.costUsd)),
        meanCacheHitRate: meanOrNull(runs.map((run) => run.metrics.cacheHitRate)),
        meanMaxParallel: mean(runs.map((run) => run.metrics.maxParallelUnits)),
        toolsPerRun: tools,
        failedChecks: failed,
      };
    });
}

/** The thresholds of a regression; the same for every task. */
export interface Rules {
  /** Both sides need at least this many runs of a task before its pass rate is judged. */
  readonly minRuns: number;
  /** A pass rate that falls by more than this (absolute, 0 to 1) is a regression. */
  readonly passRateDrop: number;
  /** A mean that grows by more than this factor is a regression. */
  readonly costGrowth: number;
  readonly timeGrowth: number;
  readonly requestGrowth: number;
  /** A cache hit rate that falls by more than this (absolute) is a regression. */
  readonly cacheHitDrop: number;
}

export const DEFAULT_RULES: Rules = {
  minRuns: 3,
  passRateDrop: 0.2,
  costGrowth: 1.25,
  timeGrowth: 1.5,
  requestGrowth: 1.5,
  cacheHitDrop: 0.1,
};

export interface Finding {
  readonly taskId: string;
  readonly severity: 'REGRESSION' | 'NOTE';
  readonly message: string;
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

export function compare(
  base: readonly RunRecord[],
  candidate: readonly RunRecord[],
  rules: Rules = DEFAULT_RULES,
): Finding[] {
  const before = new Map(summarize(base).map((each) => [each.taskId, each]));
  const after = new Map(summarize(candidate).map((each) => [each.taskId, each]));
  const findings: Finding[] = [];
  for (const [taskId, now] of after) {
    const was = before.get(taskId);
    if (was === undefined) {
      findings.push({ taskId, severity: 'NOTE', message: 'new task, nothing to compare with' });
      continue;
    }
    if (was.runs < rules.minRuns || now.runs < rules.minRuns)
      findings.push({
        taskId,
        severity: 'NOTE',
        message: `too few runs to judge the pass rate (${String(was.runs)} before, ${String(now.runs)} now; at least ${String(rules.minRuns)} each)`,
      });
    else if (now.passRate < was.passRate - rules.passRateDrop)
      findings.push({
        taskId,
        severity: 'REGRESSION',
        message: `pass rate fell from ${percent(was.passRate)} to ${percent(now.passRate)}`,
      });
    if (
      was.meanCostUsd !== null &&
      now.meanCostUsd !== null &&
      now.meanCostUsd > was.meanCostUsd * rules.costGrowth
    )
      findings.push({
        taskId,
        severity: 'REGRESSION',
        message: `mean cost grew from $${was.meanCostUsd.toFixed(4)} to $${now.meanCostUsd.toFixed(4)}`,
      });
    if (now.meanElapsedMs > was.meanElapsedMs * rules.timeGrowth)
      findings.push({
        taskId,
        severity: 'REGRESSION',
        message: `mean time grew from ${(was.meanElapsedMs / 1000).toFixed(1)} s to ${(now.meanElapsedMs / 1000).toFixed(1)} s`,
      });
    if (now.meanRequests > was.meanRequests * rules.requestGrowth)
      findings.push({
        taskId,
        severity: 'REGRESSION',
        message: `mean model requests grew from ${was.meanRequests.toFixed(1)} to ${now.meanRequests.toFixed(1)}`,
      });
    if (
      was.meanCacheHitRate !== null &&
      now.meanCacheHitRate !== null &&
      now.meanCacheHitRate < was.meanCacheHitRate - rules.cacheHitDrop
    )
      findings.push({
        taskId,
        severity: 'REGRESSION',
        message: `cache hit rate fell from ${percent(was.meanCacheHitRate)} to ${percent(now.meanCacheHitRate)}`,
      });
  }
  for (const taskId of before.keys())
    if (!after.has(taskId))
      findings.push({ taskId, severity: 'NOTE', message: 'task is not in the new records' });
  return findings;
}

const cell = (value: number | null, digits: number, prefix = ''): string =>
  value === null ? '–' : `${prefix}${value.toFixed(digits)}`;

export function renderSummary(summaries: readonly TaskSummary[]): string {
  const rows = summaries.map(
    (each) =>
      `| ${each.taskId} | ${String(each.passed)}/${String(each.runs)} | ${(each.meanElapsedMs / 1000).toFixed(1)} s | ${each.meanRequests.toFixed(1)} | ${each.meanTokens.toFixed(0)} | ${cell(each.meanCostUsd, 4, '$')} | ${each.meanCacheHitRate === null ? '–' : percent(each.meanCacheHitRate)} | ${each.meanMaxParallel.toFixed(1)} | ${Object.entries(
        each.toolsPerRun,
      )
        .map(([name, count]) => `${name} ${count.toFixed(1)}`)
        .join(', ')} |`,
  );
  return [
    '| task | passed | time | requests | tokens | cost | cache hit | parallel | tools per run |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

export function renderFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'No differences under the rules.';
  return findings
    .map(
      (each) =>
        `- ${each.severity === 'REGRESSION' ? '**REGRESSION**' : 'note'} ${each.taskId}: ${each.message}`,
    )
    .join('\n');
}
