import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import {
  Sha256Schema,
  TimestampSchema,
  closed,
  count,
  text,
} from '../platform-common/schema-helpers.js';
import { WrapUpReasonSchema } from './step-record.js';

const range = { path: text(1024), startLine: count(1), endLine: count(1) };
const SourceRefSchema = closed(range);
export type SourceRef = Static<typeof SourceRefSchema>;

/** Parameters of the `finish_analysis` tool. */
export const AnalysisReportDraftSchema = closed(
  {
    summary: text(4000),
    conclusions: Type.Array(
      closed({
        statement: text(2000),
        sources: Type.Array(SourceRefSchema, { maxItems: 20 }),
      }),
      { maxItems: 50 },
    ),
    unconfirmed: Type.Array(text(1000), { maxItems: 50 }),
  },
  'workflow.AnalysisReportDraft.v0',
);
export type AnalysisReportDraft = Static<typeof AnalysisReportDraftSchema>;

export const VerifiedSourceSchema = closed({
  ...range,
  readRequestId: IdSchemas.requestId,
  readContentSha256: Sha256Schema,
});
export type VerifiedSource = Static<typeof VerifiedSourceSchema>;

/** Input of report-publish; UserInteraction reads and shows it. */
export const AnalysisReportSchema = closed(
  {
    workflowRunId: IdSchemas.workflowRunId,
    goal: text(4000),
    summary: text(4000),
    conclusions: Type.Array(
      closed({
        statement: text(2000),
        sources: Type.Array(VerifiedSourceSchema, { minItems: 1 }),
      }),
    ),
    unconfirmed: Type.Array(
      closed({
        statement: text(2000),
        reason: Type.Enum(['NO_SOURCE', 'SOURCE_NOT_READ', 'MODEL_UNCONFIRMED']),
      }),
    ),
    readSources: Type.Array(VerifiedSourceSchema),
    wrapUp: Type.Optional(closed({ reason: WrapUpReasonSchema })),
    degraded: Type.Boolean(),
    agentRounds: Type.Array(
      closed({
        agentId: text(64),
        agentRunId: IdSchemas.agentRunId,
        roundsUsed: count(),
        maxRounds: count(1),
      }),
    ),
    snapshotId: Type.Optional(IdSchemas.snapshotId),
    createdAt: TimestampSchema,
  },
  'workflow.AnalysisReport.v0',
);
export type AnalysisReport = Static<typeof AnalysisReportSchema>;
