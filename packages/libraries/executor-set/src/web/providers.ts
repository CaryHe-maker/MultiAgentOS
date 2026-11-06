import type { ExecutorFailedCode, ExecutorRejectedCode } from '@multiagentos/contracts';

/**
 * The provider ports of the web tools (ExecutorSet 5d). A provider may be replaced; what it may
 * not do is skip the checks that stand in front of it (authorization, address, secrets).
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

export interface SearchProvider {
  readonly name: string;
  search(request: { query: string; count: number }, signal: AbortSignal): Promise<SearchHit[]>;
}

export interface FetchedPage {
  readonly title: string;
  readonly markdown: string;
  /** Who served it: the provider's interface, or this program. */
  readonly via: 'deepseek' | 'local';
  readonly finalUrl?: string;
  /** The content was longer than the limit and is cut. */
  readonly truncated?: boolean;
  /** The address answered with a redirect to another host: nothing was fetched from there. */
  readonly redirectTo?: string;
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

/** What the status of an answer of DeepSeek's interface means (its guide, "Errors"). */
export function failureOfStatus(status: number, retryAfter: number | undefined): WebFailure {
  if (status === 400) return new WebFailure({ kind: 'REJECTED', code: 'INVALID_QUERY' }, status);
  if (status === 403)
    return new WebFailure({ kind: 'REJECTED', code: 'ADDRESS_FORBIDDEN' }, status);
  if (status === 401 || status === 402)
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
