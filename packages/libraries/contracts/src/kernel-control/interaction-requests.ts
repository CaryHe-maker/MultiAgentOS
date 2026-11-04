import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';
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

/**
 * ONCE is the only grant of a critical question, and ends with that attempt. Stage 3 adds the
 * command and prefix answers.
 */
export const AnswerAuthorizationRequestSchema = closed(
  {
    ...inRun,
    questionId: IdSchemas.questionId,
    answer: closed({ scope: Type.Enum(['ALLOW', 'ONCE', 'DENY']) }),
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

/** Only while the run awaits input, otherwise UNDO_NOT_AVAILABLE (Kernel/Core 5a.5). */
export const UndoTurnsRequestSchema = closed(
  { ...inRun, scope: Type.Enum(['LAST', 'ALL']) },
  'kernel.control.UndoTurnsRequest.v1',
);
export type UndoTurnsRequest = Static<typeof UndoTurnsRequestSchema>;

/** The answer to UndoConfirmationRequested, which is not an authorization question. */
export const ConfirmUndoRequestSchema = closed(
  { ...inRun, undoId: IdSchemas.undoId, decision: Type.Enum(['FORCE', 'CANCEL']) },
  'kernel.control.ConfirmUndoRequest.v1',
);
export type ConfirmUndoRequest = Static<typeof ConfirmUndoRequestSchema>;

/** `n` counts back through the Turns not reverted yet; 1 when absent. */
export const DiffTurnsRequestSchema = closed(
  {
    requestId: IdSchemas.requestId,
    sessionId: IdSchemas.sessionId,
    n: Type.Optional(count(1)),
  },
  'kernel.control.DiffTurnsRequest.v1',
);
export type DiffTurnsRequest = Static<typeof DiffTurnsRequestSchema>;

export const FILE_CHANGES = ['ADDED', 'MODIFIED', 'DELETED'] as const;

/** `diffRef` is a unified diff; excluded files are not in it. */
export const TurnDiffSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    turnId: IdSchemas.turnId,
    files: Type.Array(closed({ path: text(4096), change: Type.Enum(FILE_CHANGES) })),
    diffRef: ArtifactRefSchema,
  },
  'kernel.control.TurnDiff.v1',
);
export type TurnDiff = Static<typeof TurnDiffSchema>;
