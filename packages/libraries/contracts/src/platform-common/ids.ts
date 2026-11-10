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
  /** One reservation of shares for the tasks of a `run_subagents` call (M2Design 7.3). */
  delegationId: Id('dlg'),
  queryId: Id('slq'),
  /** One compaction of a projection (M2Design 9.6). */
  compactionId: Id('cmp'),
} as const;

/** Returned by the model provider and used as is. */
export const ToolCallIdSchema = Type.String({ minLength: 1, maxLength: 128 });

/**
 * `ref_` and the number of a handover in its Session, from 1. Workflow mints it when it registers
 * the handover, from the log alone (the registrations before it, plus one), so a Session never
 * repeats one and the same log gives the same numbers (M2Design 3.7).
 */
export const ReferenceIdSchema = Type.String({ pattern: '^ref_[1-9][0-9]*$', maxLength: 32 });

const REFERENCE_NAME = /^(ref_[1-9][0-9]*)\/(.+)$/u;

/** How a reference is written to the one it was handed to, and read back: `ref_N/toolCallId`. */
export const referenceName = (referenceId: string, toolCallId: string): string =>
  `${referenceId}/${toolCallId}`;

/** The two parts of a reference; undefined when the text is not one. */
export function parseReferenceName(
  name: string,
): { readonly referenceId: string; readonly toolCallId: string } | undefined {
  const parts = REFERENCE_NAME.exec(name);
  const [, referenceId, toolCallId] = parts ?? [];
  return referenceId === undefined || toolCallId === undefined
    ? undefined
    : { referenceId, toolCallId };
}
