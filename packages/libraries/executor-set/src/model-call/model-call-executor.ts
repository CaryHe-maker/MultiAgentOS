import { APICallError } from 'ai';
import {
  MEDIA_TYPES,
  canonicalJson,
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
import { violation } from '../outcome/outcomes.js';
import { createLanguageModel, type LanguageModel, type ModelScope } from './language-model.js';
import { toPrompt, toToolChoice, toTools, toolSpecsOf } from './provider-request.js';
import { trackedFetch, type RequestProgress } from './tracked-fetch.js';

type GenerateResult = Awaited<ReturnType<LanguageModel['doGenerate']>>;

/** ModelCallOutput holds at most this many calls; the artifact keeps all of them (issue #26). */
export const MAX_TOOL_CALLS = 32;

export interface ModelCallExecutorOptions {
  /** The HTTP client handed to the provider SDK; tests pass a fake, production uses `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * MODEL (ExecutorSet 4.5): one provider request for one ASSEMBLE pack, without SDK retries,
 * aborted by the environment's signal. Failures follow the table of 4.5 and issue #26 C; the
 * API key comes only from `credentials` and never reaches outputs, artifacts or errors.
 */
export function createModelCallExecutor(options: ModelCallExecutorOptions = {}): Executor<'MODEL'> {
  const inner = options.fetch ?? globalThis.fetch;
  return {
    executionKind: 'MODEL',
    execute: async (input, environment) => {
      try {
        return await callModel(input, environment, inner);
      } catch {
        return failure('INTERNAL', false, 'UNKNOWN');
      }
    },
  };
}

async function callModel(
  input: ModelExecutorInput,
  environment: ExecutorEnvironment,
  inner: typeof globalThis.fetch,
): Promise<ExecutorOutcome> {
  const scope = environment.scope;
  if (scope.kind !== 'MODEL') return violation('SCOPE_MISSING');
  if (environment.signal.aborted) return failure('INTERNAL', false, 'NOT_SENT');
  const apiKey = environment.credentials.apiKeyFor(scope.provider);
  if (apiKey === undefined || apiKey.length === 0)
    return failure('PROVIDER_AUTH', false, 'NOT_SENT');

  const progress: RequestProgress = {
    started: false,
    failedBeforeSending: false,
    responded: false,
  };
  const model = createLanguageModel(scope, apiKey, trackedFetch(inner, scope, progress));
  const specs = toolSpecsOf(input.contextPack);
  const limits = environment.limits;
  let result: GenerateResult;
  try {
    result = await model.doGenerate({
      prompt: toPrompt(input.contextPack),
      ...('maxOutputTokens' in limits && limits.maxOutputTokens !== undefined
        ? { maxOutputTokens: limits.maxOutputTokens }
        : {}),
      ...(specs.length === 0
        ? {}
        : { tools: toTools(specs), toolChoice: toToolChoice(specs, input.final) }),
      ...(scope.apiProtocol === 'ANTHROPIC_MESSAGES' ? { reasoning: reasoningOf(scope) } : {}),
      abortSignal: environment.signal,
    });
  } catch (error) {
    return classify(error, progress, environment.signal);
  }
  return completedCall(result, scope, environment, input.final ? finishOf(specs) : undefined);
}

function reasoningOf(scope: ModelScope): 'none' | 'provider-default' | 'low' | 'medium' | 'high' {
  if (scope.thinking === 'DISABLED') return 'none';
  const effort = scope.thinkingEffort;
  return effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'provider-default';
}

function failure(
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

/** The control tool a final-call forces, as `toToolChoice` names it. */
function finishOf(specs: readonly { readonly name: string; readonly purpose: string }[]) {
  return specs.find((spec) => spec.purpose === 'CONTROL')?.name;
}

/** The table of ExecutorSet 4.5, completed by issue #26 C. */
function classify(error: unknown, progress: RequestProgress, signal: AbortSignal): ExecutorOutcome {
  if (signal.aborted)
    return failure(
      'INTERNAL',
      false,
      progress.started && !progress.failedBeforeSending ? 'UNKNOWN' : 'NOT_SENT',
    );
  const status = APICallError.isInstance(error) ? error.statusCode : undefined;
  if (status !== undefined) {
    if (status === 429) return failure('PROVIDER_RATE_LIMITED', true, 'NOT_SENT');
    if (status === 401 || status === 403) return failure('PROVIDER_AUTH', false, 'NOT_SENT');
    if (status === 408 || status >= 500) return failure('PROVIDER_ERROR', false, 'UNKNOWN');
    if (status >= 400) return failure('INTERNAL', false, 'NOT_SENT');
  }
  if (!progress.started || progress.failedBeforeSending)
    return failure('PROVIDER_UNREACHABLE', true, 'NOT_SENT');
  // Reset connections, broken bodies and unreadable answers: the provider may have processed it.
  return failure('PROVIDER_ERROR', false, 'UNKNOWN');
}

function completedCall(
  result: GenerateResult,
  scope: ModelScope,
  environment: ExecutorEnvironment,
  forced: string | undefined,
): ExecutorOutcome {
  const text = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  const rawCalls = result.content.flatMap((part) =>
    part.type === 'tool-call'
      ? [{ toolCallId: part.toolCallId, toolName: part.toolName, argumentsText: part.input }]
      : [],
  );
  const toolCalls = rawCalls.slice(0, MAX_TOOL_CALLS).map(parseCall);
  const usage = usageOf(result);
  // A final-call forces its control tool, but some providers (DeepSeek) may still answer with
  // another tool, several calls or arguments that are not JSON. That reply is the provider's
  // fault, not a model decision, so it is a retryable failure carrying the usage (4.5).
  const call = toolCalls[0];
  if (
    forced !== undefined &&
    (rawCalls.length !== 1 || call?.toolName !== forced || call.arguments === null)
  )
    return failure('PROVIDER_TOOL_CHOICE_IGNORED', true, 'SENT', usage);
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
      ? { finishReason: 'TOOL_CALLS', toolCalls: toolCalls, hasText: text.length > 0 }
      : {
          finishReason: finishReasonOf(result.finishReason.unified),
          toolCalls: [],
          hasText: text.length > 0,
        };
  return {
    outcome: 'COMPLETED',
    result: { output, artifact: { mediaType: MEDIA_TYPES.modelOutput, text: canonicalJson(raw) } },
    requestState: 'SENT',
    ...(usage === undefined ? {} : { usage }),
  };
}

function parseCall(call: {
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

function finishReasonOf(
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
function usageOf(result: GenerateResult): TokenUsage | undefined {
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
