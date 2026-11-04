import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';

const command = { type: Type.Literal('SessionCommand'), commandId: IdSchemas.commandId };

/** What Kernel orders Workflow to do with a Session (Interface/WorkflowKernel 3.2). */
export const SessionCommandSchema = Type.Union([
  closed({ ...command, command: Type.Enum(['OPEN', 'CREATE']), repositoryRoot: text(4096) }),
  closed({
    ...command,
    command: Type.Literal('FORK'),
    repositoryRoot: text(4096),
    fromSessionId: IdSchemas.sessionId,
  }),
  closed({ ...command, command: Type.Literal('CLOSE') }),
]);
export type SessionCommand = Static<typeof SessionCommandSchema>;

export const WorkflowSessionEventSchema = closed(
  {
    eventId: IdSchemas.eventId,
    sessionId: IdSchemas.sessionId,
    seq: count(1),
    occurredAt: TimestampSchema,
    event: SessionCommandSchema,
  },
  'kernel.session.WorkflowSessionEvent.v1',
);
export type WorkflowSessionEvent = Static<typeof WorkflowSessionEventSchema>;

export const SessionListQuerySchema = closed({
  type: Type.Literal('SessionListQuery'),
  queryId: IdSchemas.queryId,
  repositoryRoot: text(4096),
});
export type SessionListQuery = Static<typeof SessionListQuerySchema>;

export const SessionDeleteSchema = closed({
  type: Type.Literal('SessionDelete'),
  commandId: IdSchemas.commandId,
  sessionId: IdSchemas.sessionId,
});
export type SessionDelete = Static<typeof SessionDeleteSchema>;

/** Not part of any Session: nothing is open at startup, and only closed Sessions are deleted. */
export const WorkflowSystemEventSchema = closed(
  {
    eventId: IdSchemas.eventId,
    seq: count(1),
    occurredAt: TimestampSchema,
    event: Type.Union([SessionListQuerySchema, SessionDeleteSchema]),
  },
  'kernel.session.WorkflowSystemEvent.v1',
);
export type WorkflowSystemEvent = Static<typeof WorkflowSystemEventSchema>;
