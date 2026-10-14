import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSubprocessRunner } from '@multiagentos/kernel';
import { createExecutorRegistry } from '../src/index.js';
import { runAgentLoop, type LoopResult } from './agent-loop.js';
import { loadCodeViewer } from './eval-setup.js';
import { gradeReport, loadAnswerKey, type Grade } from './grade.js';

/**
 * Real-model evaluation of ExecutorSet and the code-viewer prompt on M0's C review task, with
 * M0's question and answer key, so the numbers compare directly with
 * `experiments/minimal-agent-loop/RUNS.md` (M0 C5: subtle 6.9, $0.0034; mini-agent v2: 5.3,
 * $0.0014). Needs DEEPSEEK_API_KEY; never part of the quality gate.
 *
 *   pnpm --filter @multiagentos/executor-set run eval -- --repeat 10 --label m1-draft
 */
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  // `pnpm run eval -- --repeat 3` passes the `--` through.
  allowPositionals: true,
  options: {
    repeat: { type: 'string', default: '5' },
    label: { type: 'string', default: 'run' },
    model: { type: 'string' },
    question: {
      type: 'string',
      default: '检查这个 C 仓库中可能导致崩溃、内存错误或错误结果的问题。',
    },
    repository: { type: 'string', default: join(here, 'fixtures/c-review') },
    key: { type: 'string', default: join(here, 'fixtures/c-review-answer-key.json') },
  },
});

const apiKey = process.env['DEEPSEEK_API_KEY'];
if (apiKey === undefined || apiKey.length === 0) {
  console.error('DEEPSEEK_API_KEY is not set.');
  process.exit(2);
}

const setup = await loadCodeViewer(values.model);
const issues = loadAnswerKey(resolve(values.key));
const subprocess = createSubprocessRunner();
const prices = setup.model.pricing.offPeak;
const cost = (result: LoopResult) =>
  result.calls.reduce((total, call) => {
    const usage = call.usage;
    if (usage === undefined) return total;
    const hit = usage.inputCacheHitTokens ?? 0;
    return (
      total +
      (hit * prices.inputCacheHit +
        (usage.inputTokens - hit) * prices.inputCacheMiss +
        usage.outputTokens * prices.output) /
        1e12
    );
  }, 0);

interface Row {
  readonly repeat: number;
  readonly result: LoopResult;
  readonly grade: Grade;
  readonly costUsd: number;
  readonly seconds: number;
}
const rows: Row[] = [];
for (let repeat = 1; repeat <= Number(values.repeat); repeat += 1) {
  const started = Date.now();
  const result = await runAgentLoop({
    question: values.question,
    repositoryRoot: resolve(values.repository),
    registry: createExecutorRegistry(),
    agent: setup.agent,
    model: setup.model,
    instructions: setup.instructions,
    tools: setup.tools,
    apiKey,
    subprocess,
  });
  const row: Row = {
    repeat,
    result,
    grade: gradeReport(result.report, issues),
    costUsd: cost(result),
    seconds: (Date.now() - started) / 1000,
  };
  rows.push(row);
  const sum = (pick: (usage: NonNullable<LoopResult['calls'][number]['usage']>) => number) =>
    result.calls.reduce(
      (total, call) => total + (call.usage === undefined ? 0 : pick(call.usage)),
      0,
    );
  console.log(
    [
      `#${repeat}`,
      result.endReason,
      `calls=${result.calls.length}`,
      `in=${sum((usage) => usage.inputTokens)}`,
      `hit=${sum((usage) => usage.inputCacheHitTokens ?? 0)}`,
      `out=${sum((usage) => usage.outputTokens)}`,
      `$${row.costUsd.toFixed(4)}`,
      `${row.seconds.toFixed(1)}s`,
      `core=${row.grade.coreFound}/${row.grade.coreTotal}`,
      `subtle=${row.grade.subtleFound}/${row.grade.subtleTotal}`,
      `verified=${result.verified}/${result.verified + result.unverified}`,
      `reads=${result.reads}`,
      `repeated=${result.repeatedReads}`,
      `searches=${result.searches}`,
      result.failure ?? '',
    ].join('  '),
  );
}

const mean = (pick: (row: Row) => number) =>
  rows.reduce((total, row) => total + pick(row), 0) / Math.max(rows.length, 1);
const summary = {
  runs: rows.length,
  succeeded: rows.filter((row) => row.result.ok).length,
  calls: mean((row) => row.result.calls.length),
  costUsd: mean((row) => row.costUsd),
  seconds: mean((row) => row.seconds),
  core: mean((row) => row.grade.coreFound),
  subtle: mean((row) => row.grade.subtleFound),
  verifiedShare: mean(
    (row) => row.result.verified / Math.max(row.result.verified + row.result.unverified, 1),
  ),
  withRepeatedReads: rows.filter((row) => row.result.repeatedReads > 0).length,
};
console.log(JSON.stringify(summary));
const directory = join(here, 'runs');
mkdirSync(directory, { recursive: true });
const file = join(
  directory,
  `${values.label}-${new Date().toISOString().replaceAll(':', '-')}.json`,
);
writeFileSync(
  file,
  JSON.stringify(
    { label: values.label, model: setup.model.id, question: values.question, summary, rows },
    null,
    2,
  ),
);
console.log(`saved ${file}`);
