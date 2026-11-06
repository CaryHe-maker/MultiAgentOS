import {
  failureOfStatus,
  networkFailure,
  retryAfterMs,
  type FetchProvider,
  type SearchHit,
  type SearchProvider,
} from './providers.js';

/**
 * DeepSeek's search and fetch interface (`POST /v1/tools/search`, `/v1/tools/fetch`, its guide at
 * api-docs.deepseek.com/guides/search; measured in Evaluation/Stage6WebProviders). The key is the
 * model provider's and goes only into the header of the request.
 */
export interface DeepSeekOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => number;
}

async function post(
  options: DeepSeekOptions,
  tool: 'search' | 'fetch',
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetch(`${options.baseUrl.replace(/\/$/u, '')}/v1/tools/${tool}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw networkFailure();
  }
  if (response.status !== 200)
    throw failureOfStatus(
      response.status,
      retryAfterMs(response.headers.get('retry-after'), (options.now ?? Date.now)()),
    );
  try {
    return await response.json();
  } catch {
    throw failureOfStatus(500, undefined);
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function createDeepSeekSearch(options: DeepSeekOptions): SearchProvider {
  return {
    name: 'deepseek',
    search: async ({ query, count }, signal) => {
      const answer = (await post(
        options,
        'search',
        { query, count, need_content: false },
        signal,
      )) as {
        results?: Record<string, unknown>[];
      };
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

export function createDeepSeekFetch(options: DeepSeekOptions): FetchProvider {
  return {
    name: 'deepseek',
    fetch: async ({ url }, signal) => {
      const answer = (await post(options, 'fetch', { url }, signal)) as {
        title?: unknown;
        content?: unknown;
      };
      return { title: text(answer.title), markdown: text(answer.content), via: 'deepseek' };
    },
  };
}
