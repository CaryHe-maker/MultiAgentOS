import { WebFailure, type FetchProvider, type FetchedPage } from './providers.js';

/**
 * DeepSeek's fetch first, this program's own when it fails (ExecutorSet 5d). Not on 400, which
 * says the request itself is wrong, and not on 403, which is the other side's security policy:
 * neither may be got round by asking again elsewhere. A 429 that says it is over within a few
 * seconds is waited out, twice, before the fall back.
 */
const WAIT_AT_MOST_MS = 10_000;
const ATTEMPTS = 3;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface FallbackOptions {
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function createFallbackFetch(
  primary: FetchProvider,
  fallback: FetchProvider,
  options: FallbackOptions = {},
): FetchProvider {
  const wait = options.wait ?? sleep;
  return {
    name: `${primary.name}+${fallback.name}`,
    fetch: async (request, signal) => {
      let failure: unknown;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        try {
          const page: FetchedPage = await primary.fetch(request, signal);
          if (page.markdown.trim() !== '') return page;
          failure = new WebFailure({ kind: 'FAILED', code: 'PAGE_UNAVAILABLE', retryable: false });
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          if (!(error instanceof WebFailure)) throw error;
          if (error.status === 400 || error.status === 403) throw error;
          failure = error;
          const again =
            error.status === 429 &&
            error.detail.kind === 'FAILED' &&
            error.detail.retryAfterMs !== undefined &&
            error.detail.retryAfterMs <= WAIT_AT_MOST_MS &&
            attempt < ATTEMPTS;
          if (!again) break;
          await wait(error.detail.kind === 'FAILED' ? (error.detail.retryAfterMs ?? 0) : 0, signal);
        }
      }
      try {
        return await fallback.fetch(request, signal);
      } catch (error) {
        // When the fall back could not either, what the first one said is the better account.
        if (signal.aborted) throw error;
        if (error instanceof WebFailure && error.detail.kind === 'REJECTED') throw error;
        throw failure instanceof WebFailure ? failure : error;
      }
    },
  };
}
