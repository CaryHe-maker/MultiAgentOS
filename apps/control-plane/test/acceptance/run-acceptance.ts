/**
 * `pnpm run acceptance -- [F1 F2 … | all] [--runs N] [--yes] [--out DIR]`: runs the fixed task
 * set against the real model (M1ReleasePlan R3.1, R3.6). It costs money, so it first prints the
 * number of runs and an upper bound of the cost, and starts only with `--yes`. The API key comes
 * from `DEEPSEEK_API_KEY` or from `.env` in the MultiAgentOS working directory. Every run record
 * is appended to `<out>/records.jsonl` (default `.multiagentos/acceptance/<time>/`, ignored by git).
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
} from '@multiagentos/agent-tool-pool';
import dotenv from 'dotenv';
import { defaultSystemConfig } from '../../src/config/system-config.js';
import { runTask } from './harness.js';
import { TASKS } from './tasks.js';

interface Options {
  readonly ids: readonly string[];
  readonly runs: number;
  readonly yes: boolean;
  readonly out: string;
}

function parse(argv: readonly string[]): Options {
  const ids: string[] = [];
  let runs = 1;
  let yes = false;
  let out = join('.multiagentos', 'acceptance', new Date().toISOString().replaceAll(':', '-'));
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--runs') runs = Number(argv[(index += 1)]);
    else if (argument === '--yes') yes = true;
    else if (argument === '--out') out = argv[(index += 1)] ?? out;
    else if (argument === 'all') ids.push(...TASKS.map((task) => task.id));
    else if (argument !== '--') ids.push(argument);
  }
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs needs a positive integer');
  return { ids: ids.length === 0 ? TASKS.map((task) => task.id) : ids, runs, yes, out };
}

/** The most one run can cost: the whole token budget at the dearer rate, at peak time. */
async function upperBoundUsdPerRun(): Promise<number> {
  const catalog = await DefinitionCatalog.load(
    new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
  );
  const model = await catalog.getDefinition(
    { kind: 'MODEL', id: 'deepseek-flash', version: 'v1.0.0' },
    { correlationId: 'cor_acceptance', tenantId: 'local', projectId: 'local' },
  );
  if (!model.ok) throw new Error('the default model definition is missing');
  const rates = model.value.pricing.offPeak;
  const microUsdPerToken = Math.max(rates.inputCacheMiss, rates.output) / 1_000_000;
  const peak = model.value.pricing.peak.ratePercent / 100;
  const tokens = defaultSystemConfig().kernel.budget.tokenLimit;
  return (tokens * microUsdPerToken * peak) / 1_000_000;
}

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  const tasks = options.ids.map((id) => {
    const task = TASKS.find((candidate) => candidate.id === id);
    if (task === undefined) throw new Error(`unknown task ${id}`);
    return task;
  });
  dotenv.config({ quiet: true });
  const total = tasks.length * options.runs;
  const bound = (await upperBoundUsdPerRun()) * total;
  process.stdout.write(
    `${total} real-model run(s): ${tasks.map((task) => task.id).join(', ')} × ${options.runs}; ` +
      `upper bound ${bound.toFixed(2)} USD (whole token budget at the peak rate; usual runs cost far less)\n`,
  );
  if (!options.yes) {
    process.stdout.write('Nothing was run. Add --yes to start.\n');
    return 2;
  }
  if ((process.env['DEEPSEEK_API_KEY'] ?? '').trim() === '') {
    process.stderr.write('DEEPSEEK_API_KEY is not set (environment or .env)\n');
    return 2;
  }
  await mkdir(options.out, { recursive: true });
  const records = join(options.out, 'records.jsonl');
  let failed = 0;
  for (const task of tasks)
    for (let run = 1; run <= options.runs; run += 1) {
      const result = await runTask(task, { kind: 'real', env: process.env });
      if (!result.passed) failed += 1;
      await appendFile(
        records,
        JSON.stringify({
          ...result.record,
          passed: result.passed,
          failures: result.failures,
          report: result.report,
        }) + '\n',
      );
      const cost =
        result.record.costMicroUsd === undefined
          ? ''
          : ` ${(result.record.costMicroUsd / 1_000_000).toFixed(4)} USD`;
      process.stdout.write(
        `${task.id} #${run}: ${result.passed ? 'passed' : 'FAILED'} in ${result.record.durationMs} ms${cost}` +
          (result.passed ? '' : `\n  ${result.failures.join('\n  ')}`) +
          '\n',
      );
    }
  process.stdout.write(`${total - failed}/${total} passed; records in ${records}\n`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
