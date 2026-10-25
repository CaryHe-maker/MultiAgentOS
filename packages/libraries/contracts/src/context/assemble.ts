import { Type, type Static } from 'typebox';
import { artifactRefOf } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { MEDIA_TYPES } from '../platform-common/media-types.js';
import { Sha256Schema, closed, count, text } from '../platform-common/schema-helpers.js';
import { HandoffBriefSchema } from '../workflow/handoff.js';
import { StatusFactsSchema, StepRecordSchema } from '../workflow/step-record.js';

/** `final` here and `status.final` say the same thing and must be equal. */
export const ContextAssembleInputSchema = Type.Refine(
  closed(
    {
      objective: text(4000),
      final: Type.Boolean(),
      handoff: Type.Optional(HandoffBriefSchema),
      /** The artifact of a repository-orient Unit. */
      orientPackRef: Type.Optional(artifactRefOf(MEDIA_TYPES.contextPack)),
      steps: Type.Array(StepRecordSchema),
      status: StatusFactsSchema,
    },
    'context.ContextAssembleInput.v0',
  ),
  (input) => input.final === input.status.final,
  () => 'final must equal status.final',
);
export type ContextAssembleInput = Static<typeof ContextAssembleInputSchema>;

/** `tokenCount` never exceeds `tokenBudget`: trimming always succeeds (M1Interface 6.3). */
export const ContextAssembleOutputSchema = Type.Refine(
  closed(
    {
      contextPackId: IdSchemas.contextPackId,
      tokenCount: count(),
      tokenBudget: count(1),
      truncated: Type.Boolean(),
      droppedCount: count(),
      prefixSha256: Sha256Schema,
      elidedRequestIds: Type.Array(IdSchemas.requestId),
    },
    'context.ContextAssembleOutput.v0',
  ),
  (output) => output.tokenCount <= output.tokenBudget,
  () => 'tokenCount must not exceed tokenBudget',
);
export type ContextAssembleOutput = Static<typeof ContextAssembleOutputSchema>;
