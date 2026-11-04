import {
  AnalysisReportSchema,
  MEDIA_TYPES,
  MessagePublishInputSchema,
  ModelRawOutputSchema,
  ReportPublishInputSchema,
  ReplyArgsSchema,
  canonicalJson,
  validate,
  type AnalysisReport,
  type MessagePublishInput,
  type ModelRawOutput,
  type ReplyArgs,
  type ReportPublishInput,
  type UnitInput,
} from '@multiagentos/contracts';
import type { ResultCheck } from './run-attempts.js';
import type { SessionArtifacts } from './session-artifacts.js';

/** A result check without the identity Execution adds to it. */
export type BuiltInResult = Omit<ResultCheck, 'unitAttemptId' | 'executionId'>;

const notDispatched = (reasonCode: 'INVALID_INPUT' | 'INVALID_ARTIFACT_REF'): BuiltInResult => ({
  outcome: 'NOT_DISPATCHED',
  reasonCode,
});

/** Takes the `text` argument of one `reply` call out of the model output it was part of. */
async function replyText(
  input: Extract<MessagePublishInput, { kind: 'REPLY' }>,
  artifacts: SessionArtifacts,
): Promise<{ readonly text: string } | { readonly refused: BuiltInResult }> {
  const content = await artifacts.read(input.source.modelOutputRef);
  if (!content.ok) return { refused: notDispatched('INVALID_ARTIFACT_REF') };
  try {
    const output = validate<ModelRawOutput>(ModelRawOutputSchema, JSON.parse(content.text));
    if (!output.ok) return { refused: notDispatched('INVALID_INPUT') };
    const call = output.value.toolCalls.find((c) => c.toolCallId === input.source.toolCallId);
    if (call === undefined) return { refused: notDispatched('INVALID_INPUT') };
    const args = validate<ReplyArgs>(ReplyArgsSchema, JSON.parse(call.argumentsText));
    return args.ok ? { text: args.value.text } : { refused: notDispatched('INVALID_INPUT') };
  } catch {
    return { refused: notDispatched('INVALID_INPUT') };
  }
}

/** The reply's text lives only in the model output; the log holds references (Execution 5). */
export async function publishMessage(
  unitInput: UnitInput,
  artifacts: SessionArtifacts,
): Promise<BuiltInResult> {
  const input = validate<MessagePublishInput>(MessagePublishInputSchema, unitInput);
  if (!input.ok) return notDispatched('INVALID_INPUT');
  const { value } = input;
  if (value.kind === 'DEGRADED_REPLY') {
    const body = canonicalJson({ reason: value.reason });
    const outputRef = await artifacts.put(body, 'application/json', 'SESSION');
    return { outcome: 'COMPLETED', output: { kind: value.kind }, outputRef };
  }
  const reply = await replyText(value, artifacts);
  if ('refused' in reply) return reply.refused;
  const outputRef = await artifacts.put(reply.text, MEDIA_TYPES.markdown, 'SESSION');
  const { wrapUpReason } = value;
  return {
    outcome: 'COMPLETED',
    output: { kind: value.kind, ...(wrapUpReason === undefined ? {} : { wrapUpReason }) },
    outputRef,
  };
}

/** Fills in the goal from `goalRef`, because Workflow never holds the user's words. */
export async function publishReport(
  unitInput: UnitInput,
  artifacts: SessionArtifacts,
  maxReportBytes: number,
): Promise<BuiltInResult> {
  const input = validate<ReportPublishInput>(ReportPublishInputSchema, unitInput);
  if (!input.ok) return notDispatched('INVALID_INPUT');
  const goal = await artifacts.read(input.value.goalRef);
  if (!goal.ok) return notDispatched('INVALID_ARTIFACT_REF');
  const report = validate<AnalysisReport>(AnalysisReportSchema, {
    ...input.value.report,
    goal: goal.text,
  });
  if (!report.ok) return notDispatched('INVALID_INPUT');
  const body = canonicalJson(report.value);
  if (Buffer.byteLength(body, 'utf8') > maxReportBytes)
    return { outcome: 'REJECTED', reasonCode: 'LIMIT_EXCEEDED' };
  const outputRef = await artifacts.put(body, MEDIA_TYPES.analysisReport, 'SESSION');
  return {
    outcome: 'COMPLETED',
    output: {
      conclusionCount: report.value.conclusions.length,
      unconfirmedCount: report.value.unconfirmed.length,
      degraded: report.value.degraded,
    },
    outputRef,
  };
}
