import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';
import { DefinitionRefSchema } from '../catalog/definition-schemas.js';
import { UserInputSchema } from './session-requests.js';

/**
 * Who asked the system to stop. It goes into the developer-only system record of the Kernel
 * (`shutdown-requests`) and nowhere else: not to Workflow, not to the Session log, not to the user.
 */
export const SHUTDOWN_SOURCES = [
  /** `/exit`. */
  'EXIT_COMMAND',
  /** Ctrl+C twice within the window. */
  'INTERRUPT_TWICE',
  /** `mas run`: the run is over. */
  'RUN_FINISHED',
  /** The console has to end for a reason outside the conversation (an exit code). */
  'EXIT_CODE',
] as const;
export type ShutdownSource = (typeof SHUTDOWN_SOURCES)[number];

export const ShutdownRequestSchema = closed(
  { requestId: IdSchemas.requestId, source: Type.Enum(SHUTDOWN_SOURCES) },
  'kernel.control.ShutdownRequest.v1',
);
export type ShutdownRequest = Static<typeof ShutdownRequestSchema>;

const inRun = {
  requestId: IdSchemas.requestId,
  sessionId: IdSchemas.sessionId,
  workflowRunId: IdSchemas.workflowRunId,
};

/**
 * ONCE is the only grant of a critical question, and ends with that attempt. The sandbox adds the
 * command and prefix answers.
 */
export const AnswerAuthorizationRequestSchema = closed(
  {
    ...inRun,
    questionId: IdSchemas.questionId,
    answer: closed({
      scope: Type.Enum(['ALLOW', 'ONCE', 'COMMAND', 'PREFIX', 'DENY', 'ANY_HOST', 'FOLDER']),
    }),
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

/** Run control (M2Design 4.3-4.5): the requests carry only the run; Kernel never reads a note. */
export const PauseRunRequestSchema = closed(inRun, 'kernel.control.PauseRunRequest.v1');
export type PauseRunRequest = Static<typeof PauseRunRequestSchema>;

export const InterruptRunRequestSchema = closed(inRun, 'kernel.control.InterruptRunRequest.v1');
export type InterruptRunRequest = Static<typeof InterruptRunRequestSchema>;

/** A note added while continuing is business input: it becomes a `steer` (M2Design 4.5). */
export const ResumeRunRequestSchema = closed(
  {
    ...inRun,
    steer: Type.Optional(
      closed({ input: UserInputSchema, targetAgentRunId: Type.Optional(IdSchemas.agentRunId) }),
    ),
  },
  'kernel.control.ResumeRunRequest.v1',
);
export type ResumeRunRequest = Static<typeof ResumeRunRequestSchema>;

/** Only while the run is RUNNING; `targetAgentRunId` is the Turn's main when absent. */
export const SteerRunRequestSchema = closed(
  { ...inRun, input: UserInputSchema, targetAgentRunId: Type.Optional(IdSchemas.agentRunId) },
  'kernel.control.SteerRunRequest.v1',
);
export type SteerRunRequest = Static<typeof SteerRunRequestSchema>;

/** Only while the run awaits input (Kernel/Core 6a); main's projection is what is compacted. */
export const CompactContextRequestSchema = closed(
  { ...inRun },
  'kernel.control.CompactContextRequest.v1',
);
export type CompactContextRequest = Static<typeof CompactContextRequestSchema>;

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
