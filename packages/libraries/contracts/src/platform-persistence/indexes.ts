import { Type, type Static } from 'typebox';
import { ForkOriginSchema } from '../kernel-session/interaction-session-events.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import {
  Sha256Schema,
  TimestampSchema,
  closed,
  count,
  text,
} from '../platform-common/schema-helpers.js';

const status = Type.Enum(['ACTIVE', 'DELETED']);

/** Appended on every change; the last line of a `sessionId` wins (Interface/Persistence 3). */
export const SessionIndexLineSchema = closed(
  {
    sessionId: IdSchemas.sessionId,
    repositoryRoot: text(4096),
    createdAt: TimestampSchema,
    lastActiveAt: TimestampSchema,
    turnCount: count(),
    titleRef: Type.Optional(ArtifactRefSchema),
    fork: Type.Optional(ForkOriginSchema),
    status,
  },
  'platform.persistence.SessionIndexLine.v1',
);
export type SessionIndexLine = Static<typeof SessionIndexLineSchema>;

export const SessionRefLineSchema = closed(
  {
    sessionId: IdSchemas.sessionId,
    repositoryRoot: text(4096),
    status,
    at: TimestampSchema,
  },
  'platform.persistence.SessionRefLine.v1',
);
export type SessionRefLine = Static<typeof SessionRefLineSchema>;

export const TrustedInstructionLineSchema = closed(
  {
    repositoryRoot: text(4096),
    path: text(512),
    sha256: Sha256Schema,
    source: Type.Enum(['USER_CONFIRMED', 'APPROVED_WRITE']),
    at: TimestampSchema,
  },
  'platform.persistence.TrustedInstructionLine.v1',
);
export type TrustedInstructionLine = Static<typeof TrustedInstructionLineSchema>;

/**
 * A folder the user allowed the web search for, from now on (docs/M2/Kernel/Core.md 5f). It
 * grants nothing but the question that is not asked again; the fetch and the commands are not part
 * of it, and nothing here is a path or a query.
 */
export const TrustedWebSearchLineSchema = closed(
  {
    repositoryRoot: text(4096),
    source: Type.Enum(['USER_CONFIRMED']),
    at: TimestampSchema,
  },
  'platform.persistence.TrustedWebSearchLine.v1',
);
export type TrustedWebSearchLine = Static<typeof TrustedWebSearchLineSchema>;

export const ArtifactOwnerLineSchema = closed(
  {
    artifactId: IdSchemas.artifactId,
    mediaType: text(128),
    sha256: Sha256Schema,
    size: count(),
    retention: Type.Enum(['SESSION', 'EXPIRING', 'ONCE']),
    /** Set when the one it was made for is done with it; from then on it reads as expired. */
    releasedAt: Type.Optional(TimestampSchema),
    source: Type.Enum(['PRODUCED', 'INHERITED']),
    fullOutput: Type.Optional(Type.Literal(true)),
    retainedSince: TimestampSchema,
    at: TimestampSchema,
  },
  'platform.persistence.ArtifactOwnerLine.v1',
);
export type ArtifactOwnerLine = Static<typeof ArtifactOwnerLineSchema>;

const snapshotChange = closed({
  path: text(4096),
  change: Type.Enum(['ADDED', 'MODIFIED', 'DELETED']),
});

/** `snapshot-index.jsonl`; a Turn without TURN_ENDED was left by an exit (M2Design 4.6). */
export const SnapshotIndexLineSchema = Type.Union(
  [
    closed({
      kind: Type.Literal('TURN_STARTED'),
      turnId: IdSchemas.turnId,
      turnSeq: count(1),
      viewId: Type.Literal('main'),
      startSnapshot: Type.Optional(text(64)),
      at: TimestampSchema,
    }),
    closed({
      kind: Type.Literal('TURN_ENDED'),
      turnId: IdSchemas.turnId,
      endSnapshot: Type.Optional(text(64)),
      changedFiles: Type.Array(snapshotChange),
      at: TimestampSchema,
    }),
    /**
     * The Session was opened in another folder: the Turns before this line have no way back, since
     * their snapshots are of another folder. The lines stay, and nothing reads them any more.
     */
    closed({
      kind: Type.Literal('EPOCH'),
      repositoryRoot: text(4096),
      at: TimestampSchema,
    }),
    /**
     * A checkpoint (Orchestration 7.1): a snapshot taken at a still point worth coming back to:
     * each input of the user (`INPUT`, what a Turn's start was), or a cut inside a run, taken while
     * its mutating work was held. Older lines name the Turn they were taken in.
     */
    closed({
      kind: Type.Literal('CHECKPOINT'),
      checkpointId: IdSchemas.checkpointId,
      turnId: Type.Optional(IdSchemas.turnId),
      ckpKind: Type.Enum(['INPUT', 'ROOT_SPAWN', 'HUMAN_ANSWER', 'TEMPLATE']),
      label: text(200),
      snapshot: Type.Optional(text(64)),
      at: TimestampSchema,
    }),
    /**
     * The workspace when the run went still (waiting for the user, or ended): where the stretch of
     * the latest checkpoint ends, and what an undo compares the files with.
     */
    closed({
      kind: Type.Literal('SETTLED'),
      snapshot: Type.Optional(text(64)),
      at: TimestampSchema,
    }),
    /**
     * The workspace went back to a checkpoint; later checkpoints are gone. `inclusive` (an undo)
     * takes the checkpoint itself back too: the files are as they were when it was taken, and the
     * work from it on is undone. `forced` overwrote files changed outside the system.
     */
    closed({
      kind: Type.Literal('ROLLED_BACK_TO'),
      checkpointId: IdSchemas.checkpointId,
      inclusive: Type.Optional(Type.Boolean()),
      forced: Type.Optional(Type.Boolean()),
      backupSnapshot: Type.Optional(text(64)),
      at: TimestampSchema,
    }),
    closed({
      kind: Type.Literal('REVERTED'),
      revertedTurnIds: Type.Array(IdSchemas.turnId, { minItems: 1 }),
      forced: Type.Boolean(),
      backupSnapshot: Type.Optional(text(64)),
      at: TimestampSchema,
    }),
  ],
  { $id: 'platform.persistence.SnapshotIndexLine.v1' },
);
export type SnapshotIndexLine = Static<typeof SnapshotIndexLineSchema>;
