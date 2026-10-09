import { Type, type Static } from 'typebox';
import { ToolCallIdSchema } from '../platform-common/ids.js';
import { closed, text } from '../platform-common/schema-helpers.js';

/**
 * `arguments` is one of the two open JSON values of the protocol (M1Interface 1.2): Workflow
 * validates it against the tool's `parametersContract` before use. It is `null` together with
 * `argumentsError` when the provider text could not be parsed.
 */
export const ModelToolCallSchema = closed(
  {
    toolCallId: ToolCallIdSchema,
    toolName: text(128),
    arguments: Type.Unknown(),
    argumentsError: Type.Optional(Type.Literal('INVALID_JSON')),
  },
  'executor.ModelToolCall.v0',
);
export type ModelToolCall = Static<typeof ModelToolCallSchema>;
