import { Type, type Static } from 'typebox';
import { BudgetViewSchema } from '../kernel-unit/budget-state.js';
import { ArtifactRefSchema, artifactRefOf } from '../platform-common/common-schemas.js';
import { IdSchemas, ToolCallIdSchema } from '../platform-common/ids.js';
import { MEDIA_TYPES } from '../platform-common/media-types.js';
import { ReasonCodeV1Schema } from '../platform-common/reason-code.js';
import { Sha256Schema, closed, count, text } from '../platform-common/schema-helpers.js';

const entry = {
  /** `seq` of the log record the entry comes from. */
  seq: count(1),
  turnId: Type.Optional(IdSchemas.turnId),
  category: Type.Enum(['PINNED', 'NORMAL']),
};

/**
 * One line of a projection (Module/Workflow 8.3). Bodies stay in artifacts, so the same log
 * prefix always gives the same entries. A tool result only ever names its preview: `fullRef`
 * reaches the model through `read_output` alone.
 */
export const ContextHistoryEntrySchema = Type.Union(
  [
    closed({ ...entry, kind: Type.Literal('HUMAN'), contentRef: ArtifactRefSchema }),
    closed({
      ...entry,
      kind: Type.Literal('MODEL_TURN'),
      modelId: text(64),
      outputRef: artifactRefOf(MEDIA_TYPES.modelOutput),
      reasoningRef: Type.Optional(ArtifactRefSchema),
      replayable: Type.Boolean(),
    }),
    closed({
      ...entry,
      kind: Type.Literal('TOOL_RESULT'),
      toolCallId: ToolCallIdSchema,
      toolName: text(64),
      status: Type.Enum(['OK', 'REJECTED', 'FAILED', 'INTERRUPTED']),
      outputRef: Type.Optional(ArtifactRefSchema),
      reasonCode: Type.Optional(ReasonCodeV1Schema),
    }),
    /** A predecessor's handoff, by the tool call that holds it; PINNED in the target's view. */
    closed({
      ...entry,
      kind: Type.Literal('HANDOFF'),
      outputRef: artifactRefOf(MEDIA_TYPES.modelOutput),
      toolCallId: ToolCallIdSchema,
    }),
    /** Answers a tool call that did not run, or corrects a reply without one. */
    closed({
      ...entry,
      kind: Type.Literal('FEEDBACK'),
      text: text(1000),
      toolCallId: Type.Optional(ToolCallIdSchema),
    }),
    /** `AGENTS.md`, appended when the run first reads the repository (M2Design 9.5). */
    closed({
      ...entry,
      kind: Type.Literal('PROJECT_INSTRUCTIONS'),
      path: text(512),
      ref: ArtifactRefSchema,
      trusted: Type.Boolean(),
    }),
    /** Runtime context, interruption and repair records: generated text, no artifact. */
    closed({ ...entry, kind: Type.Literal('NOTE'), text: text(2000) }),
  ],
  { $id: 'context.ContextHistoryEntry.v1' },
);
export type ContextHistoryEntry = Static<typeof ContextHistoryEntrySchema>;

/** Why the next model call is the final call; a quota names the limit it reached. */
export const WRAP_UP_REASONS_V1 = [
  'BUDGET_WRAP_UP',
  'TOOL_UNIT_LIMIT',
  'WALL_CLOCK_LIMIT',
  'REPEATED_INTENT',
  'CONSECUTIVE_ERRORS',
  'CONTEXT_LIMIT',
  'NO_PROGRESS',
  'ROUND_LIMIT',
  'REGENERATION_LIMIT',
] as const;

export const StatusFactsV1Schema = closed({
  round: count(1),
  maxRounds: count(1),
  budget: BudgetViewSchema,
  final: Type.Boolean(),
  wrapUpReason: Type.Optional(Type.Enum(WRAP_UP_REASONS_V1)),
});
export type StatusFactsV1 = Static<typeof StatusFactsV1Schema>;

/** `final` here and `status.final` say the same thing and must be equal. */
export const ContextAssembleInputV1Schema = Type.Refine(
  closed(
    {
      final: Type.Boolean(),
      orientPackRef: Type.Optional(artifactRefOf(MEDIA_TYPES.contextPack)),
      history: Type.Array(ContextHistoryEntrySchema),
      status: StatusFactsV1Schema,
    },
    'context.ContextAssembleInput.v1',
  ),
  (input) => input.final === input.status.final,
  () => 'final must equal status.final',
);
export type ContextAssembleInputV1 = Static<typeof ContextAssembleInputV1Schema>;

/** Nothing is dropped per call; only the final-call safeguard elides entries (ExecutorSet 6.2). */
export const ContextAssembleOutputV1Schema = Type.Refine(
  closed(
    {
      contextPackId: IdSchemas.contextPackId,
      tokenCount: count(),
      tokenBudget: count(1),
      prefixSha256: Sha256Schema,
      projectionDigest: Sha256Schema,
      headDigest: Sha256Schema,
      elidedEntries: Type.Array(count(1)),
    },
    'context.ContextAssembleOutput.v1',
  ),
  (output) => output.tokenCount <= output.tokenBudget,
  () => 'tokenCount must not exceed tokenBudget',
);
export type ContextAssembleOutputV1 = Static<typeof ContextAssembleOutputV1Schema>;
