import { WebFailure, type FetchProvider, type FetchedPage } from './providers.js';

/**
 * This program's own fetch first, a provider's when it cannot (ExecutorSet 5d). The own fetch is
 * free, keeps links and code, and sends the address to nobody; a provider is for what it cannot
 * do: a site that turns a program away (403, 429, a challenge page, 5xx), a connection that
 * fails, and a page that builds its content with scripts and so comes out thin.
 *
 * Never to the provider, whatever the status: a request the address checks or the content rules
 * refused (REJECTED), and a page that is not there (404, 410): asking elsewhere is no use and
 * gives the address away for nothing. A 429 of the provider that says it is over within a few
 * seconds is waited out, twice, before the own answer is given.
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

/** The page is not there: nobody else will have it. */
const isGone = (error: WebFailure): boolean => error.status === 404 || error.status === 410;

export function createFallbackFetch(
  own: FetchProvider,
  remote: FetchProvider,
  options: FallbackOptions = {},
): FetchProvider {
  const wait = options.wait ?? sleep;

  async function fromRemote(
    request: { url: string },
    signal: AbortSignal,
  ): Promise<FetchedPage | undefined> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const page = await remote.fetch(request, signal);
        return page.markdown.trim() === '' ? undefined : page;
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof WebFailure)) throw error;
        const delay =
          error.status === 429 && error.detail.kind === 'FAILED'
            ? error.detail.retryAfterMs
            : undefined;
        if (delay === undefined || delay > WAIT_AT_MOST_MS || attempt === ATTEMPTS)
          return undefined;
        await wait(delay, signal);
      }
    }
    return undefined;
  }

  return {
    name: `${own.name}+${remote.name}`,
    fetch: async (request, signal) => {
      let page: FetchedPage;
      try {
        page = await own.fetch(request, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof WebFailure)) throw error;
        if (error.detail.kind === 'REJECTED' || isGone(error)) throw error;
        // What the own fetch said is the account to give when the provider cannot either.
        const viaRemote = await fromRemote(request, signal);
        if (viaRemote !== undefined) return viaRemote;
        throw error;
      }
      if (page.thin !== true) return page;
      const better = await fromRemote(request, signal);
      return better !== undefined && better.markdown.length > page.markdown.length ? better : page;
    },
  };
}
