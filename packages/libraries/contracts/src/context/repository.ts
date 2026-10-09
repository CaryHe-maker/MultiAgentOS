import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';

export const RepositoryOrientInputSchema = closed(
  { objective: text(4000) },
  'context.RepositoryOrientInput.v0',
);
export type RepositoryOrientInput = Static<typeof RepositoryOrientInputSchema>;

export const RepositoryOrientOutputSchema = closed(
  {
    snapshotId: IdSchemas.snapshotId,
    fileCount: count(),
    totalBytes: count(),
    summary: text(4000, 0),
    tokenCount: count(),
    truncated: Type.Boolean(),
  },
  'context.RepositoryOrientOutput.v0',
);
export type RepositoryOrientOutput = Static<typeof RepositoryOrientOutputSchema>;

export const SEARCH_MODES = ['AUTO', 'TEXT', 'PATH', 'SYMBOL'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** Also the parameters of the `search_repository` tool. Defaults: mode AUTO, maxItems 20. */
export const RepositorySearchInputSchema = closed(
  {
    query: text(500),
    mode: Type.Optional(Type.Enum(SEARCH_MODES)),
    maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  'context.RepositorySearchInput.v0',
);
export type RepositorySearchInput = Static<typeof RepositorySearchInputSchema>;

export const SearchHitSchema = closed({
  path: text(1024),
  startLine: count(1),
  endLine: count(1),
  score: Type.Number({ minimum: 0, maximum: 1 }),
  matchKind: Type.Enum(['TEXT', 'PATH', 'SYMBOL']),
});
export type SearchHit = Static<typeof SearchHitSchema>;

export const RepositorySearchOutputSchema = closed(
  {
    snapshotId: IdSchemas.snapshotId,
    hits: Type.Array(SearchHitSchema, { maxItems: 50 }),
    truncated: Type.Boolean(),
  },
  'context.RepositorySearchOutput.v0',
);
export type RepositorySearchOutput = Static<typeof RepositorySearchOutputSchema>;
