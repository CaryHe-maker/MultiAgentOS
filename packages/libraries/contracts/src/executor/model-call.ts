import { Type, type Static } from 'typebox';
import { artifactRefOf } from '../platform-common/common-schemas.js';
import { ToolCallIdSchema } from '../platform-common/ids.js';
import { MEDIA_TYPES } from '../platform-common/media-types.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
import { ModelToolCallSchema } from './model-tool-call.js';

/** Cache hits are part of the input tokens, so they can never exceed them. */
export const TokenUsageSchema = Type.Refine(
  closed(
    {
      inputTokens: count(),
      outputTokens: count(),
      inputCacheHitTokens: Type.Optional(count()),
    },
    'executor.TokenUsage.v0',
  ),
  (usage) =>
    usage.inputCacheHitTokens === undefined || usage.inputCacheHitTokens <= usage.inputTokens,
  () => 'inputCacheHitTokens must not exceed inputTokens',
);
export type TokenUsage = Static<typeof TokenUsageSchema>;

/**
 * `contextPackRef` is the artifact of a context-assemble Unit. `final` must equal the `final`
 * of the ContextAssembleInput that produced it; Execution checks that before dispatch.
 */
export const ModelCallInputSchema = closed(
  { contextPackRef: artifactRefOf(MEDIA_TYPES.contextPack), final: Type.Boolean() },
  'executor.ModelCallInput.v0',
);
export type ModelCallInput = Static<typeof ModelCallInputSchema>;

const callOutput = {
  toolCalls: Type.Array(ModelToolCallSchema, { maxItems: 32 }),
  hasText: Type.Boolean(),
};
/** `finishReason` is TOOL_CALLS exactly when the model called at least one tool. */
export const ModelCallOutputSchema = Type.Union(
  [
    closed({
      ...callOutput,
      finishReason: Type.Literal('TOOL_CALLS'),
      toolCalls: Type.Array(ModelToolCallSchema, { minItems: 1, maxItems: 32 }),
    }),
    closed({
      ...callOutput,
      finishReason: Type.Enum(['STOP', 'LENGTH', 'CONTENT_FILTER', 'OTHER']),
      toolCalls: Type.Array(ModelToolCallSchema, { maxItems: 0 }),
    }),
  ],
  { $id: 'executor.ModelCallOutput.v0' },
);
export type ModelCallOutput = Static<typeof ModelCallOutputSchema>;

/** Content of the model-call artifact. */
export const ModelRawOutputSchema = closed(
  {
    provider: text(64),
    apiModelId: text(128),
    providerFinishReason: text(128),
    text: Type.Optional(Type.String()),
    toolCalls: Type.Array(
      closed({ toolCallId: ToolCallIdSchema, toolName: text(128), argumentsText: Type.String() }),
    ),
    usage: Type.Optional(TokenUsageSchema),
    receivedAt: TimestampSchema,
  },
  'executor.ModelRawOutput.v0',
);
export type ModelRawOutput = Static<typeof ModelRawOutputSchema>;
