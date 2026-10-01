// Baseline runner: runs the experiment unchanged against real DeepSeek and records
// per-run metrics (success, model calls, tokens, cache hits, cost, latency).
// It only wraps fetch to observe responses; it does not modify the agent loop.
//
// Usage (from repo root, DEEPSEEK_API_KEY in env):
//   pnpm exec tsx experiments/minimal-agent-loop/scripts/baseline.ts [repeats] [label]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createExperimentRuntime } from '../src/index.js';
import type { UserRequest } from '../src/contracts.js';

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
}

interface RunRecord {
  readonly caseId: string;
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
  return {
    httpStatus,
    latencyMs,
    cacheHit: num(usage.prompt_cache_hit_tokens),
    cacheMiss: num(usage.prompt_cache_miss_tokens),
    output: num(usage.completion_tokens),
    reasoning: num(details.reasoning_tokens),
    content,
  };
}

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
  const result = await createExperimentRuntime({ fetch: recordingFetch }).kernel.run(request);
  const wallMs = Math.round(performance.now() - started);

  const cacheHit = calls.reduce((sum, call) => sum + call.cacheHit, 0);
  const cacheMiss = calls.reduce((sum, call) => sum + call.cacheMiss, 0);
  const output = calls.reduce((sum, call) => sum + call.output, 0);
  const reasoning = calls.reduce((sum, call) => sum + call.reasoning, 0);
  const costUsd =
    (cacheHit * PRICE_CACHE_HIT + cacheMiss * PRICE_CACHE_MISS + output * PRICE_OUTPUT) / 1_000_000;

  return {
    caseId,
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
    calls,
  };
}

async function main(): Promise<void> {
  const repeats = Number(process.argv[2] ?? '3');
  const label = process.argv[3] ?? 'baseline';
  const records: RunRecord[] = [];

  for (const { id, request } of CASES) {
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
        ].join('  '),
      );
    }
  }

  const outDir = join(experimentDir, 'runs');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outFile = join(outDir, `${label}-${stamp}.json`);
  writeFileSync(outFile, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`\nSaved ${records.length} runs to ${outFile}`);
}

await main();
