import { Type, type Static } from 'typebox';
import { ToolCallIdSchema } from '../platform-common/ids.js';
import { closed, text } from '../platform-common/schema-helpers.js';

/** Any JSON value except `null`. */
const ParsedArgumentsSchema = Type.Union([
  Type.Record(Type.String(), Type.Unknown()),
  Type.Array(Type.Unknown()),
  Type.String(),
  Type.Number(),
  Type.Boolean(),
]);

const call = { toolCallId: ToolCallIdSchema, toolName: text(128) };
/**
 * `arguments` is one of the two open JSON values of the protocol (M1Interface 1.2): Workflow
 * validates it against the tool's `parametersContract` before use. Exactly one of two shapes:
 * parsed arguments without `argumentsError`, or `arguments: null` with `argumentsError` when
 * the provider text could not be parsed.
 */
export const ModelToolCallSchema = Type.Union(
  [
    closed({ ...call, arguments: ParsedArgumentsSchema }),
    closed({ ...call, arguments: Type.Null(), argumentsError: Type.Literal('INVALID_JSON') }),
  ],
  { $id: 'executor.ModelToolCall.v0' },
);
export type ModelToolCall = Static<typeof ModelToolCallSchema>;
