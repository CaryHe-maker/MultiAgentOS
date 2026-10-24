import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { ExecutionScope } from '@multiagentos/contracts';

/**
 * The provider-level model. ExecutorSet calls `doGenerate` directly instead of `generateText`:
 * it returns tool-call arguments as the provider's raw text (ModelRawOutput keeps them verbatim,
 * and parse failures must reach Workflow as INVALID_JSON), and it never retries, so the request
 * state of every outcome is exactly the state of the one request sent (ExecutorSet 4.5).
 */
export type LanguageModel = ReturnType<ReturnType<typeof createOpenAI>['chat']>;

export type ModelScope = Extract<ExecutionScope, { kind: 'MODEL' }>;

export function createLanguageModel(
  scope: ModelScope,
  apiKey: string,
  fetch: typeof globalThis.fetch,
): LanguageModel {
  if (scope.apiProtocol === 'ANTHROPIC_MESSAGES')
    return createAnthropic({ apiKey, baseURL: scope.baseUrl, fetch })(scope.apiModelId);
  return createOpenAI({ apiKey, baseURL: scope.baseUrl, fetch }).chat(scope.apiModelId);
}
