import { Type } from 'typebox';

const Id = (prefix: string) =>
  Type.String({ pattern: `^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{5,127}$` });
/** An identifier whose body is a SHA-256 in lower-case hexadecimal. */
const DigestId = (prefix: string) => Type.String({ pattern: `^${prefix}_[a-f0-9]{64}$` });

/** Identifier formats. */
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
  undoId: Id('und'),
  /** `art_` followed by the SHA-256 of the content. */
  artifactId: DigestId('art'),
  contextPackId: Id('ctx'),
  /** `snp_` followed by the repository snapshot digest. */
  snapshotId: DigestId('snp'),
  // For the optional BoundaryContext and Envelope fields, which nothing fills yet.
  workSessionId: Id('wss'),
  missionScopeId: Id('msc'),
  // M2 (Interface 3).
  sessionId: Id('ses'),
  turnId: Id('trn'),
  nodeId: Id('nod'),
  unitRunId: Id('unr'),
  humanRequestId: Id('hrq'),
  inputId: Id('inp'),
  commandId: Id('scm'),
  queryId: Id('slq'),
} as const;

/** Returned by the model provider and used as is. */
export const ToolCallIdSchema = Type.String({ minLength: 1, maxLength: 128 });
