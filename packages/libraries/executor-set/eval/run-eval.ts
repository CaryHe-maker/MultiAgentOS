import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { modelCallCost } from '@multiagentos/agent-tool-pool';
import { sha256Hex, type TokenUsage } from '@multiagentos/contracts';
import { createSubprocessRunner } from '@multiagentos/kernel';
import { createExecutorRegistry } from '../src/index.js';
import { BUDGET, runAgentLoop, type LoopResult } from './agent-loop.js';
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
  // `pnpm run eval -- --repeat 3` passes the `--` through; after it parseArgs would take every
  // option as a positional, so it is dropped, and unknown options stay errors.
  args: process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--')),
  options: {
    instructions: { type: 'string' },
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
/**
 * `--instructions <file>` replaces the catalog prompt for this evaluation only, so a prompt
 * change can be compared before the definition is edited; its digest is recorded.
 */
const instructions =
  values.instructions === undefined
    ? setup.instructions
    : readFileSync(resolve(values.instructions), 'utf8');
/**
 * Billed cost uses the peak price when a call fell in a peak window; the off-peak figure is the
 * one comparable with RUNS.md, whose M0 and mini-agent costs are all off-peak.
 */
const cost = (result: LoopResult, offPeak: boolean) =>
  result.calls.reduce((total, call) => {
    if (call.usage === undefined) return total;
    const billed = modelCallCost(setup.model, call.usage, new Date(call.at));
    const microUsd =
      offPeak && billed.peak
        ? (billed.microUsd * 100) / setup.model.pricing.peak.ratePercent
        : billed.microUsd;
    return total + microUsd / 1e6;
  }, 0);

interface Row {
  readonly repeat: number;
  readonly result: LoopResult;
  readonly grade: Grade;
  readonly costUsd: number;
  readonly offPeakCostUsd: number;
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
    instructions,
    tools: setup.tools,
    apiKey,
    subprocess,
  });
  const row: Row = {
    repeat,
    result,
    grade: gradeReport(result.report, issues),
    costUsd: cost(result, false),
    offPeakCostUsd: cost(result, true),
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
      `$${row.costUsd.toFixed(4)} (off-peak $${row.offPeakCostUsd.toFixed(4)})`,
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

const tokens = (row: Row, pick: (usage: TokenUsage) => number) =>
  row.result.calls.reduce(
    (total, call) => total + (call.usage === undefined ? 0 : pick(call.usage)),
    0,
  );
const mean = (pick: (row: Row) => number) =>
  rows.reduce((total, row) => total + pick(row), 0) / Math.max(rows.length, 1);
const summary = {
  runs: rows.length,
  succeeded: rows.filter((row) => row.result.ok).length,
  calls: mean((row) => row.result.calls.length),
  costUsd: mean((row) => row.costUsd),
  offPeakCostUsd: mean((row) => row.offPeakCostUsd),
  inputTokens: mean((row) => tokens(row, (usage) => usage.inputTokens)),
  outputTokens: mean((row) => tokens(row, (usage) => usage.outputTokens)),
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
    { label: values.label, record: runRecord(), question: values.question, summary, rows },
    null,
    2,
  ),
);
console.log(`saved ${file}`);

/**
 * What M1TechStack 11 requires of every evaluation that uses a model: provider, model,
 * configuration, the digests of the definitions, the commit, tokens, cost and time (the last
 * three are in the rows).
 */
function runRecord() {
  return {
    recordedAt: new Date().toISOString(),
    provider: setup.model.provider,
    model: {
      id: setup.model.id,
      apiModelId: setup.model.apiModelId,
      label: setup.model.providerModelLabel,
    },
    thinking: setup.agent.modelSettings,
    configuration: {
      budget: BUDGET,
      limits: setup.agent.limits,
      regenerationLimit: 3,
      noProgressRounds: 2,
    },
    digests: setup.digests,
    instructionsSha256: sha256Hex(instructions),
    instructionsFile: values.instructions,
    commit: gitCommit(here),
  };
}

/** Reads HEAD without running git: the product never calls git, and neither does this. */
function gitCommit(start: string): string | undefined {
  let directory = start;
  while (!existsSync(join(directory, '.git'))) {
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  const git = join(directory, '.git');
  const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;
  const ref = head.slice('ref: '.length);
  if (existsSync(join(git, ref))) return readFileSync(join(git, ref), 'utf8').trim();
  const packed = existsSync(join(git, 'packed-refs'))
    ? readFileSync(join(git, 'packed-refs'), 'utf8')
    : '';
  return packed
    .split('\n')
    .find((line) => line.endsWith(` ${ref}`))
    ?.split(' ')[0];
}
