import { APICallError } from 'ai';
import {
  MEDIA_TYPES,
  canonicalJson,
  type AssembleContextPack,
  type Executor,
  type ExecutorEnvironment,
  type ExecutorOutcome,
  type ModelCallOutput,
  type ModelExecutorInput,
  type ModelRawOutput,
  type ModelToolCall,
  type RequestState,
  type TokenUsage,
} from '@multiagentos/contracts';
import { rejected, violation } from '../outcome/outcomes.js';
import { createLanguageModel, type LanguageModel, type ModelScope } from './language-model.js';
import { toPrompt, toTools, toolSpecsOf } from './provider-request.js';
import { trackedFetch, type RequestProgress } from './tracked-fetch.js';

type GenerateResult = Awaited<ReturnType<LanguageModel['doGenerate']>>;

/** ModelCallOutput holds at most this many calls; the artifact keeps all of them. */
export const MAX_TOOL_CALLS = 32;

export interface ModelCallExecutorOptions {
  /** The HTTP client handed to the provider SDK; tests pass a fake, production uses `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Seconds or an HTTP date; anything else means no hint (ExecutorSet 7). */
export function retryAfterMsOf(header: string | undefined, now: Date): number | undefined {
  if (header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

function reasoningOf(result: GenerateResult): string | undefined {
  const parts = result.content.flatMap((part) => (part.type === 'reasoning' ? [part.text] : []));
  if (parts.length > 0) return parts.join('');
  // The OpenAI adapter does not read DeepSeek's field, so the raw body is consulted.
  const body = result.response?.body as
    { choices?: { message?: { reasoning_content?: unknown } }[] } | undefined;
  const raw = body?.choices?.[0]?.message?.reasoning_content;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** What each assistant message replays, in message order (ExecutorSet 6.3). */
const replayOf = (pack: AssembleContextPack): readonly (string | undefined)[] =>
  pack.items.flatMap((item) =>
    item.role === 'assistant'
      ? ['reasoningContent' in item ? item.reasoningContent : undefined]
      : [],
  );

/**
 * MODEL (ExecutorSet 7): one provider request for one ASSEMBLE pack, without SDK retries, aborted
 * by the environment's signal. The API key comes only from `credentials` and never reaches
 * outputs, artifacts or errors. A final call first offers the end tools freely; a reply that
 * is not exactly one valid call of them fails retryably, and the retry forces the tool by name
 * with thinking off, because forcing needs thinking off on DeepSeek.
 */
export function createModelCallExecutor(options: ModelCallExecutorOptions = {}): Executor<'MODEL'> {
  const inner = options.fetch ?? globalThis.fetch;
  return {
    executionKind: 'MODEL',
    execute: async (input, environment) => {
      try {
        return await callModel(input, environment, inner);
      } catch {
        return failureOf('INTERNAL', false, 'UNKNOWN');
      }
    },
  };
}

async function callModel(
  input: ModelExecutorInput,
  environment: ExecutorEnvironment,
  inner: typeof globalThis.fetch,
): Promise<ExecutorOutcome> {
  const base = environment.scope;
  if (base.kind !== 'MODEL') return violation('SCOPE_MISSING');
  if (environment.signal.aborted) return failureOf('INTERNAL', false, 'NOT_SENT');
  const apiKey = environment.credentials.apiKeyFor(base.provider);
  if (apiKey === undefined || apiKey.length === 0)
    return failureOf('PROVIDER_AUTH', false, 'NOT_SENT');

  const forced = input.finalMode === 'FORCED';
  const scope: ModelScope = forced
    ? {
        kind: 'MODEL',
        provider: base.provider,
        apiModelId: base.apiModelId,
        apiProtocol: base.apiProtocol,
        baseUrl: base.baseUrl,
        thinking: 'DISABLED',
      }
    : base;
  const progress: RequestProgress = {
    started: false,
    failedBeforeSending: false,
    responded: false,
  };
  const pack = input.contextPack;
  const replay = forced ? [] : replayOf(pack);
  const model = createLanguageModel(scope, apiKey, trackedFetch(inner, scope, progress, replay));
  const specs = toolSpecsOf(pack);
  const end = specs.find((spec) => spec.purpose === 'CONTROL')?.name;
  const { limits } = environment;
  let result: GenerateResult;
  try {
    result = await model.doGenerate({
      prompt: toPrompt(pack),
      ...('maxOutputTokens' in limits ? { maxOutputTokens: limits.maxOutputTokens } : {}),
      ...(specs.length === 0
        ? {}
        : {
            tools: toTools(specs),
            toolChoice:
              forced && end !== undefined ? { type: 'tool', toolName: end } : { type: 'auto' },
          }),
      abortSignal: environment.signal,
    });
  } catch (error) {
    const outcome = classifyCall(error, progress, environment.signal);
    if (
      outcome.outcome === 'FAILED' &&
      outcome.retryable &&
      APICallError.isInstance(error) &&
      error.responseHeaders !== undefined
    ) {
      const retryAfterMs = retryAfterMsOf(error.responseHeaders['retry-after'], environment.now());
      if (retryAfterMs !== undefined) return { ...outcome, retryAfterMs };
    }
    return outcome;
  }
  return completedCall(result, base, environment, input);
}

export function failureOf(
  reasonCode:
    | 'PROVIDER_UNREACHABLE'
    | 'PROVIDER_RATE_LIMITED'
    | 'PROVIDER_AUTH'
    | 'PROVIDER_ERROR'
    | 'PROVIDER_TOOL_CHOICE_IGNORED'
    | 'INTERNAL',
  retryable: boolean,
  requestState: RequestState,
  usage?: TokenUsage,
): ExecutorOutcome {
  return {
    outcome: 'FAILED',
    reasonCode,
    retryable,
    requestState,
    ...(usage === undefined ? {} : { usage }),
  };
}

/** DeepSeek's wording; the estimate should keep this from ever happening. */
const isContextOverflow = (error: unknown): boolean =>
  error instanceof Error &&
  /maximum context length|context.*(too long|exceed)/iu.test(error.message);

/** What each way a call can go wrong means for the Unit. */
export function classifyCall(
  error: unknown,
  progress: RequestProgress,
  signal: AbortSignal,
): ExecutorOutcome {
  if (signal.aborted)
    return failureOf(
      'INTERNAL',
      false,
      progress.started && !progress.failedBeforeSending ? 'UNKNOWN' : 'NOT_SENT',
    );
  const status = APICallError.isInstance(error) ? error.statusCode : undefined;
  if (status !== undefined) {
    if (status === 429) return failureOf('PROVIDER_RATE_LIMITED', true, 'NOT_SENT');
    if (status === 401 || status === 403) return failureOf('PROVIDER_AUTH', false, 'NOT_SENT');
    if (status === 408 || status >= 500) return failureOf('PROVIDER_ERROR', false, 'UNKNOWN');
    if (status === 400 && isContextOverflow(error)) return rejected('LIMIT_EXCEEDED');
    if (status >= 400) return failureOf('INTERNAL', false, 'NOT_SENT');
  }
  if (!progress.started || progress.failedBeforeSending)
    return failureOf('PROVIDER_UNREACHABLE', true, 'NOT_SENT');
  // Reset connections, broken bodies and unreadable answers: the provider may have processed it.
  return failureOf('PROVIDER_ERROR', false, 'UNKNOWN');
}

function completedCall(
  result: GenerateResult,
  scope: ModelScope,
  environment: ExecutorEnvironment,
  input: ModelExecutorInput,
): ExecutorOutcome {
  const text = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  const rawCalls = result.content.flatMap((part) =>
    part.type === 'tool-call'
      ? [{ toolCallId: part.toolCallId, toolName: part.toolName, argumentsText: part.input }]
      : [],
  );
  const toolCalls = rawCalls.slice(0, MAX_TOOL_CALLS).map(parseCall);
  const usage = usageOf(result);
  const ends = new Set(
    toolSpecsOf(input.contextPack)
      .filter((spec) => spec.purpose === 'CONTROL')
      .map((spec) => spec.name),
  );
  const only = toolCalls[0];
  if (
    input.final &&
    (rawCalls.length !== 1 ||
      only === undefined ||
      !ends.has(only.toolName) ||
      only.arguments === null)
  )
    return failureOf('PROVIDER_TOOL_CHOICE_IGNORED', true, 'SENT', usage);
  const reasoning = reasoningOf(result);
  const hasReasoning = reasoning !== undefined;
  const raw: ModelRawOutput = {
    provider: scope.provider,
    apiModelId: scope.apiModelId,
    providerFinishReason: result.finishReason.raw ?? result.finishReason.unified,
    ...(text.length === 0 ? {} : { text }),
    toolCalls: rawCalls,
    ...(usage === undefined ? {} : { usage }),
    receivedAt: environment.now().toISOString(),
  };
  const output: ModelCallOutput =
    toolCalls.length > 0
      ? { finishReason: 'TOOL_CALLS', toolCalls, hasText: text.length > 0, hasReasoning }
      : {
          finishReason: finishReasonOf(result.finishReason.unified),
          toolCalls: [],
          hasText: text.length > 0,
          hasReasoning,
        };
  return {
    outcome: 'COMPLETED',
    result: {
      output,
      artifact: { mediaType: MEDIA_TYPES.modelOutput, text: canonicalJson(raw) },
      ...(reasoning === undefined ? {} : { reasoning: { text: reasoning } }),
    },
    requestState: 'SENT',
    ...(usage === undefined ? {} : { usage }),
  };
}

export function parseCall(call: {
  toolCallId: string;
  toolName: string;
  argumentsText: string;
}): ModelToolCall {
  try {
    const parsed: unknown = JSON.parse(call.argumentsText);
    if (parsed !== null)
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        arguments: parsed as Record<string, unknown>,
      };
  } catch {
    // falls through to INVALID_JSON
  }
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    arguments: null,
    argumentsError: 'INVALID_JSON',
  };
}

export function finishReasonOf(
  unified: GenerateResult['finishReason']['unified'],
): 'STOP' | 'LENGTH' | 'CONTENT_FILTER' | 'OTHER' {
  if (unified === 'stop') return 'STOP';
  if (unified === 'length') return 'LENGTH';
  if (unified === 'content-filter') return 'CONTENT_FILTER';
  return 'OTHER';
}

/**
 * Provider usage. DeepSeek reports cache hits as `prompt_cache_hit_tokens`, which the OpenAI
 * adapter does not read, so the raw body is consulted when the adapter has no cache figure.
 */
export function usageOf(result: GenerateResult): TokenUsage | undefined {
  const inputTokens = result.usage.inputTokens.total;
  const outputTokens = result.usage.outputTokens.total;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const body = result.response?.body as
    { usage?: { prompt_cache_hit_tokens?: unknown } } | undefined;
  const fromBody = body?.usage?.prompt_cache_hit_tokens;
  const cacheRead =
    result.usage.inputTokens.cacheRead || (typeof fromBody === 'number' ? fromBody : undefined);
  return {
    inputTokens,
    outputTokens,
    ...(cacheRead === undefined ? {} : { inputCacheHitTokens: Math.min(cacheRead, inputTokens) }),
  };
}
