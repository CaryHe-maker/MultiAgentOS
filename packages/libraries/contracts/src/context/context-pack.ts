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
 * value of the protocol (M1Interface 1.2): the JSON Schema of the tool's `parametersContract`.
 */
export const ModelToolSpecSchema = closed(
  {
    name: text(64),
    description: text(4000),
    parameters: Type.Record(Type.String(), Type.Unknown()),
    purpose: Type.Enum(['UNIT', 'CONTROL']),
  },
  'context.ModelToolSpec.v0',
);
export type ModelToolSpec = Static<typeof ModelToolSpecSchema>;

export const ProvenanceSchema = closed({
  path: text(1024),
  startLine: count(1),
  endLine: count(),
  contentSha256: Sha256Schema,
  snapshotId: Type.Optional(IdSchemas.snapshotId),
  retrieval: Type.Enum(['TREE', 'TEXT', 'PATH', 'SYMBOL', 'FILE_READ']),
});
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

export const ContextItemSchema = closed({
  itemId: text(200),
  segment: Type.Enum(CONTEXT_SEGMENTS),
  role: Type.Enum(['system', 'user', 'assistant', 'tool']),
  content: Type.String(),
  contentSha256: Sha256Schema,
  tokenCount: count(),
  reason: text(200),
  provenance: Type.Optional(ProvenanceSchema),
  toolCallId: Type.Optional(ToolCallIdSchema),
  toolCalls: Type.Optional(Type.Array(ModelToolCallSchema)),
  toolSpecs: Type.Optional(Type.Array(ModelToolSpecSchema)),
  score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
export type ContextItem = Static<typeof ContextItemSchema>;

/** Immutable once published; segment order and trimming rules are in M1Interface 6.3. */
export const ContextPackSchema = closed(
  {
    contextPackId: IdSchemas.contextPackId,
    operation: Type.Enum(['ORIENT', 'SEARCH', 'ASSEMBLE']),
    snapshotId: Type.Optional(IdSchemas.snapshotId),
    tokenCount: count(),
    tokenBudget: count(1),
    truncated: Type.Boolean(),
    droppedCount: count(),
    prefixSha256: Type.Optional(Sha256Schema),
    items: Type.Array(ContextItemSchema),
    createdAt: TimestampSchema,
  },
  'context.ContextPack.v0',
);
export type ContextPack = Static<typeof ContextPackSchema>;
