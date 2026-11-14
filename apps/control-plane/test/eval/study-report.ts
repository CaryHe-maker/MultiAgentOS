/**
 * The report of the submission study (Phase2Plan 7):
 *
 *   tsx apps/control-plane/test/eval/study-report.ts <records.jsonl> [--archive <dir>]
 *
 * From the records alone it reads the shape each run recorded; with the archive (EVAL_ARCHIVE of
 * the runs) it reads the shape again from every Session log, so a measure changed after the runs
 * needs no new run. It prints how often root started a specialist (fixer, reviewer, ...), per task
 * and overall, and how many specialists kept to their playbook, with every violation.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { shapeOf, type RunShape, type TaskStats } from './orchestration-shape.js';
import type { RunRecord } from './spec.js';

const argv = process.argv.slice(2);
const recordsFile = argv[0];
const archive = argv.includes('--archive') ? argv[argv.indexOf('--archive') + 1] : undefined;
if (recordsFile === undefined) throw new Error('study-report.ts <records.jsonl> [--archive <dir>]');

interface Recorded {
  readonly subMissions: readonly {
    readonly template: string;
    readonly status?: string;
    readonly children: readonly string[];
    readonly sentBack: Readonly<Record<string, number>>;
    readonly ownWrites: number;
    readonly ownCommands: number;
    readonly violations: readonly string[];
  }[];
  readonly runSubagentsCalls: number;
  readonly tasksByAgent: Readonly<Record<string, number>>;
  readonly rootWrites: number;
  readonly depth: number;
  readonly tasks?: readonly TaskStats[];
}

const fromShape = (shape: RunShape): Recorded => ({
  ...shape,
  subMissions: shape.subMissions.map((each) => ({
    ...each,
    children: each.children.map((child) => `${child.agent}:${String(child.status)}`),
  })),
});

async function logOf(folder: string): Promise<Record<string, unknown>[]> {
  const sessions = await readdir(join(folder, 'sessions')).catch(() => [] as string[]);
  const [id] = sessions;
  if (id === undefined) return [];
  const text = await readFile(
    join(folder, 'sessions', id, 'workflow', 'log.v1.jsonl'),
    'utf8',
  ).catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function main(): Promise<void> {
  const records = (await readFile(recordsFile ?? '', 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunRecord)
    .filter((record) => record.tags.includes('submission-study'));
  const folders = archive === undefined ? [] : await readdir(archive);
  const rows: { record: RunRecord; shape: Recorded; source: string }[] = [];
  for (const record of records) {
    const folder = folders.find((name) =>
      name.startsWith(`${record.taskId}-r${String(record.run)}-`),
    );
    const log =
      folder === undefined || archive === undefined ? [] : await logOf(join(archive, folder));
    if (log.length > 0) {
      rows.push({ record, shape: fromShape(shapeOf(log)), source: 'log' });
      continue;
    }
    const detail = record.checks.find(
      (each) => each.name === 'recorded: the shape of the run',
    )?.detail;
    if (detail !== undefined)
      rows.push({ record, shape: JSON.parse(detail) as Recorded, source: 'record' });
  }

  const out: string[] = [];
  const percent = (part: number, whole: number) =>
    whole === 0 ? '-' : `${String(Math.round((100 * part) / whole))}%`;
  out.push('## Runs', '');
  out.push(
    '| task | run | ok | specialists | specialists (template: kept?) | run_subagents | tasks by Agent | root writes | requests | source |',
  );
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const { record, shape, source } of rows)
    out.push(
      `| ${record.taskId} | ${String(record.run)} | ${record.ok ? 'yes' : 'no'} | ${String(shape.subMissions.length)} | ${
        shape.subMissions
          .map((each) => `${each.template}: ${each.violations.length === 0 ? 'kept' : 'broke'}`)
          .join(', ') || '-'
      } | ${String(shape.runSubagentsCalls)} | ${
        Object.entries(shape.tasksByAgent)
          .map(([agent, count]) => `${agent} ${String(count)}`)
          .join(', ') || '-'
      } | ${String(shape.rootWrites)} | ${String(record.metrics.modelRequests)} | ${source} |`,
    );

  out.push('', '## Every task of every run', '');
  const counts = (map: Readonly<Record<string, number>>) =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key} ${String(count)}`)
      .join(', ') || '-';
  for (const { record, shape } of rows) {
    out.push(`### ${record.taskId} #${String(record.run)}`, '');
    out.push(
      '| task | Agent | parent | in subMission | status | segments | requests | tokens in/out | tools | not OK | feedback | files changed |',
    );
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const task of shape.tasks ?? [])
      out.push(
        `| ${task.name}${task.template === undefined ? '' : ` (${task.template})`} | ${task.agent} | ${task.parent ?? '-'} | ${task.inside ?? '-'} | ${task.status ?? '-'} | ${String(task.segments)} | ${String(task.modelRequests)} | ${String(task.inputTokens)}/${String(task.outputTokens)} | ${counts(task.tools)} | ${counts(task.notOk)} | ${counts(task.feedback)} | ${String(task.changedFiles)} |`,
      );
    out.push('');
  }
  out.push('## Tool calls by Agent, all runs', '');
  const byAgent = new Map<string, Record<string, number>>();
  for (const { shape } of rows)
    for (const task of shape.tasks ?? []) {
      const key = task.template === undefined ? task.agent : `${task.agent} (subMission root)`;
      const into = byAgent.get(key) ?? {};
      for (const [tool, count] of Object.entries(task.tools))
        into[tool] = (into[tool] ?? 0) + count;
      byAgent.set(key, into);
    }
  for (const [agent, tools] of byAgent) out.push(`- ${agent}: ${counts(tools)}`);

  out.push('', '## Use of specialists by task', '');
  out.push('| task | runs | runs that used it | subMissions | kept to the playbook | passed |');
  out.push('|---|---|---|---|---|---|');
  const tasks = [...new Set(rows.map((row) => row.record.taskId))];
  let allRuns = 0;
  let allUsed = 0;
  let allSubs = 0;
  let allKept = 0;
  for (const task of tasks) {
    const mine = rows.filter((row) => row.record.taskId === task);
    const used = mine.filter((row) => row.shape.subMissions.length > 0).length;
    const subs = mine.flatMap((row) => row.shape.subMissions);
    const kept = subs.filter((each) => each.violations.length === 0).length;
    allRuns += mine.length;
    allUsed += used;
    allSubs += subs.length;
    allKept += kept;
    out.push(
      `| ${task} | ${String(mine.length)} | ${String(used)} (${percent(used, mine.length)}) | ${String(subs.length)} | ${String(kept)} (${percent(kept, subs.length)}) | ${String(mine.filter((row) => row.record.ok).length)} |`,
    );
  }
  out.push(
    `| all | ${String(allRuns)} | ${String(allUsed)} (${percent(allUsed, allRuns)}) | ${String(allSubs)} | ${String(allKept)} (${percent(allKept, allSubs)}) | ${String(rows.filter((row) => row.record.ok).length)} |`,
  );

  out.push('', '## Violations of a playbook', '');
  const broken = rows.flatMap((row) =>
    row.shape.subMissions
      .filter((each) => each.violations.length > 0)
      .map(
        (each) =>
          `- ${row.record.taskId} #${String(row.record.run)} ${each.template}: ${each.violations.join('; ')}`,
      ),
  );
  out.push(...(broken.length === 0 ? ['none'] : broken));
  out.push('', '## Calls sent back by the runner for the playbook', '');
  const sent = rows.flatMap((row) =>
    row.shape.subMissions
      .filter((each) => Object.keys(each.sentBack).length > 0)
      .map(
        (each) =>
          `- ${row.record.taskId} #${String(row.record.run)} ${each.template}: ${JSON.stringify(each.sentBack)}`,
      ),
  );
  out.push(...(sent.length === 0 ? ['none'] : sent));
  process.stdout.write(`${out.join('\n')}\n`);
}

await main();
