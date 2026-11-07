import { Type, type Static } from 'typebox';
import { closed, count, text } from '../platform-common/schema-helpers.js';

/**
 * The two web tools (M2Design 8.1, ExecutorSet 5d). The model's parameters and the Unit's input are
 * the same: nothing is added by Workflow, and the provider is the Executor's own business.
 */
const DateSchema = Type.String({ pattern: '^\\d{4}(-\\d{2}-\\d{2})?$' });

export const WebSearchInputSchema = closed(
  {
    /** Each is searched on its own; a query is at most 128 characters, with its time operators. */
    queries: Type.Array(text(128), { minItems: 1, maxItems: 5 }),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    timeRange: Type.Optional(
      closed({ after: Type.Optional(DateSchema), before: Type.Optional(DateSchema) }),
    ),
  },
  'executor.WebSearchInput.v1',
);
export type WebSearchInput = Static<typeof WebSearchInputSchema>;

export const WebSearchOutputSchema = closed(
  { queries: count(), results: count(), provider: text(32) },
  'executor.WebSearchOutput.v1',
);
export type WebSearchOutput = Static<typeof WebSearchOutputSchema>;

export const WEB_FETCH_URL_CHARS = 2048;

export const WebFetchInputSchema = closed(
  { url: text(WEB_FETCH_URL_CHARS) },
  'executor.WebFetchInput.v1',
);
export type WebFetchInput = Static<typeof WebFetchInputSchema>;

export const WebFetchOutputSchema = closed(
  {
    url: text(WEB_FETCH_URL_CHARS),
    /** Who served the page: `local` (this program's own fetch) or the name of a provider. */
    via: text(32),
    bytes: count(),
    /** The page was longer than `maxContentBytes` and was cut. */
    truncated: Type.Boolean(),
    title: Type.Optional(text(500, 0)),
  },
  'executor.WebFetchOutput.v1',
);
export type WebFetchOutput = Static<typeof WebFetchOutputSchema>;
