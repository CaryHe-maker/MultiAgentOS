import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { closed, text } from '../platform-common/schema-helpers.js';

/** `repositoryPath` must be absolute; Core checks it (REPOSITORY_INVALID). */
export const CreateRunRequestSchema = closed(
  { requestId: IdSchemas.requestId, goal: text(4000), repositoryPath: text(4096) },
  'kernel.control.CreateRunRequest.v0',
);
export type CreateRunRequest = Static<typeof CreateRunRequestSchema>;

export const AnswerAuthorizationRequestSchema = closed(
  {
    requestId: IdSchemas.requestId,
    workflowRunId: IdSchemas.workflowRunId,
    questionId: IdSchemas.questionId,
    answer: Type.Enum(['YES', 'NO']),
  },
  'kernel.control.AnswerAuthorizationRequest.v0',
);
export type AnswerAuthorizationRequest = Static<typeof AnswerAuthorizationRequestSchema>;

export const CancelRunRequestSchema = closed(
  { requestId: IdSchemas.requestId, workflowRunId: IdSchemas.workflowRunId },
  'kernel.control.CancelRunRequest.v0',
);
export type CancelRunRequest = Static<typeof CancelRunRequestSchema>;

export const ReadArtifactRequestSchema = closed(
  {
    requestId: IdSchemas.requestId,
    workflowRunId: IdSchemas.workflowRunId,
    ref: ArtifactRefSchema,
  },
  'kernel.control.ReadArtifactRequest.v0',
);
export type ReadArtifactRequest = Static<typeof ReadArtifactRequestSchema>;

export const ShutdownRequestSchema = closed(
  { requestId: IdSchemas.requestId },
  'kernel.control.ShutdownRequest.v0',
);
export type ShutdownRequest = Static<typeof ShutdownRequestSchema>;
