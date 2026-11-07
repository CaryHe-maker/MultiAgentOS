import { createBraveSearch } from './brave.js';
import { createDeepSeekFetch, createDeepSeekSearch } from './deepseek.js';
import type { AdapterOptions, FetchProvider, SearchProvider } from './providers.js';

/**
 * The providers a configuration can name (`KernelConfig.web.search.provider`,
 * `web.fetch.remote.provider`). The name is also the name the key is looked up under
 * (`<NAME>_API_KEY`). A new provider is one adapter and one line here; a test or another
 * composition passes more through `WebOptions`.
 */
export type SearchAdapter = (options: AdapterOptions) => SearchProvider;
export type FetchAdapter = (options: AdapterOptions) => FetchProvider;

export const SEARCH_ADAPTERS: Readonly<Record<string, SearchAdapter>> = {
  deepseek: createDeepSeekSearch,
  brave: createBraveSearch,
};

export const FETCH_ADAPTERS: Readonly<Record<string, FetchAdapter>> = {
  deepseek: createDeepSeekFetch,
};

/** A configuration that names a provider nobody knows is a mistake to be found at start-up. */
export function adapterOf<T>(
  kind: 'search' | 'fetch',
  name: string,
  adapters: Readonly<Record<string, T>>,
): T {
  const adapter = Object.hasOwn(adapters, name) ? adapters[name] : undefined;
  if (adapter === undefined)
    throw new Error(
      `web.${kind}: no provider named "${name}" (known: ${Object.keys(adapters).join(', ')})`,
    );
  return adapter;
}
