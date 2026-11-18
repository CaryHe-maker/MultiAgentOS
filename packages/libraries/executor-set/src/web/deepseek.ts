import {
  WebFailure,
  exchange,
  failureOfStatus,
  type AdapterOptions,
  type FetchProvider,
  type SearchHit,
  type SearchProvider,
} from './providers.js';

/**
 * DeepSeek's search and fetch interface (`POST /v1/tools/search`, `/v1/tools/fetch`, its guide at
 * api-docs.deepseek.com/guides/search; measured in History/M2/Evaluation/Stage6WebProviders). The key is the
 * model provider's and goes only into the header of the request.
 */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const post = (
  options: AdapterOptions,
  tool: 'search' | 'fetch',
  body: unknown,
  signal: AbortSignal,
  ownStatus?: (status: number, retryAfter: number | undefined) => WebFailure | undefined,
) =>
  exchange(
    options,
    {
      url: `${options.baseUrl.replace(/\/$/u, '')}/v1/tools/${tool}`,
      init: {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    },
    signal,
    ownStatus,
  );

/** DeepSeek takes the time range as operators in the query text. */
const withTimeRange = (query: string, after?: string, before?: string): string =>
  `${query}${after === undefined ? '' : ` after:${after}`}${before === undefined ? '' : ` before:${before}`}`;

export function createDeepSeekSearch(options: AdapterOptions): SearchProvider {
  return {
    name: 'deepseek',
    search: async ({ query, count, after, before }, signal) => {
      const answer = (await post(
        options,
        'search',
        { query: withTimeRange(query, after, before), count, need_content: false },
        signal,
      )) as { results?: Record<string, unknown>[] };
      return (answer.results ?? []).flatMap((item): SearchHit[] => {
        const url = text(item['url']);
        if (url === '') return [];
        const date = text(item['date']);
        return [
          {
            title: text(item['title']),
            url,
            summary: text(item['summary']) || text(item['snippet']),
            ...(text(item['snippet']) === '' ? {} : { snippet: text(item['snippet']) }),
            ...(date === '' ? {} : { date }),
            ...(typeof item['authority'] === 'number' ? { authority: item['authority'] } : {}),
            ...(typeof item['rerank_score'] === 'number'
              ? { rerankScore: item['rerank_score'] }
              : {}),
          },
        ];
      });
    },
  };
}

export function createDeepSeekFetch(options: AdapterOptions): FetchProvider {
  return {
    name: 'deepseek',
    fetch: async ({ url }, signal) => {
      const answer = (await post(options, 'fetch', { url }, signal, (status) =>
        // For a fetch, 403 is the other side's security policy, not a bad key (its guide, "Errors").
        status === 403
          ? new WebFailure({ kind: 'REJECTED', code: 'ADDRESS_FORBIDDEN' }, status)
          : status === 404
            ? failureOfStatus(404, undefined)
            : undefined,
      )) as { title?: unknown; content?: unknown };
      return { title: text(answer.title), markdown: text(answer.content), via: 'deepseek' };
    },
  };
}
