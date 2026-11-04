import { Type, type Static } from 'typebox';
import {
  ForkOriginSchema,
  SESSION_FAILURE_CODES,
} from '../kernel-session/interaction-session-events.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';

const SessionCommandFailureSchema = closed({
  code: Type.Enum(SESSION_FAILURE_CODES),
  /** Never carries session content. */
  detail: Type.Optional(text(200)),
});
export type SessionCommandFailure = Static<typeof SessionCommandFailureSchema>;

const reply = {
  requestId: IdSchemas.requestId,
  sessionId: IdSchemas.sessionId,
  commandId: IdSchemas.commandId,
};
const SessionCommandResultSchema = Type.Union([
  closed({
    command: Type.Literal('OPEN'),
    outcome: Type.Literal('READY'),
    lastTurnId: Type.Optional(IdSchemas.turnId),
  }),
  closed({ command: Type.Literal('CREATE'), outcome: Type.Literal('READY') }),
  /** Every artifact the copied log refers to, and how far the original had got. */
  closed({
    command: Type.Literal('FORK'),
    outcome: Type.Literal('READY'),
    inheritedArtifacts: Type.Array(ArtifactRefSchema),
    fromTurnCount: count(),
  }),
  closed({ command: Type.Enum(['CLOSE', 'DELETE']), outcome: Type.Literal('DONE') }),
  closed({
    command: Type.Enum(['OPEN', 'CREATE', 'FORK', 'CLOSE', 'DELETE']),
    outcome: Type.Literal('FAILED'),
    failure: SessionCommandFailureSchema,
  }),
]);

/** Answers a SessionCommand or SessionDelete; a command gets at most one reply. */
export const ReportSessionCommandRequestSchema = closed(
  { ...reply, result: SessionCommandResultSchema },
  'kernel.unit.ReportSessionCommandRequest.v1',
);
export type ReportSessionCommandRequest = Static<typeof ReportSessionCommandRequestSchema>;

export const SessionListEntrySchema = closed({
  sessionId: IdSchemas.sessionId,
  createdAt: TimestampSchema,
  lastActiveAt: TimestampSchema,
  turnCount: count(),
  titleRef: Type.Optional(ArtifactRefSchema),
  fork: Type.Optional(ForkOriginSchema),
  status: Type.Enum(['ACTIVE', 'DELETED']),
});
export type SessionListEntry = Static<typeof SessionListEntrySchema>;

export const ReportSessionListRequestSchema = closed(
  {
    requestId: IdSchemas.requestId,
    queryId: IdSchemas.queryId,
    sessions: Type.Array(SessionListEntrySchema, { maxItems: 1000 }),
  },
  'kernel.unit.ReportSessionListRequest.v1',
);
export type ReportSessionListRequest = Static<typeof ReportSessionListRequestSchema>;
