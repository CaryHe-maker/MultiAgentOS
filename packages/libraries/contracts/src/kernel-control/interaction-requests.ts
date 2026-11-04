import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { closed } from '../platform-common/schema-helpers.js';
import { DefinitionRefSchema } from '../catalog/definition-schemas.js';
import { UserInputSchema } from './session-requests.js';

export const ShutdownRequestSchema = closed(
  { requestId: IdSchemas.requestId },
  'kernel.control.ShutdownRequest.v1',
);
export type ShutdownRequest = Static<typeof ShutdownRequestSchema>;

const inRun = {
  requestId: IdSchemas.requestId,
  sessionId: IdSchemas.sessionId,
  workflowRunId: IdSchemas.workflowRunId,
};

/** Stage 2 adds the single-use answer, stage 3 the command and prefix answers. */
export const AnswerAuthorizationRequestSchema = closed(
  {
    ...inRun,
    questionId: IdSchemas.questionId,
    answer: closed({ scope: Type.Enum(['ALLOW', 'DENY']) }),
  },
  'kernel.control.AnswerAuthorizationRequest.v1',
);
export type AnswerAuthorizationRequest = Static<typeof AnswerAuthorizationRequestSchema>;

export const AnswerHumanRequestSchema = closed(
  {
    ...inRun,
    humanRequestId: IdSchemas.humanRequestId,
    input: UserInputSchema,
    template: Type.Optional(DefinitionRefSchema),
  },
  'kernel.control.AnswerHumanRequest.v1',
);
export type AnswerHumanRequest = Static<typeof AnswerHumanRequestSchema>;

/** Artifacts belong to the Session in M2, so the run is no longer part of the request. */
export const ReadArtifactRequestSchema = closed(
  { requestId: IdSchemas.requestId, sessionId: IdSchemas.sessionId, ref: ArtifactRefSchema },
  'kernel.control.ReadArtifactRequest.v1',
);
export type ReadArtifactRequest = Static<typeof ReadArtifactRequestSchema>;
