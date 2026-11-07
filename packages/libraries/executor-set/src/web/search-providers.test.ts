import { describe, expect, it } from 'vitest';
import { environmentFor } from '../test-support/environments.js';
import { createBraveSearch } from './brave.js';
import { createDeepSeekSearch } from './deepseek.js';
import { WebFailure, type AdapterOptions, type SearchProvider } from './providers.js';
import { DEFAULT_WEB_CONFIG, createWebSearchExecutor, type WebConfig } from './web-executors.js';

/**
 * What every search adapter must do, whoever the provider is: the same checks run on each. A new
 * provider is one more entry here, and the tool above it does not change.
 */
interface Case {
  readonly name: string;
  readonly create: (options: AdapterOptions) => SearchProvider;
  /** The provider's own answer with these two results, the second without an address. */
  readonly answer: () => unknown;
  /** Where the key goes, and how the time range is asked for, are the adapter's own. */
  readonly keyOf: (request: { url: string; init: RequestInit }) => string | null;
  readonly timeRangeOf: (request: { url: string; init: RequestInit }) => string;
}

const text = (init: RequestInit): string => (typeof init.body === 'string' ? init.body : '');

const CASES: readonly Case[] = [
  {
    name: 'deepseek',
    create: createDeepSeekSearch,
    answer: () => ({
      results: [
        { title: 'One', url: 'https://one.example/', summary: 'first', date: '2026-01-02' },
        { title: 'No address', summary: 'lost' },
        { title: 'Two', url: 'https://two.example/', snippet: 'second', rerank_score: 1.5 },
      ],
      extra: 'ignored',
    }),
    keyOf: ({ init }) =>
      new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? null,
    timeRangeOf: ({ init }) => (JSON.parse(text(init)) as { query: string }).query,
  },
  {
    name: 'brave',
    create: createBraveSearch,
    answer: () => ({
      web: {
        results: [
          {
            title: 'One',
            url: 'https://one.example/',
            description: 'first',
            page_age: '2026-01-02',
          },
          { title: 'No address', description: 'lost' },
          { title: 'Two', url: 'https://two.example/', description: 'second <strong>hit</strong>' },
        ],
      },
      extra: 'ignored',
    }),
    keyOf: ({ init }) => new Headers(init.headers).get('x-subscription-token'),
    timeRangeOf: ({ url }) => new URL(url).searchParams.get('freshness') ?? '',
  },
];

interface Exchange {
  readonly url: string;
  readonly init: RequestInit;
}

function answering(respond: () => Response | Promise<Response>) {
  const seen: Exchange[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, init: init ?? {} });
    return Promise.resolve(respond());
  };
  return { fetch, seen };
}

const signal = new AbortController().signal;

describe.each(CASES)('search provider contract: $name', (provider) => {
  const build = (respond: () => Response | Promise<Response>) => {
    const net = answering(respond);
    return {
      net,
      adapter: provider.create({
        baseUrl: 'https://api.example',
        apiKey: 'key-123',
        fetch: net.fetch,
      }),
    };
  };
  const ask = (respond: () => Response | Promise<Response>) =>
    build(respond).adapter.search({ query: 'widgets', count: 5 }, signal);

  it('names itself', () => {
    expect(build(() => Response.json({})).adapter.name).toBe(provider.name);
  });

  it('turns the answer into hits, drops the one with no address and ignores the rest', async () => {
    const hits = await ask(() => Response.json(provider.answer()));
    expect(hits.map((hit) => hit.url)).toEqual(['https://one.example/', 'https://two.example/']);
    expect(hits[0]).toMatchObject({ title: 'One', summary: 'first', date: '2026-01-02' });
    expect(hits[1]?.summary).toContain('second');
    expect(hits[1]?.summary).not.toContain('<');
  });

  it('sends the key, and only in the place the provider takes it', async () => {
    const { net, adapter } = build(() => Response.json(provider.answer()));
    await adapter.search({ query: 'widgets', count: 5 }, signal);
    const [request] = net.seen;
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(provider.keyOf(request)).toBe('key-123');
    expect(request.url).not.toContain('key-123');
  });

  it('asks for the time range in its own words', async () => {
    const { net, adapter } = build(() => Response.json(provider.answer()));
    await adapter.search(
      { query: 'widgets', count: 5, after: '2026-01-01', before: '2026-03-31' },
      signal,
    );
    const [request] = net.seen;
    if (request === undefined) throw new Error('no request');
    expect(provider.timeRangeOf(request)).toContain('2026-01-01');
    expect(provider.timeRangeOf(request)).toContain('2026-03-31');
    const plain = build(() => Response.json(provider.answer()));
    await plain.adapter.search({ query: 'widgets', count: 5 }, signal);
    const [first] = plain.net.seen;
    if (first === undefined) throw new Error('no request');
    expect(provider.timeRangeOf(first)).not.toContain('2026');
  });

  it('gives an empty list for an answer with nothing in it', async () => {
    expect(await ask(() => Response.json({}))).toEqual([]);
  });

  it.each([
    [400, 'REJECTED', 'INVALID_QUERY', undefined],
    [401, 'FAILED', 'PROVIDER_AUTH', false],
    [402, 'FAILED', 'PROVIDER_AUTH', false],
    [403, 'FAILED', 'PROVIDER_AUTH', false],
    [422, 'REJECTED', 'INVALID_QUERY', undefined],
    [429, 'FAILED', 'PROVIDER_RATE_LIMITED', true],
    [500, 'FAILED', 'PROVIDER_ERROR', true],
    [504, 'FAILED', 'PROVIDER_UNREACHABLE', true],
  ] as const)('says what a %i means', async (status, kind, code, retryable) => {
    const error = await ask(() => Response.json({}, { status })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebFailure);
    const { detail } = error as WebFailure;
    expect(detail).toMatchObject({ kind, code });
    if (retryable !== undefined) expect(detail).toMatchObject({ retryable });
  });

  it('carries Retry-After of a 429', async () => {
    const error = await ask(() =>
      Response.json({}, { status: 429, headers: { 'retry-after': '7' } }),
    ).catch((caught: unknown) => caught);
    expect((error as WebFailure).detail).toMatchObject({ retryAfterMs: 7_000 });
  });

  it('answers a broken body and a lost connection as failures, not as crashes', async () => {
    const broken = await ask(() => new Response('not json', { status: 200 })).catch(
      (caught: unknown) => caught,
    );
    expect((broken as WebFailure).detail).toMatchObject({ kind: 'FAILED', code: 'PROVIDER_ERROR' });
    const net = answering(() => Response.json({}));
    const lost = await provider
      .create({
        baseUrl: 'https://api.example',
        apiKey: 'k',
        fetch: () => Promise.reject(new TypeError('fetch failed')),
      })
      .search({ query: 'q', count: 1 }, signal)
      .catch((caught: unknown) => caught);
    expect((lost as WebFailure).detail).toMatchObject({
      code: 'PROVIDER_UNREACHABLE',
      retryable: true,
    });
    expect(net.seen).toHaveLength(0);
  });

  it('lets an abort through as an abort', async () => {
    const aborted = AbortSignal.abort();
    const adapter = provider.create({
      baseUrl: 'https://api.example',
      apiKey: 'k',
      fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    });
    const error = await adapter
      .search({ query: 'q', count: 1 }, aborted)
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(WebFailure);
  });
});

describe('swapping the search provider', () => {
  const brave: WebConfig = {
    ...DEFAULT_WEB_CONFIG,
    search: { provider: 'brave', baseUrl: 'https://api.search.brave.com' },
  };

  it('is a change of configuration: the key is looked up under the provider name', async () => {
    const calls: string[] = [];
    const executor = createWebSearchExecutor({
      config: brave,
      fetch: (input) => {
        calls.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(
          Response.json({
            web: { results: [{ title: 'Hit', url: 'https://hit.example/', description: 'found' }] },
          }),
        );
      },
    });
    const keys: string[] = [];
    const outcome = await executor.execute(
      { queries: ['widgets'] },
      environmentFor(
        'WEB_SEARCH',
        { kind: 'NONE' },
        {
          credentials: {
            apiKeyFor: (name) => {
              keys.push(name);
              return name === 'brave' ? 'brave-key' : undefined;
            },
          },
        },
      ),
    );
    expect(outcome).toMatchObject({
      outcome: 'COMPLETED',
      result: { output: { provider: 'brave', results: 1 } },
    });
    expect(keys).toEqual(['brave']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('api.search.brave.com/res/v1/web/search');
    expect(calls[0]).not.toContain('deepseek');
  });

  it('fails as an authentication problem when that provider has no key', async () => {
    const executor = createWebSearchExecutor({ config: brave });
    // The default test environment has a key for deepseek only.
    const outcome = await executor.execute(
      { queries: ['widgets'] },
      environmentFor('WEB_SEARCH', { kind: 'NONE' }),
    );
    expect(outcome).toMatchObject({ outcome: 'FAILED', reasonCode: 'PROVIDER_AUTH' });
  });

  it('takes an adapter that a composition brings along', async () => {
    const executor = createWebSearchExecutor({
      config: {
        ...DEFAULT_WEB_CONFIG,
        search: { provider: 'mine', baseUrl: 'https://mine.example' },
      },
      searchAdapters: {
        mine: () => ({
          name: 'mine',
          search: () =>
            Promise.resolve([{ title: 'Mine', url: 'https://m.example/', summary: 's' }]),
        }),
      },
    });
    const outcome = await executor.execute(
      { queries: ['q'] },
      environmentFor(
        'WEB_SEARCH',
        { kind: 'NONE' },
        {
          credentials: { apiKeyFor: () => 'any' },
        },
      ),
    );
    expect(outcome).toMatchObject({ result: { output: { provider: 'mine' } } });
  });
});
