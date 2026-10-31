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

export const ArtifactOwnerLineSchema = closed(
  {
    artifactId: IdSchemas.artifactId,
    mediaType: text(128),
    sha256: Sha256Schema,
    size: count(),
    retention: Type.Enum(['SESSION', 'EXPIRING']),
    source: Type.Enum(['PRODUCED', 'INHERITED']),
    fullOutput: Type.Optional(Type.Literal(true)),
    retainedSince: TimestampSchema,
    at: TimestampSchema,
  },
  'platform.persistence.ArtifactOwnerLine.v1',
);
export type ArtifactOwnerLine = Static<typeof ArtifactOwnerLineSchema>;
