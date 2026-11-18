import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import {
  LINE_RANGE_ERROR,
  closed,
  isLineRange,
  lineRange,
  text,
} from '../platform-common/schema-helpers.js';

export const SEARCH_MODES = ['AUTO', 'TEXT', 'PATH', 'SYMBOL'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** Also the parameters of the `search_repository` tool. Defaults: mode AUTO, maxItems 20. */
export const RepositorySearchInputSchema = closed(
  {
    query: text(500),
    mode: Type.Optional(Type.Enum(SEARCH_MODES)),
    maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    /** Only below this directory: relative to the repository root, or absolute for external reads. */
    path: Type.Optional(text(1024)),
  },
  'context.RepositorySearchInput.v1',
);
export type RepositorySearchInput = Static<typeof RepositorySearchInputSchema>;

export const SearchHitSchema = Type.Refine(
  closed({
    path: text(1024),
    ...lineRange,
    score: Type.Number({ minimum: 0, maximum: 1 }),
    matchKind: Type.Enum(['TEXT', 'PATH', 'SYMBOL']),
  }),
  isLineRange,
  LINE_RANGE_ERROR,
);
export type SearchHit = Static<typeof SearchHitSchema>;

export const RepositorySearchOutputSchema = closed(
  {
    snapshotId: IdSchemas.snapshotId,
    hits: Type.Array(SearchHitSchema, { maxItems: 50 }),
    truncated: Type.Boolean(),
  },
  'context.RepositorySearchOutput.v1',
);
export type RepositorySearchOutput = Static<typeof RepositorySearchOutputSchema>;
