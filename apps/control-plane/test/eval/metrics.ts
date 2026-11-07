/**
 * The measures of a run, read from the Session log alone (docs/M2/Evaluation.md 4). A task never
 * counts anything itself: whatever mode it drives, the same records give the same figures, so a
 * new mode or a new task set needs no code of its own to be measured.
 */
import { modelCallCost } from '@multiagentos/agent-tool-pool';
import type { ModelDefinition } from '@multiagentos/contracts';
import type { RunMetrics } from './spec.js';

type LogRecord = Readonly<Record<string, unknown>>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
const bump = (map: Record<string, number>, key: string, by = 1): void => {
  map[key] = (map[key] ?? 0) + by;
};
const millis = (record: LogRecord): number => {
  const parsed = Date.parse(text(record['at']));
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** The most intervals that overlap at one moment. */
export function maxOverlap(intervals: readonly (readonly [number, number])[]): number {
  const edges = intervals
    .flatMap(([from, to]) => [
      [from, 1],
      [to, -1],
    ])
    // Where one ends and another starts at the same moment, the end counts first.
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0));
  let open = 0;
  let most = 0;
  for (const [, delta] of edges) {
    open += delta ?? 0;
    most = Math.max(most, open);
  }
  return most;
}

export function metricsOf(
  log: readonly LogRecord[],
  options: {
    /** The price list of the model, for the cost; without it the cost is null. */
    readonly model?: Pick<ModelDefinition, 'pricing'>;
    /** Questions of authorization the console showed (they are not in the log). */
    readonly authorizationQuestions?: number;
  } = {},
): RunMetrics {
  const toolRequests: Record<string, number> = {};
  const toolOutcomes: Record<string, number> = {};
  const agentRuns: Record<string, number> = {};
  const toolOfCall = new Map<string, string>();
  const callOfRequest = new Map<string, string>();
  const startedAt = new Map<string, number>();
  const intervals: [number, number][] = [];
  let turns = 0;
  let modelRequests = 0;
  let failedModelRequests = 0;
  let input = 0;
  let output = 0;
  let cacheHit = 0;
  let compactionInput = 0;
  let compactionOutput = 0;
  let cost = 0;
  let priced = false;
  let summarised = 0;
  let pruned = 0;
  let humanRequests = 0;
  let wrapUps = 0;

  const price = (inputTokens: number, outputTokens: number, hit: number, at: number): void => {
    if (options.model === undefined) return;
    priced = true;
    cost +=
      modelCallCost(
        options.model,
        { inputTokens, outputTokens, inputCacheHitTokens: Math.min(hit, inputTokens) },
        new Date(at),
      ).microUsd / 1_000_000;
  };

  for (const record of log) {
    switch (record['type']) {
      case 'TURN_STARTED':
        turns += 1;
        break;
      case 'AGENT_RUN_REGISTERED': {
        const ref = record['agentRef'] as { id?: unknown } | undefined;
        bump(agentRuns, text(ref?.id) || 'unknown');
        break;
      }
      case 'MODEL_TURN': {
        modelRequests += 1;
        for (const call of (record['toolCalls'] as readonly LogRecord[] | undefined) ?? []) {
          const name = text(call['toolName']);
          toolOfCall.set(text(call['toolCallId']), name);
          bump(toolRequests, name);
        }
        const usage = record['usage'] as LogRecord | undefined;
        if (usage !== undefined) {
          input += num(usage['inputTokens']);
          output += num(usage['outputTokens']);
          cacheHit += num(usage['inputCacheHitTokens']);
          price(
            num(usage['inputTokens']),
            num(usage['outputTokens']),
            num(usage['inputCacheHitTokens']),
            millis(record),
          );
        }
        break;
      }
      case 'MODEL_ATTEMPT_FAILED':
        failedModelRequests += 1;
        break;
      case 'UNIT_SUBMITTED': {
        const source = record['inputSource'] as LogRecord | undefined;
        if (source?.['kind'] === 'TOOL_CALL') {
          callOfRequest.set(text(record['requestId']), text(source['toolCallId']));
          startedAt.set(text(record['requestId']), millis(record));
        }
        break;
      }
      case 'UNIT_COMPLETED': {
        const requestId = text(record['requestId']);
        const call = callOfRequest.get(requestId);
        if (call === undefined) break;
        const tool = toolOfCall.get(call) ?? 'unknown';
        const status = text(record['status']) || 'OK';
        const reason = text(record['reasonCode']);
        bump(toolOutcomes, `${tool}:${reason === '' ? status : `${status}(${reason})`}`);
        const from = startedAt.get(requestId);
        if (from !== undefined) intervals.push([from, millis(record)]);
        break;
      }
      case 'CONTEXT_COMPACTED': {
        summarised += 1;
        const usage = record['usage'] as LogRecord | undefined;
        if (usage !== undefined) {
          compactionInput += num(usage['inputTokens']);
          compactionOutput += num(usage['outputTokens']);
          price(
            num(usage['inputTokens']),
            num(usage['outputTokens']),
            num(usage['cachedInputTokens']),
            millis(record),
          );
        }
        break;
      }
      case 'TOOL_RESULTS_PRUNED':
        pruned += ((record['items'] as readonly unknown[] | undefined) ?? []).length;
        break;
      case 'HUMAN_REQUESTED':
        // The request for the next input comes at the end of every Turn; it is not a question.
        if (record['kind'] !== 'prompt') humanRequests += 1;
        break;
      case 'AGENT_WRAP_UP':
        wrapUps += 1;
        break;
      default:
        break;
    }
  }

  const first = log.length === 0 ? 0 : millis(log[0] ?? {});
  const last = log.length === 0 ? 0 : millis(log[log.length - 1] ?? {});
  return {
    logWallMs: Math.max(0, last - first),
    turns,
    modelRequests,
    failedModelRequests,
    tokens: { input, output, cacheHit, compactionInput, compactionOutput },
    cacheHitRate: input === 0 ? null : cacheHit / input,
    costUsd: priced ? cost : null,
    toolRequests,
    toolOutcomes,
    agentRuns,
    maxParallelUnits: maxOverlap(intervals),
    compactions: { summarised, pruned },
    authorizationQuestions: options.authorizationQuestions ?? 0,
    humanRequests,
    wrapUps,
  };
}
