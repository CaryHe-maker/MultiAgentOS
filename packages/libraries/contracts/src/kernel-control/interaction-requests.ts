import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
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

/** Only while the run is RUNNING; `targetAgentRunId` is main when absent. */
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

/**
 * `/undo`: back before the latest checkpoint, or the first (`ALL`), taking it back too. Only while
 * the run awaits input, otherwise UNDO_NOT_AVAILABLE (Kernel/Core 5a.5, Orchestration 7.5).
 */
export const UndoRequestSchema = closed(
  { ...inRun, scope: Type.Enum(['LAST', 'ALL']) },
  'kernel.control.UndoRequest.v1',
);
export type UndoRequest = Static<typeof UndoRequestSchema>;

/**
 * Goes back to a checkpoint inside the run (Orchestration 7.5): only while the run is paused. The
 * files return to the checkpoint's snapshot, and the work after its cut is taken back.
 */
export const RewindCheckpointRequestSchema = closed(
  { ...inRun, checkpoint: count(1) },
  'kernel.control.RewindCheckpointRequest.v1',
);
export type RewindCheckpointRequest = Static<typeof RewindCheckpointRequestSchema>;

/** The answer to UndoConfirmationRequested, which is not an authorization question. */
export const ConfirmUndoRequestSchema = closed(
  { ...inRun, undoId: IdSchemas.undoId, decision: Type.Enum(['FORCE', 'CANCEL']) },
  'kernel.control.ConfirmUndoRequest.v1',
);
export type ConfirmUndoRequest = Static<typeof ConfirmUndoRequestSchema>;

/**
 * What a checkpoint's stretch changed (Orchestration 7.5): the `checkpoint`-th of `listCheckpoints`,
 * or the `n`-th latest (1 when both are absent).
 */
export const DiffRequestSchema = closed(
  {
    requestId: IdSchemas.requestId,
    sessionId: IdSchemas.sessionId,
    n: Type.Optional(count(1)),
    checkpoint: Type.Optional(count(1)),
  },
  'kernel.control.DiffRequest.v1',
);
export type DiffRequest = Static<typeof DiffRequestSchema>;

export const FILE_CHANGES = ['ADDED', 'MODIFIED', 'DELETED'] as const;

/** The checkpoints of the Session that are not reverted, oldest first (Orchestration 7.4). */
export const ListCheckpointsRequestSchema = closed(
  { requestId: IdSchemas.requestId, sessionId: IdSchemas.sessionId },
  'kernel.control.ListCheckpointsRequest.v1',
);
export type ListCheckpointsRequest = Static<typeof ListCheckpointsRequestSchema>;

/**
 * One line of `/checkpoints`: an input of the user (`INPUT`) or a checkpoint inside a run, with what
 * its stretch changed (Orchestration 7.4).
 * it; `changedFiles` is how many files its stretch changed, when that is known.
 */
export const CheckpointListSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    items: Type.Array(
      closed({
        seq: count(1),
        kind: Type.Enum(['INPUT', 'ROOT_SPAWN', 'HUMAN_ANSWER', 'TEMPLATE']),
        label: text(200),
        at: TimestampSchema,
        changedFiles: Type.Optional(count()),
      }),
    ),
  },
  'kernel.control.CheckpointList.v1',
);
export type CheckpointList = Static<typeof CheckpointListSchema>;

/** `diffRef` is a unified diff; excluded files are not in it. */
export const CheckpointDiffSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    files: Type.Array(closed({ path: text(4096), change: Type.Enum(FILE_CHANGES) })),
    diffRef: ArtifactRefSchema,
  },
  'kernel.control.CheckpointDiff.v1',
);
export type CheckpointDiff = Static<typeof CheckpointDiffSchema>;
