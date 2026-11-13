import { Type, type Static } from 'typebox';
import { artifactRefOf } from '../platform-common/common-schemas.js';
import { ToolCallIdSchema } from '../platform-common/ids.js';
import { MEDIA_TYPES } from '../platform-common/media-types.js';
import { closed, text } from '../platform-common/schema-helpers.js';
import { WrapUpReasonSchema } from '../context/history-entry.js';

/**
 * The reply's text exists only in the model output, so the input carries a reference and a
 * `toolCallId` and the session log stays free of bodies (Kernel/Execution 5). A degraded reply
 * carries only the reason, as structured data; UserInteraction words it. RUN_RESULT comes with
 * the user templates.
 */
export const MessagePublishInputSchema = Type.Union(
  [
    closed({
      kind: Type.Literal('REPLY'),
      agentLabel: text(80),
      source: closed({
        modelOutputRef: artifactRefOf(MEDIA_TYPES.modelOutput),
        toolCallId: ToolCallIdSchema,
      }),
      /** Set when the reply came from a final call: the work ended early and the user is told. */
      wrapUpReason: Type.Optional(WrapUpReasonSchema),
    }),
    closed({
      kind: Type.Literal('DEGRADED_REPLY'),
      agentLabel: text(80),
      reason: text(64),
    }),
  ],
  { $id: 'kernel.unit.MessagePublishInput.v1' },
);
export type MessagePublishInput = Static<typeof MessagePublishInputSchema>;

export const MessagePublishOutputSchema = closed(
  {
    kind: Type.Enum(['REPLY', 'DEGRADED_REPLY', 'RUN_RESULT']),
    wrapUpReason: Type.Optional(WrapUpReasonSchema),
  },
  'kernel.unit.MessagePublishOutput.v1',
);
export type MessagePublishOutput = Static<typeof MessagePublishOutputSchema>;
