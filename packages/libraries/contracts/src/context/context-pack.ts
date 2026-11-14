import { Type, type Static } from 'typebox';
import { ModelToolCallSchema } from '../executor/model-tool-call.js';
import { IdSchemas, ToolCallIdSchema } from '../platform-common/ids.js';
import {
  Sha256Schema,
  TimestampSchema,
  closed,
  count,
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
    /** The tool is the answer to the user (the reply): the console says so while the model writes it. */
    answer: Type.Optional(Type.Boolean()),
  },
  'context.ModelToolSpec.v1',
);
export type ModelToolSpec = Static<typeof ModelToolSpecSchema>;

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
 * only on TOOLS, `toolCalls` only on an assistant HISTORY item and `toolCallId` on every tool
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
const StatusItemSchema = closed({ ...item, segment: Type.Literal('STATUS'), role: user });
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

const hasOrderedItemIds = (value: {
  contextPackId: string;
  items: readonly { itemId: string }[];
}) => value.items.every((entry, index) => entry.itemId === `${value.contextPackId}:${index}`);
const ITEM_ID_ERROR = () => 'itemId must be `${contextPackId}:${index}`';

/** `elidedEntries` are the `seq` values the final-call safeguard removed, and nothing else does. */
export const AssembleContextPackSchema = Type.Refine(
  closed({
    contextPackId: IdSchemas.contextPackId,
    tokenCount: count(),
    tokenBudget: count(1),
    createdAt: TimestampSchema,
    operation: Type.Literal('ASSEMBLE'),
    prefixSha256: Sha256Schema,
    projectionDigest: Sha256Schema,
    headDigest: Sha256Schema,
    elidedEntries: Type.Array(count(1)),
    items: Type.Array(
      Type.Union([InstructionsItemSchema, ToolsItemSchema, StatusItemSchema, HistoryItemSchema]),
    ),
  }),
  hasOrderedItemIds,
  ITEM_ID_ERROR,
);
export type AssembleContextPack = Static<typeof AssembleContextPackSchema>;

/** Immutable once published. */
export const ContextPackSchema = Type.Union([AssembleContextPackSchema], {
  $id: 'context.ContextPack.v1',
});
export type ContextPack = Static<typeof ContextPackSchema>;
