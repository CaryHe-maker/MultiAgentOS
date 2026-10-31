import { Type, type Static } from 'typebox';
import { artifactRefOf } from '../platform-common/common-schemas.js';
import { ToolCallIdSchema } from '../platform-common/ids.js';
import { MEDIA_TYPES } from '../platform-common/media-types.js';
import { closed, text } from '../platform-common/schema-helpers.js';

/**
 * The reply's text exists only in the model output, so the input carries a reference and a
 * `toolCallId` and the session log stays free of bodies (Kernel/Execution 5). RUN_RESULT comes
 * with stage 7.
 */
export const MessagePublishInputSchema = closed(
  {
    kind: Type.Literal('REPLY'),
    agentLabel: text(80),
    source: closed({
      modelOutputRef: artifactRefOf(MEDIA_TYPES.modelOutput),
      toolCallId: ToolCallIdSchema,
    }),
  },
  'kernel.unit.MessagePublishInput.v1',
);
export type MessagePublishInput = Static<typeof MessagePublishInputSchema>;

export const MessagePublishOutputSchema = closed(
  { kind: Type.Enum(['REPLY', 'RUN_RESULT']) },
  'kernel.unit.MessagePublishOutput.v1',
);
export type MessagePublishOutput = Static<typeof MessagePublishOutputSchema>;
