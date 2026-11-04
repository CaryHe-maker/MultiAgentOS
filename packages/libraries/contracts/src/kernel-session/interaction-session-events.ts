import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';

export const SESSION_FAILURE_CODES = [
  'SESSION_LOCKED',
  'SESSION_LOG_CORRUPT',
  'SESSION_FORMAT_UNSUPPORTED',
  'SESSION_STORAGE_FAILED',
] as const;

export const ForkOriginSchema = closed({
  fromSessionId: IdSchemas.sessionId,
  fromTurnCount: count(),
});
export type ForkOrigin = Static<typeof ForkOriginSchema>;

export const SessionOpenedSchema = closed({
  type: Type.Literal('SessionOpened'),
  repositoryRoot: text(4096),
  title: Type.Optional(text(80)),
  turnCount: count(),
  fork: Type.Optional(ForkOriginSchema),
});
export type SessionOpened = Static<typeof SessionOpenedSchema>;

export const SessionFailedSchema = closed({
  type: Type.Literal('SessionFailed'),
  requestId: IdSchemas.requestId,
  code: Type.Enum(SESSION_FAILURE_CODES),
});
export type SessionFailed = Static<typeof SessionFailedSchema>;

export const SessionClosedSchema = closed({
  type: Type.Literal('SessionClosed'),
  reason: Type.Enum(['SWITCHED', 'SHUTDOWN']),
});
export type SessionClosed = Static<typeof SessionClosedSchema>;

export const InteractionSessionEventSchema = closed(
  {
    eventId: IdSchemas.eventId,
    sessionId: IdSchemas.sessionId,
    seq: count(1),
    occurredAt: TimestampSchema,
    event: Type.Union([SessionOpenedSchema, SessionFailedSchema, SessionClosedSchema]),
  },
  'kernel.session.InteractionSessionEvent.v1',
);
export type InteractionSessionEvent = Static<typeof InteractionSessionEventSchema>;

export const SessionListSchema = closed({
  type: Type.Literal('SessionList'),
  requestId: IdSchemas.requestId,
  sessions: Type.Array(
    closed({
      sessionId: IdSchemas.sessionId,
      title: Type.Optional(text(80)),
      createdAt: TimestampSchema,
      lastActiveAt: TimestampSchema,
      turnCount: count(),
      fork: Type.Optional(ForkOriginSchema),
    }),
    { maxItems: 1000 },
  ),
});
export type SessionList = Static<typeof SessionListSchema>;

export const SessionDeletedSchema = closed({
  type: Type.Literal('SessionDeleted'),
  requestId: IdSchemas.requestId,
  sessionId: IdSchemas.sessionId,
  outcome: Type.Enum(['DELETED', 'FAILED']),
});
export type SessionDeleted = Static<typeof SessionDeletedSchema>;

export const InteractionSystemEventSchema = closed(
  {
    eventId: IdSchemas.eventId,
    seq: count(1),
    occurredAt: TimestampSchema,
    event: Type.Union([SessionListSchema, SessionDeletedSchema]),
  },
  'kernel.session.InteractionSystemEvent.v1',
);
export type InteractionSystemEvent = Static<typeof InteractionSystemEventSchema>;
