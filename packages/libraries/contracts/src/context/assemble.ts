import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { Sha256Schema, closed, count, text } from '../platform-common/schema-helpers.js';
import { HandoffBriefSchema } from '../workflow/handoff.js';
import { StatusFactsSchema, StepRecordSchema } from '../workflow/step-record.js';

export const ContextAssembleInputSchema = closed(
  {
    objective: text(4000),
    final: Type.Boolean(),
    handoff: Type.Optional(HandoffBriefSchema),
    orientPackRef: Type.Optional(ArtifactRefSchema),
    steps: Type.Array(StepRecordSchema),
    status: StatusFactsSchema,
  },
  'context.ContextAssembleInput.v0',
);
export type ContextAssembleInput = Static<typeof ContextAssembleInputSchema>;

export const ContextAssembleOutputSchema = closed(
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
);
export type ContextAssembleOutput = Static<typeof ContextAssembleOutputSchema>;
