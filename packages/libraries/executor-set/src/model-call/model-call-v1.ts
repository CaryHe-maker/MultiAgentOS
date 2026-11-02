import { APICallError } from 'ai';
import {
  MEDIA_TYPES,
  canonicalJson,
  type AssembleContextPackV1,
  type ExecutorEnvironmentV1,
  type ExecutorOutcomeV1,
  type ExecutorV1,
  type ModelCallOutputV1,
  type ModelExecutorInputV1,
  type ModelRawOutput,
  type RequestState,
} from '@multiagentos/contracts';
import { violation } from '../outcome/outcomes.js';
import { createLanguageModel, type LanguageModel, type ModelScope } from './language-model.js';
import {
  MAX_TOOL_CALLS,
  classifyCall,
  failureOf,
  finishReasonOf,
  parseCall,
  usageOf,
} from './model-call-executor.js';
import { toPrompt, toTools, toolSpecsOf } from './provider-request.js';
import { trackedFetch, type RequestProgress } from './tracked-fetch.js';

type GenerateResult = Awaited<ReturnType<LanguageModel['doGenerate']>>;

export interface ModelCallV1Options {
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
const replayOf = (pack: AssembleContextPackV1): readonly (string | undefined)[] =>
  pack.items.flatMap((item) =>
    item.role === 'assistant'
      ? ['reasoningContent' in item ? item.reasoningContent : undefined]
      : [],
  );

/**
 * MODEL in major 1 (ExecutorSet 7). A final call first offers the end tools freely; a reply that
 * is not exactly one valid call of them fails retryably, and the retry forces the tool by name
 * with thinking off, because forcing needs thinking off on DeepSeek.
 */
export function createModelCallExecutorV1(options: ModelCallV1Options = {}): ExecutorV1<'MODEL'> {
  const inner = options.fetch ?? globalThis.fetch;
  return {
    executionKind: 'MODEL',
    execute: async (input, environment) => {
      try {
        return await callModel(input, environment, inner);
      } catch {
        return failureOf('INTERNAL', false, 'UNKNOWN') as ExecutorOutcomeV1;
      }
    },
  };
}

async function callModel(
  input: ModelExecutorInputV1,
  environment: ExecutorEnvironmentV1,
  inner: typeof globalThis.fetch,
): Promise<ExecutorOutcomeV1> {
  const base = environment.scope;
  if (base.kind !== 'MODEL') return violation('SCOPE_MISSING') as ExecutorOutcomeV1;
  if (environment.signal.aborted)
    return failureOf('INTERNAL', false, 'NOT_SENT') as ExecutorOutcomeV1;
  const apiKey = environment.credentials.apiKeyFor(base.provider);
  if (apiKey === undefined || apiKey.length === 0)
    return failureOf('PROVIDER_AUTH', false, 'NOT_SENT') as ExecutorOutcomeV1;

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
    const outcome = classifyCall(error, progress, environment.signal) as ExecutorOutcomeV1;
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

function completedCall(
  result: GenerateResult,
  scope: ModelScope,
  environment: ExecutorEnvironmentV1,
  input: ModelExecutorInputV1,
): ExecutorOutcomeV1 {
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
    return failureOf('PROVIDER_TOOL_CHOICE_IGNORED', true, 'SENT', usage) as ExecutorOutcomeV1;
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
  const output: ModelCallOutputV1 =
    toolCalls.length > 0
      ? { finishReason: 'TOOL_CALLS', toolCalls, hasText: text.length > 0, hasReasoning }
      : {
          finishReason: finishReasonOf(result.finishReason.unified),
          toolCalls: [],
          hasText: text.length > 0,
          hasReasoning,
        };
  const requestState: RequestState = 'SENT';
  return {
    outcome: 'COMPLETED',
    result: {
      output,
      artifact: { mediaType: MEDIA_TYPES.modelOutput, text: canonicalJson(raw) },
      ...(reasoning === undefined ? {} : { reasoning: { text: reasoning } }),
    },
    requestState,
    ...(usage === undefined ? {} : { usage }),
  };
}
