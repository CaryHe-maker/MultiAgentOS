import { Type, type Static } from 'typebox';
import { ModelToolCallSchema } from '../executor/model-tool-call.js';
import { IdSchemas, ToolCallIdSchema } from '../platform-common/ids.js';
import {
  LINE_RANGE_ERROR,
  Sha256Schema,
  TimestampSchema,
  closed,
  count,
  isLineRange,
  lineRange,
  text,
} from '../platform-common/schema-helpers.js';

/**
 * Built from a Tool definition and the Protocol Registry. `parameters` is the second open JSON
 * value of the protocol (M1Interface 1.2): the JSON Schema of the tool's `parametersContract`.
 */
export const ModelToolSpecSchema = closed(
  {
    name: Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' }),
    description: text(4000),
    parameters: Type.Record(Type.String(), Type.Unknown()),
    purpose: Type.Enum(['UNIT', 'CONTROL']),
  },
  'context.ModelToolSpec.v0',
);
export type ModelToolSpec = Static<typeof ModelToolSpecSchema>;

/** Where a piece of repository content came from. */
export const ProvenanceSchema = Type.Refine(
  closed({
    path: text(1024),
    ...lineRange,
    contentSha256: Sha256Schema,
    snapshotId: Type.Optional(IdSchemas.snapshotId),
    retrieval: Type.Enum(['TREE', 'TEXT', 'PATH', 'SYMBOL', 'FILE_READ']),
  }),
  isLineRange,
  LINE_RANGE_ERROR,
);
export type Provenance = Static<typeof ProvenanceSchema>;

/** ASSEMBLE packs keep this order; SEARCH_HIT appears only in SEARCH packs. */
export const CONTEXT_SEGMENTS = [
  'INSTRUCTIONS',
  'TOOLS',
  'OBJECTIVE',
  'HANDOFF',
  'ORIENT',
  'SEARCH_HIT',
  'HISTORY',
  'STATUS',
] as const;
export type ContextSegment = (typeof CONTEXT_SEGMENTS)[number];

const item = {
  /** `${contextPackId}:${index}`, with the index of the item in `items`. */
  itemId: text(200),
  content: Type.String(),
  contentSha256: Sha256Schema,
  tokenCount: count(),
  reason: text(200),
};
const system = Type.Literal('system');
const user = Type.Literal('user');

/**
 * One variant per segment, which fixes the role and the extra fields together: `toolSpecs`
 * only on TOOLS, `provenance` always on repository content (ORIENT, SEARCH_HIT), `score` only on
 * SEARCH_HIT, `toolCalls` only on an assistant HISTORY item and `toolCallId` on every tool
 * HISTORY item. A field outside its variant makes the item invalid.
 */
const InstructionsItemSchema = closed({
  ...item,
  segment: Type.Literal('INSTRUCTIONS'),
  role: system,
});
const ToolsItemSchema = closed({
  ...item,
  segment: Type.Literal('TOOLS'),
  role: system,
  toolSpecs: Type.Array(ModelToolSpecSchema),
});
const PlainItemSchema = closed({
  ...item,
  segment: Type.Enum(['OBJECTIVE', 'HANDOFF', 'STATUS']),
  role: user,
});
const OrientItemSchema = closed({
  ...item,
  segment: Type.Literal('ORIENT'),
  role: user,
  provenance: ProvenanceSchema,
});
const SearchHitItemSchema = closed({
  ...item,
  segment: Type.Literal('SEARCH_HIT'),
  role: user,
  provenance: ProvenanceSchema,
  score: Type.Number({ minimum: 0, maximum: 1 }),
});
const history = { ...item, segment: Type.Literal('HISTORY') };
const HistoryItemSchema = Type.Union([
  closed({
    ...history,
    role: Type.Literal('assistant'),
    toolCalls: Type.Optional(Type.Array(ModelToolCallSchema, { minItems: 1 })),
  }),
  closed({
    ...history,
    role: Type.Literal('tool'),
    toolCallId: ToolCallIdSchema,
    provenance: Type.Optional(ProvenanceSchema),
  }),
  closed({ ...history, role: user }),
]);

export const ContextItemSchema = Type.Union([
  InstructionsItemSchema,
  ToolsItemSchema,
  PlainItemSchema,
  OrientItemSchema,
  SearchHitItemSchema,
  HistoryItemSchema,
]);
export type ContextItem = Static<typeof ContextItemSchema>;

const pack = {
  contextPackId: IdSchemas.contextPackId,
  tokenCount: count(),
  tokenBudget: count(1),
  truncated: Type.Boolean(),
  droppedCount: count(),
  createdAt: TimestampSchema,
};
const hasOrderedItemIds = (value: {
  contextPackId: string;
  items: readonly { itemId: string }[];
}) => value.items.every((entry, index) => entry.itemId === `${value.contextPackId}:${index}`);
const ITEM_ID_ERROR = () => 'itemId must be `${contextPackId}:${index}`';

/** The artifact of repository-orient: only ORIENT items, always with a snapshotId. */
export const OrientContextPackSchema = Type.Refine(
  closed({
    ...pack,
    operation: Type.Literal('ORIENT'),
    snapshotId: IdSchemas.snapshotId,
    items: Type.Array(OrientItemSchema),
  }),
  hasOrderedItemIds,
  ITEM_ID_ERROR,
);
/** The artifact of repository-search: only SEARCH_HIT items, always with a snapshotId. */
export const SearchContextPackSchema = Type.Refine(
  closed({
    ...pack,
    operation: Type.Literal('SEARCH'),
    snapshotId: IdSchemas.snapshotId,
    items: Type.Array(SearchHitItemSchema),
  }),
  hasOrderedItemIds,
  ITEM_ID_ERROR,
);
/**
 * The artifact of context-assemble and the input of model-call: always with `prefixSha256`,
 * never with SEARCH_HIT items, and with a snapshotId when an orient pack was assembled in.
 */
export const AssembleContextPackSchema = Type.Refine(
  closed({
    ...pack,
    operation: Type.Literal('ASSEMBLE'),
    snapshotId: Type.Optional(IdSchemas.snapshotId),
    prefixSha256: Sha256Schema,
    items: Type.Array(
      Type.Union([
        InstructionsItemSchema,
        ToolsItemSchema,
        PlainItemSchema,
        OrientItemSchema,
        HistoryItemSchema,
      ]),
    ),
  }),
  hasOrderedItemIds,
  ITEM_ID_ERROR,
);
export type OrientContextPack = Static<typeof OrientContextPackSchema>;
export type SearchContextPack = Static<typeof SearchContextPackSchema>;
export type AssembleContextPack = Static<typeof AssembleContextPackSchema>;

/** Immutable once published; segment order and trimming rules are in M1Interface 6.3. */
export const ContextPackSchema = Type.Union(
  [OrientContextPackSchema, SearchContextPackSchema, AssembleContextPackSchema],
  { $id: 'context.ContextPack.v0' },
);
export type ContextPack = Static<typeof ContextPackSchema>;
