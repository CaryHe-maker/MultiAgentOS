import { exchange, type AdapterOptions, type SearchHit, type SearchProvider } from './providers.js';

/**
 * Brave Search (`GET /res/v1/web/search`, api-dashboard.search.brave.com/documentation). The key
 * is looked up under the name `brave` (`BRAVE_API_KEY`). It exists to show that the search tool
 * does not depend on one provider; nothing else of the system knows that it is there.
 */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Brave marks the matched words in its descriptions. */
const plain = (value: string): string =>
  value
    .replace(/<[^>]*>/gu, '')
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;|&#39;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>');

const MAX_COUNT = 20;

/** Brave takes a range of dates as `freshness=YYYY-MM-DDtoYYYY-MM-DD`. */
function freshness(after?: string, before?: string): string | undefined {
  if (after === undefined && before === undefined) return undefined;
  const first = after === undefined ? '1970-01-01' : after.length === 4 ? `${after}-01-01` : after;
  const last =
    before === undefined
      ? new Date().toISOString().slice(0, 10)
      : before.length === 4
        ? `${before}-12-31`
        : before;
  return `${first}to${last}`;
}

export function createBraveSearch(options: AdapterOptions): SearchProvider {
  return {
    name: 'brave',
    search: async ({ query, count, after, before }, signal) => {
      const url = new URL(`${options.baseUrl.replace(/\/$/u, '')}/res/v1/web/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(Math.min(count, MAX_COUNT)));
      const range = freshness(after, before);
      if (range !== undefined) url.searchParams.set('freshness', range);
      const answer = (await exchange(
        options,
        {
          url: url.href,
          init: {
            method: 'GET',
            headers: { accept: 'application/json', 'x-subscription-token': options.apiKey },
          },
        },
        signal,
      )) as { web?: { results?: Record<string, unknown>[] } };
      return (answer.web?.results ?? []).flatMap((item): SearchHit[] => {
        const link = text(item['url']);
        if (link === '') return [];
        const date = text(item['page_age']) || text(item['age']);
        return [
          {
            title: plain(text(item['title'])),
            url: link,
            summary: plain(text(item['description'])),
            ...(date === '' ? {} : { date }),
          },
        ];
      });
    },
  };
}
