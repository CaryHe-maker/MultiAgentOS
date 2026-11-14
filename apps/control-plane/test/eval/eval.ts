/**
 * The command line of the evaluation system (docs/M2/Evaluation.md 8):
 *
 *   tsx apps/control-plane/test/eval/eval.ts run [--tasks id|tag:x|all ...] [--runs N] --out <file>
 *       [--yes --budget N [--per-run N]] [--model deepseek-flash]
 *   tsx apps/control-plane/test/eval/eval.ts prepare --tasks <id> --repo <dir> --data <dir>
 *   tsx apps/control-plane/test/eval/eval.ts judge --tasks <id> --repo <dir> --data <dir>
 *       --exit <code> --out <file> [--model deepseek-flash]
 *   tsx apps/control-plane/test/eval/eval.ts report <file>
 *   tsx apps/control-plane/test/eval/eval.ts compare <base> <candidate> [--fail-on-regression]
 *
 * `prepare` and `judge` are a run of a mission task that a person starts and watches: `prepare`
 * builds its repository and a data directory of its own and prints the `mas run` command; after
 * the run, `judge` judges and measures it as `run` would and appends the same record (and keeps it
 * in `EVAL_ARCHIVE` when that is set).
 *
 * Scripted tasks run offline. A task without a scripted provider runs on the real model: it
 * needs `--yes` and `--budget` (the most requests the whole invocation may send) and a key in
 * `DEEPSEEK_API_KEY` or in the file named by `MAO_ENV_FILE`, which is never written down.
 * `--per-run N` starts a run only while N requests are left, so no run is cut short by the
 * budget and spent for nothing; the runs not started are named, and a later invocation with the
 * same records file starts them (runs already recorded are skipped).
 */
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';
import type { ModelDefinition } from '@multiagentos/contracts';
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
} from '@multiagentos/agent-tool-pool';
import { compare, renderFindings, renderSummary, summarize } from './report.js';
import { archiveRun, judgeRun, runTask, versionOf, type RequestBudget } from './runner.js';
import type { ChatStep, RunRecord, TaskSpec } from './spec.js';
import { ALL_TASKS, select } from './tasks/index.js';

const argv = process.argv.slice(2);
const command = argv[0];
const flagsWithValue = new Set(['--tasks', '--runs', '--out', '--budget', '--per-run', '--model']);
const values = (name: string): string[] => {
  const found: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === name) {
      for (let next = index + 1; next < argv.length && !argv[next]?.startsWith('--'); next += 1)
        found.push(argv[next] ?? '');
    }
  });
  return found;
};
const positional = argv
  .slice(1)
  .filter((arg, index, all) => !arg.startsWith('--') && !flagsWithValue.has(all[index - 1] ?? ''));

async function load(path: string): Promise<RunRecord[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunRecord);
}

async function run(): Promise<number> {
  const out = values('--out')[0];
  if (out === undefined) throw new Error('--out <file> is required');
  const runs = Number(values('--runs')[0] ?? '1');
  const tasks = select(ALL_TASKS, values('--tasks'));
  if (tasks.length === 0) throw new Error('no task matches');
  const real = tasks.filter((task) => task.scripted === undefined);
  let apiKey: string | undefined;
  let budget: RequestBudget | undefined;
  if (real.length > 0) {
    if (!argv.includes('--yes')) {
      process.stdout.write(
        `${String(real.length)} of the tasks run on the real model and cost money. Nothing was run. Add --yes and --budget N.\n`,
      );
      return 0;
    }
    const limit = Number(values('--budget')[0] ?? '0');
    if (!(limit > 0)) throw new Error('--budget N (requests) is required for real tasks');
    budget = { remaining: limit };
    dotenv.config({ path: process.env['MAO_ENV_FILE'] ?? '.env', quiet: true });
    apiKey = (process.env['DEEPSEEK_API_KEY'] ?? '').trim() || undefined;
    if (apiKey === undefined) throw new Error('DEEPSEEK_API_KEY is not set');
  }
  const { version, model } = await environment();
  await mkdir(dirname(out), { recursive: true });
  const done = new Set(
    (await readFile(out, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const record = JSON.parse(line) as RunRecord;
        return `${record.taskId}|${String(record.run)}|${record.version.commit}|${record.version.definitions}`;
      }),
  );
  const reserve = Number(values('--per-run')[0] ?? '0');
  let failed = 0;
  const notStarted: string[] = [];
  // Round by round: the first run of every task before the second of any, so a budget that ends
  // early leaves every task with runs rather than some tasks with none.
  for (let number = 1; number <= runs; number += 1)
    for (const task of tasks) {
      if (done.has(`${task.id}|${String(number)}|${version.commit}|${version.definitions}`))
        continue;
      if (
        task.scripted === undefined &&
        budget !== undefined &&
        reserve > 0 &&
        budget.remaining < reserve
      ) {
        notStarted.push(`${task.id} #${String(number)}`);
        continue;
      }
      const record = await runTask(task, number, {
        version,
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(budget === undefined ? {} : { budget }),
        ...(process.env['MAO_EVAL_STEP_TIMEOUT_MS'] === undefined
          ? {}
          : { stepTimeoutMs: Number(process.env['MAO_EVAL_STEP_TIMEOUT_MS']) }),
      }).catch((error: unknown): RunRecord => ({
        schema: 1,
        taskId: task.id,
        mode: task.mode,
        tags: task.tags,
        run: number,
        at: new Date().toISOString(),
        version,
        model: model.id,
        provider: task.scripted === undefined ? 'real' : 'scripted',
        ok: false,
        checks: [],
        metrics: {
          logWallMs: 0,
          inputs: 0,
          modelRequests: 0,
          failedModelRequests: 0,
          tokens: { input: 0, output: 0, cacheHit: 0, compactionInput: 0, compactionOutput: 0 },
          cacheHitRate: null,
          costUsd: null,
          toolRequests: {},
          toolOutcomes: {},
          agentRuns: {},
          maxParallelUnits: 0,
          compactions: { summarised: 0, pruned: 0 },
          authorizationQuestions: 0,
          humanRequests: 0,
          wrapUps: 0,
        },
        elapsedMs: 0,
        error: error instanceof Error ? error.message : 'unknown error',
      }));
      await appendFile(out, `${JSON.stringify(record)}\n`);
      if (!record.ok) failed += 1;
      process.stdout.write(`${task.id} #${String(number)} ${record.ok ? 'ok' : 'FAILED'}\n`);
    }
  if (notStarted.length > 0)
    process.stdout.write(
      `not started, fewer than ${String(reserve)} requests left: ${notStarted.join(', ')}\n`,
    );
  return failed === 0 ? 0 : 1;
}

/** The one mission task a command names with `--tasks`. */
function missionTask(command: string): {
  readonly task: TaskSpec;
  readonly step: Extract<ChatStep, { run: string }>;
} {
  const [task, ...more] = select(ALL_TASKS, values('--tasks'));
  if (task === undefined || more.length > 0)
    throw new Error(`${command} takes one task: --tasks <id>`);
  const step = task.steps.find((each): each is Extract<ChatStep, { run: string }> => 'run' in each);
  if (task.mode !== 'mission' || step === undefined)
    throw new Error(`${task.id} is not a mission task; ${command} is for mission tasks`);
  return { task, step };
}

const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * `prepare`: the repository of a mission task as a run of the evaluation gets it, and a data
 * directory of its own, so that a person can run the task with `mas run` and watch it. It prints
 * the commands that run it and then judge it.
 */
async function prepare(): Promise<number> {
  const { task, step } = missionTask('prepare');
  const repo = values('--repo')[0];
  const data = values('--data')[0];
  if (repo === undefined || data === undefined)
    throw new Error('prepare --tasks <id> --repo <dir> --data <dir>');
  const repository = resolve(repo);
  const dataDir = resolve(data);
  for (const place of [repository, dataDir])
    if ((await readdir(place).catch(() => [])).length > 0)
      throw new Error(`${place} is not empty: prepare starts from nothing`);
  await mkdir(repository, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await task.fixture(repository);
  const config = `${dataDir}.config.json`;
  await writeFile(config, `${JSON.stringify({ dataDir })}\n`);
  const exitFile = `${dataDir}.exit`;
  const bin = resolve('apps/control-plane/dist/bin.js');
  process.stdout.write(
    [
      `The repository of ${task.id} is ready in ${repository}; its run keeps its Session in ${dataDir}.`,
      '',
      'Run it and watch it (the key in DEEPSEEK_API_KEY, as for mas):',
      `  MULTIAGENTOS_CONFIG=${quoted(config)} node ${quoted(bin)} run --repo ${quoted(repository)} ${quoted(step.run)}; echo $? > ${quoted(exitFile)}`,
      '',
      'Then judge it, as a run of the evaluation is judged (EVAL_ARCHIVE keeps it for study-report.ts):',
      `  pnpm run eval judge --tasks ${task.id} --repo ${quoted(repository)} --data ${quoted(dataDir)} --exit "$(cat ${quoted(exitFile)})" --out <records.jsonl>`,
      '',
    ].join('\n'),
  );
  return 0;
}

/**
 * `judge`: a run started with `mas run` (see `prepare`), judged and measured as a run of the
 * evaluation is, and appended to the records as one.
 */
async function judge(): Promise<number> {
  const { task } = missionTask('judge');
  const out = values('--out')[0];
  const repo = values('--repo')[0];
  const data = values('--data')[0];
  const exit = values('--exit')[0];
  if (out === undefined || repo === undefined || data === undefined || exit === undefined)
    throw new Error('judge --tasks <id> --repo <dir> --data <dir> --exit <code> --out <file>');
  const exitCode = Number(exit);
  if (!Number.isInteger(exitCode))
    throw new Error(`--exit takes the exit code of mas run, not ${exit}`);
  const places = { repository: resolve(repo), dataDir: resolve(data) };
  const { version, model } = await environment();
  await mkdir(dirname(out), { recursive: true });
  const earlier = (await load(out).catch(() => [] as RunRecord[])).filter(
    (record) => record.taskId === task.id,
  );
  const number = earlier.length + 1;
  const record = await judgeRun(task, number, { version, model }, places, exitCode);
  await appendFile(out, `${JSON.stringify(record)}\n`);
  const kept = await archiveRun(task.id, number, Date.parse(record.at), places);
  process.stdout.write(
    [
      `${task.id} #${String(number)} ${record.ok ? 'ok' : 'FAILED'}`,
      ...record.checks.filter((each) => !each.ok).map((each) => `  not ok: ${each.name}`),
      ...(kept === undefined ? [] : [`kept in ${kept}`]),
      '',
    ].join('\n'),
  );
  return record.ok ? 0 : 1;
}

/** What a record says it ran: the commit and definitions here, and the model with its prices. */
async function environment(): Promise<{
  readonly version: RunRecord['version'];
  readonly model: { readonly id: string; readonly pricing?: ModelDefinition['pricing'] };
}> {
  const catalog = await DefinitionCatalog.load(
    new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
  );
  const id = values('--model')[0] ?? 'deepseek-flash';
  const definition = catalog.latest('MODEL', id);
  return {
    version: await versionOf(resolve('.'), DEFAULT_DEFINITIONS_DIRECTORY),
    model: { id, ...(definition?.kind === 'MODEL' ? { pricing: definition.pricing } : {}) },
  };
}

async function main(): Promise<number> {
  switch (command) {
    case 'run':
      return run();
    case 'report': {
      const file = positional[0];
      if (file === undefined) throw new Error('report <file>');
      process.stdout.write(`${renderSummary(summarize(await load(file)))}\n`);
      return 0;
    }
    case 'compare': {
      const [base, candidate] = positional;
      if (base === undefined || candidate === undefined)
        throw new Error('compare <base> <candidate>');
      const findings = compare(await load(base), await load(candidate));
      process.stdout.write(`${renderFindings(findings)}\n`);
      return argv.includes('--fail-on-regression') &&
        findings.some((each) => each.severity === 'REGRESSION')
        ? 1
        : 0;
    }
    case 'prepare':
      return prepare();
    case 'judge':
      return judge();
    default:
      process.stdout.write(
        'commands: run, prepare, judge, report, compare (see the header of this file)\n',
      );
      return 2;
  }
}

process.exit(await main());
