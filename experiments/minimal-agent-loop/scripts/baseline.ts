// Baseline runner: runs the experiment unchanged against real DeepSeek and records
// per-run metrics (success, model calls, tokens, cache hits, cost, latency).
// It only wraps fetch to observe responses; it does not modify the agent loop.
//
// Usage (from repo root, DEEPSEEK_API_KEY in env):
//   pnpm exec tsx experiments/minimal-agent-loop/scripts/baseline.ts [repeats] [label] [caseId]
// c-review answers are graded against evals/c-review-answer-key.json (see grade.ts).
// MINIMAL_AGENT_LOOP_STATUS_BAR=1 turns on the per-call status bar (experiment C7).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createExperimentRuntime } from '../src/index.js';
import type { UserRequest } from '../src/contracts.js';
import { countFileReads, formatGrade, gradeReview, loadAnswerKey, type Grade } from './grade.js';

// Same prices as ../mini-agent/src/llm.ts (USD per 1M tokens, off-peak).
const PRICE_CACHE_HIT = 0.003;
const PRICE_CACHE_MISS = 0.15;
const PRICE_OUTPUT = 0.6;

const experimentDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CASES: readonly { readonly id: string; readonly request: UserRequest }[] = [
  { id: 'hi', request: { prompt: 'hi' } },
  {
    id: 'c-review',
    request: {
      prompt: '检查这个 C 仓库中可能导致崩溃、内存错误或错误结果的问题。',
      repository: {
        rootPath: join(experimentDir, 'fixtures/c-review'),
        revision: 'fixture-c-review-v1',
      },
    },
  },
];

interface CallRecord {
  readonly httpStatus: number;
  readonly latencyMs: number;
  readonly cacheHit: number;
  readonly cacheMiss: number;
  readonly output: number;
  readonly reasoning: number;
  readonly content: string | null;
  readonly toolCalls: readonly string[];
}

interface RunRecord {
  readonly caseId: string;
  readonly statusBar: boolean;
  readonly repeat: number;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly answer?: string;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly cacheHit: number;
  readonly output: number;
  readonly reasoning: number;
  readonly costUsd: number;
  readonly wallMs: number;
  readonly fileReads: number;
  /** file_read calls whose range was already fully covered by an earlier read. */
  readonly duplicateReads: number;
  readonly grade?: Grade;
  readonly calls: readonly CallRecord[];
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function toCallRecord(httpStatus: number, latencyMs: number, body: string): CallRecord {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Keep zeros; the loop itself reports the parse failure.
  }
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const details = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(payload.choices) ? (payload.choices as unknown[]) : [];
  const message = ((choices[0] ?? {}) as Record<string, unknown>).message as
    Record<string, unknown> | undefined;
  const content = typeof message?.content === 'string' ? message.content : null;
  const rawToolCalls = Array.isArray(message?.tool_calls) ? (message.tool_calls as unknown[]) : [];
  const toolCalls = rawToolCalls.map((call) => {
    const fn = ((call ?? {}) as Record<string, unknown>).function as
      Record<string, unknown> | undefined;
    return `${String(fn?.name)} ${String(fn?.arguments)}`;
  });
  return {
    httpStatus,
    latencyMs,
    cacheHit: num(usage.prompt_cache_hit_tokens),
    cacheMiss: num(usage.prompt_cache_miss_tokens),
    output: num(usage.completion_tokens),
    reasoning: num(details.reasoning_tokens),
    content,
    toolCalls,
  };
}

const answerKey = loadAnswerKey();
const statusBar = process.env.MINIMAL_AGENT_LOOP_STATUS_BAR === '1';

async function runOnce(caseId: string, request: UserRequest, repeat: number): Promise<RunRecord> {
  const calls: CallRecord[] = [];
  const recordingFetch: typeof globalThis.fetch = async (input, init) => {
    const started = performance.now();
    const response = await globalThis.fetch(input, init);
    const body = await response.clone().text();
    calls.push(toCallRecord(response.status, Math.round(performance.now() - started), body));
    return response;
  };

  const started = performance.now();
  const result = await createExperimentRuntime({ fetch: recordingFetch, statusBar }).kernel.run(
    request,
  );
  const wallMs = Math.round(performance.now() - started);

  const cacheHit = calls.reduce((sum, call) => sum + call.cacheHit, 0);
  const cacheMiss = calls.reduce((sum, call) => sum + call.cacheMiss, 0);
  const output = calls.reduce((sum, call) => sum + call.output, 0);
  const reasoning = calls.reduce((sum, call) => sum + call.reasoning, 0);
  const costUsd =
    (cacheHit * PRICE_CACHE_HIT + cacheMiss * PRICE_CACHE_MISS + output * PRICE_OUTPUT) / 1_000_000;
  const reads = countFileReads(calls.map((call) => call.toolCalls));
  const grade =
    result.ok && caseId === 'c-review' ? gradeReview(result.value.answer, answerKey) : undefined;

  return {
    caseId,
    statusBar,
    repeat,
    ok: result.ok,
    ...(result.ok
      ? { answer: result.value.answer }
      : { errorCode: result.error.code, errorMessage: result.error.message }),
    modelCalls: calls.length,
    inputTokens: cacheHit + cacheMiss,
    cacheHit,
    output,
    reasoning,
    costUsd,
    wallMs,
    fileReads: reads.total,
    duplicateReads: reads.duplicates,
    ...(grade === undefined ? {} : { grade }),
    calls,
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(caseId: string, runs: readonly RunRecord[]): string {
  const passed = runs.filter((run) => run.ok);
  const graded = passed.flatMap((run) => (run.grade === undefined ? [] : [run.grade]));
  const parts = [
    `${caseId}: ok=${passed.length}/${runs.length}`,
    `calls=${mean(runs.map((run) => run.modelCalls)).toFixed(1)}`,
    `in=${mean(runs.map((run) => run.inputTokens)).toFixed(0)}`,
    `out=${mean(runs.map((run) => run.output)).toFixed(0)}`,
    `$${mean(runs.map((run) => run.costUsd)).toFixed(4)}`,
    `${(mean(runs.map((run) => run.wallMs)) / 1000).toFixed(1)}s`,
  ];
  if (graded.length > 0) {
    const core = mean(graded.map((grade) => grade.coreFound)).toFixed(1);
    const subtle = mean(graded.map((grade) => grade.subtleFound)).toFixed(1);
    const [first] = graded;
    parts.push(`core=${core}/${first?.coreTotal}`, `subtle=${subtle}/${first?.subtleTotal}`);
    const rereads = runs.filter((run) => run.duplicateReads > 0).length;
    parts.push(`runs-with-rereads=${rereads}/${runs.length}`);
  }
  return parts.join('  ');
}

async function main(): Promise<void> {
  const repeats = Number(process.argv[2] ?? '3');
  const label = process.argv[3] ?? 'baseline';
  console.log(`status bar: ${statusBar ? 'on' : 'off'}`);
  const onlyCase = process.argv[4];
  const records: RunRecord[] = [];
  const cases = CASES.filter(({ id }) => onlyCase === undefined || id === onlyCase);
  if (cases.length === 0) throw new Error(`Unknown case: ${String(onlyCase)}`);

  for (const { id, request } of cases) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const record = await runOnce(id, request, repeat);
      records.push(record);
      const hitRate = record.inputTokens === 0 ? 0 : record.cacheHit / record.inputTokens;
      console.log(
        [
          `${id}#${repeat}`,
          record.ok ? 'OK' : `FAIL ${record.errorCode ?? ''}`,
          `calls=${record.modelCalls}`,
          `in=${record.inputTokens}`,
          `hit=${(hitRate * 100).toFixed(0)}%`,
          `out=${record.output}`,
          `reasoning=${record.reasoning}`,
          `$${record.costUsd.toFixed(4)}`,
          `${(record.wallMs / 1000).toFixed(1)}s`,
          ...(record.fileReads > 0
            ? [`reads=${record.fileReads}(dup ${record.duplicateReads})`]
            : []),
          ...(record.grade === undefined ? [] : [formatGrade(record.grade)]),
        ].join('  '),
      );
    }
  }

  console.log('');
  for (const { id } of cases) {
    console.log(
      summarize(
        id,
        records.filter((record) => record.caseId === id),
      ),
    );
  }

  const outDir = join(experimentDir, 'runs');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outFile = join(outDir, `${label}-${stamp}.json`);
  writeFileSync(outFile, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`\nSaved ${records.length} runs to ${outFile}`);
}

await main();
