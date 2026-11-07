/**
 * The command line of the evaluation system (docs/M2/Evaluation.md 8):
 *
 *   tsx apps/control-plane/test/eval/eval.ts run [--tasks id|tag:x|all ...] [--runs N] --out <file>
 *       [--yes --budget N] [--model deepseek-flash]
 *   tsx apps/control-plane/test/eval/eval.ts report <file>
 *   tsx apps/control-plane/test/eval/eval.ts compare <base> <candidate> [--fail-on-regression]
 *
 * Scripted tasks run offline. A task without a scripted provider runs on the real model: it
 * needs `--yes` and `--budget` (the most requests the whole invocation may send) and a key in
 * `DEEPSEEK_API_KEY` or in the file named by `MAO_ENV_FILE`, which is never written down.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
} from '@multiagentos/agent-tool-pool';
import { compare, renderFindings, renderSummary, summarize } from './report.js';
import { runTask, versionOf, type RequestBudget } from './runner.js';
import type { RunRecord } from './spec.js';
import { ALL_TASKS, select } from './tasks/index.js';

const argv = process.argv.slice(2);
const command = argv[0];
const flagsWithValue = new Set(['--tasks', '--runs', '--out', '--budget', '--model']);
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
  const catalog = await DefinitionCatalog.load(
    new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
  );
  const modelId = values('--model')[0] ?? 'deepseek-flash';
  const definition = catalog.latest('MODEL', modelId);
  const model = {
    id: modelId,
    ...(definition?.kind === 'MODEL' ? { pricing: definition.pricing } : {}),
  };
  const version = await versionOf(resolve('.'), DEFAULT_DEFINITIONS_DIRECTORY);
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
  let failed = 0;
  for (const task of tasks)
    for (let number = 1; number <= runs; number += 1) {
      if (done.has(`${task.id}|${String(number)}|${version.commit}|${version.definitions}`))
        continue;
      const record = await runTask(task, number, {
        version,
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(budget === undefined ? {} : { budget }),
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
          turns: 0,
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
  return failed === 0 ? 0 : 1;
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
    default:
      process.stdout.write('commands: run, report, compare (see the header of this file)\n');
      return 2;
  }
}

process.exit(await main());
