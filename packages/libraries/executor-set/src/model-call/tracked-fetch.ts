import type { ModelScope } from './language-model.js';

/**
 * Where the one HTTP request of a model call got to. ExecutorSet 4.5 needs this to tell
 * NOT_SENT (the provider cannot have processed the request) from UNKNOWN.
 */
export interface RequestProgress {
  /** fetch was entered. */
  started: boolean;
  /** fetch failed while connecting, before any byte of the request could reach the provider. */
  failedBeforeSending: boolean;
  /** The response status line arrived. */
  responded: boolean;
}

/**
 * Error codes that Node's fetch (undici) raises before the request is written: name
 * resolution, connection and TLS handshake failures.
 */
const BEFORE_SENDING = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function failedBeforeSending(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; typeof current === 'object' && current !== null && depth < 5; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && (BEFORE_SENDING.has(code) || code.startsWith('ERR_SSL_')))
      return true;
    current = cause;
  }
  return false;
}

/**
 * Wraps the fetch handed to the provider SDK. It records how far the request got and, for
 * DeepSeek's OpenAI-compatible API, writes the thinking switch into the body, which the OpenAI
 * adapter has no option for (M0 sent the same field: `thinking: { type: 'disabled' }`).
 */
export function trackedFetch(
  inner: typeof globalThis.fetch,
  scope: ModelScope,
  progress: RequestProgress,
): typeof globalThis.fetch {
  return async (input, init) => {
    progress.started = true;
    let request = init;
    if (scope.provider === 'deepseek' && typeof init?.body === 'string') {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      parsed['thinking'] = { type: scope.thinking === 'ENABLED' ? 'enabled' : 'disabled' };
      if (scope.thinking === 'ENABLED' && scope.thinkingEffort !== undefined)
        parsed['reasoning_effort'] = scope.thinkingEffort;
      request = { ...init, body: JSON.stringify(parsed) };
    }
    try {
      const response = await inner(input, request);
      progress.responded = true;
      return response;
    } catch (error) {
      progress.failedBeforeSending = failedBeforeSending(error);
      throw error;
    }
  };
}
