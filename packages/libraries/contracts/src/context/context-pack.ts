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
 * value of the protocol: the JSON Schema of the tool's `parametersContract`.
 */
export const ModelToolSpecSchema = closed(
  {
    name: Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' }),
    description: text(4000),
    parameters: Type.Record(Type.String(), Type.Unknown()),
    purpose: Type.Enum(['UNIT', 'CONTROL']),
    /** The string argument that is text for the user, shown while the model writes it. */
    liveText: Type.Optional(Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,63}$' })),
  },
  'context.ModelToolSpec.v1',
);
export type ModelToolSpec = Static<typeof ModelToolSpecSchema>;

/** Where a piece of the repository overview came from. */
export const ProvenanceSchema = Type.Refine(
  closed({
    path: text(1024),
    ...lineRange,
    contentSha256: Sha256Schema,
    snapshotId: Type.Optional(IdSchemas.snapshotId),
    retrieval: Type.Literal('TREE'),
  }),
  isLineRange,
  LINE_RANGE_ERROR,
);
export type Provenance = Static<typeof ProvenanceSchema>;

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
 * only on TOOLS, `provenance` always on ORIENT, `toolCalls` only on an assistant HISTORY item and
 * `toolCallId` on every tool HISTORY item. A field outside its variant makes the item invalid.
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
const StatusItemSchema = closed({ ...item, segment: Type.Literal('STATUS'), role: user });
const OrientItemSchema = closed({
  ...item,
  segment: Type.Literal('ORIENT'),
  role: user,
  provenance: ProvenanceSchema,
});
const history = {
  ...item,
  segment: Type.Literal('HISTORY'),
  seq: count(1),
  turnId: Type.Optional(IdSchemas.turnId),
  category: Type.Enum(['PINNED', 'NORMAL']),
};
const HistoryItemSchema = Type.Union([
  closed({
    ...history,
    role: Type.Literal('assistant'),
    toolCalls: Type.Optional(Type.Array(ModelToolCallSchema, { minItems: 1 })),
    /** Replayed per the model's ThinkingFeature; an empty string fills a turn without it. */
    reasoningContent: Type.Optional(Type.String()),
  }),
  closed({ ...history, role: Type.Literal('tool'), toolCallId: ToolCallIdSchema }),
  closed({ ...history, role: user }),
]);

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
export type OrientContextPack = Static<typeof OrientContextPackSchema>;

/** `elidedEntries` are the `seq` values the final-call safeguard removed, and nothing else does. */
export const AssembleContextPackSchema = Type.Refine(
  closed({
    contextPackId: IdSchemas.contextPackId,
    tokenCount: count(),
    tokenBudget: count(1),
    createdAt: TimestampSchema,
    operation: Type.Literal('ASSEMBLE'),
    snapshotId: Type.Optional(IdSchemas.snapshotId),
    prefixSha256: Sha256Schema,
    projectionDigest: Sha256Schema,
    headDigest: Sha256Schema,
    elidedEntries: Type.Array(count(1)),
    items: Type.Array(
      Type.Union([
        InstructionsItemSchema,
        ToolsItemSchema,
        StatusItemSchema,
        OrientItemSchema,
        HistoryItemSchema,
      ]),
    ),
  }),
  hasOrderedItemIds,
  ITEM_ID_ERROR,
);
export type AssembleContextPack = Static<typeof AssembleContextPackSchema>;

/** Immutable once published. */
export const ContextPackSchema = Type.Union([OrientContextPackSchema, AssembleContextPackSchema], {
  $id: 'context.ContextPack.v1',
});
export type ContextPack = Static<typeof ContextPackSchema>;
