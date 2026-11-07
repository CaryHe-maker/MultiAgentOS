import type { ExecutorFailedCode, ExecutorRejectedCode } from '@multiagentos/contracts';

/**
 * The provider ports of the web tools (ExecutorSet 5d). A provider may be replaced; what it may
 * not do is skip the checks that stand in front of it (authorization, address, secrets), and it
 * may not leak into them: everything that belongs to one provider (its query operators, its
 * status codes, its way of asking for a time range) stays in its adapter.
 */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly summary: string;
  readonly snippet?: string;
  readonly date?: string;
  readonly authority?: number;
  readonly rerankScore?: number;
}

/** A search as the tool asks for it; each adapter turns the time range into its own words. */
export interface SearchRequest {
  readonly query: string;
  readonly count: number;
  /** `YYYY` or `YYYY-MM-DD`. */
  readonly after?: string;
  readonly before?: string;
}

export interface SearchProvider {
  readonly name: string;
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchHit[]>;
}

export interface FetchedPage {
  readonly title: string;
  readonly markdown: string;
  /** Who served it: a provider's interface (its name), or this program. */
  readonly via: string;
  readonly finalUrl?: string;
  /** The content was longer than the limit and is cut. */
  readonly truncated?: boolean;
  /** The address answered with a redirect to another host: nothing was fetched from there. */
  readonly redirectTo?: string;
  /** The page is large but has almost no text: most likely it builds its content with scripts. */
  readonly thin?: boolean;
}

export interface FetchProvider {
  readonly name: string;
  fetch(request: { url: string }, signal: AbortSignal): Promise<FetchedPage>;
}

/** How a provider says it could not: the outcome the Executor answers with, and the status behind it. */
export class WebFailure extends Error {
  public constructor(
    public readonly detail:
      | { readonly kind: 'REJECTED'; readonly code: ExecutorRejectedCode }
      | {
          readonly kind: 'FAILED';
          readonly code: ExecutorFailedCode;
          readonly retryable: boolean;
          readonly retryAfterMs?: number;
        },
    /** The HTTP status of the answer, when there was one. */
    public readonly status?: number,
  ) {
    super(`${detail.kind} ${detail.code}`);
    this.name = 'WebFailure';
  }
}

/** `Retry-After` as milliseconds: seconds, or a date. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * What the status of a provider's answer means, for the statuses every HTTP interface shares.
 * An adapter handles the statuses that are its own (a fetch interface's 403 for its security
 * policy, a search interface's 422) before it asks this.
 */
export function failureOfStatus(status: number, retryAfter: number | undefined): WebFailure {
  if (status === 400 || status === 422)
    return new WebFailure({ kind: 'REJECTED', code: 'INVALID_QUERY' }, status);
  if (status === 401 || status === 402 || status === 403)
    return new WebFailure({ kind: 'FAILED', code: 'PROVIDER_AUTH', retryable: false }, status);
  if (status === 404)
    return new WebFailure({ kind: 'FAILED', code: 'PAGE_UNAVAILABLE', retryable: false }, status);
  if (status === 429)
    return new WebFailure(
      {
        kind: 'FAILED',
        code: 'PROVIDER_RATE_LIMITED',
        retryable: true,
        ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
      },
      status,
    );
  if (status === 408 || status === 504)
    return new WebFailure(
      { kind: 'FAILED', code: 'PROVIDER_UNREACHABLE', retryable: true },
      status,
    );
  return new WebFailure(
    { kind: 'FAILED', code: 'PROVIDER_ERROR', retryable: status >= 500 },
    status,
  );
}

export const networkFailure = (): WebFailure =>
  new WebFailure({ kind: 'FAILED', code: 'PROVIDER_UNREACHABLE', retryable: true });

/** What an adapter is built with; the key is looked up under the provider's name. */
export interface AdapterOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => number;
}

/** One HTTP exchange with a provider: its status and body mapped to a failure, or the parsed JSON. */
export async function exchange(
  options: AdapterOptions,
  request: { url: string; init: RequestInit },
  signal: AbortSignal,
  ownStatus: (status: number, retryAfter: number | undefined) => WebFailure | undefined = () =>
    undefined,
): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetch(request.url, { ...request.init, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw networkFailure();
  }
  if (response.status !== 200) {
    const retryAfter = retryAfterMs(
      response.headers.get('retry-after'),
      (options.now ?? Date.now)(),
    );
    throw ownStatus(response.status, retryAfter) ?? failureOfStatus(response.status, retryAfter);
  }
  try {
    return await response.json();
  } catch {
    throw failureOfStatus(500, undefined);
  }
}
