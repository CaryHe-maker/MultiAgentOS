import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { ToolCallIdSchema } from '../platform-common/ids.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
import { ModelToolCallSchema } from './model-tool-call.js';

export const TokenUsageSchema = closed(
  {
    inputTokens: count(),
    outputTokens: count(),
    inputCacheHitTokens: Type.Optional(count()),
  },
  'executor.TokenUsage.v0',
);
export type TokenUsage = Static<typeof TokenUsageSchema>;

/** `final` must equal the `final` of the ContextAssembleInput that produced the pack. */
export const ModelCallInputSchema = closed(
  { contextPackRef: ArtifactRefSchema, final: Type.Boolean() },
  'executor.ModelCallInput.v0',
);
export type ModelCallInput = Static<typeof ModelCallInputSchema>;

export const ModelCallOutputSchema = closed(
  {
    finishReason: Type.Enum(['TOOL_CALLS', 'STOP', 'LENGTH', 'CONTENT_FILTER', 'OTHER']),
    toolCalls: Type.Array(ModelToolCallSchema, { maxItems: 32 }),
    hasText: Type.Boolean(),
  },
  'executor.ModelCallOutput.v0',
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
