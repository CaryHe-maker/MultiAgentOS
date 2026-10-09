import { Type } from 'typebox';

const Id = (prefix: string) =>
  Type.String({ pattern: `^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{5,127}$` });

/** Identifier formats; prefixes and generators are listed in M1Interface 3.1. */
export const IdSchemas = {
  workflowRunId: Id('wfr'),
  agentRunId: Id('agr'),
  requestId: Id('req'),
  unitAttemptId: Id('una'),
  executionId: Id('exe'),
  eventId: Id('evt'),
  messageId: Id('msg'),
  correlationId: Id('cor'),
  questionId: Id('qst'),
  artifactId: Id('art'),
  contextPackId: Id('ctx'),
  snapshotId: Id('snp'),
  // Kept for the optional BoundaryContext and Envelope fields; M1 does not fill them.
  workSessionId: Id('wss'),
  missionScopeId: Id('msc'),
} as const;

/** Returned by the model provider and used as is. */
export const ToolCallIdSchema = Type.String({ minLength: 1, maxLength: 128 });
