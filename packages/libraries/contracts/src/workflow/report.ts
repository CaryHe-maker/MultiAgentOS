import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import {
  LINE_RANGE_ERROR,
  Sha256Schema,
  TimestampSchema,
  closed,
  count,
  isLineRange,
  lineRange,
  text,
} from '../platform-common/schema-helpers.js';
import { WrapUpReasonSchema } from './step-record.js';

const range = { path: text(1024), ...lineRange };
const SourceRefSchema = Type.Refine(closed(range), isLineRange, LINE_RANGE_ERROR);
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

/** A range that one successful file-read of this run covers. */
export const VerifiedSourceSchema = Type.Refine(
  closed({
    ...range,
    readRequestId: IdSchemas.requestId,
    readContentSha256: Sha256Schema,
  }),
  isLineRange,
  LINE_RANGE_ERROR,
);
export type VerifiedSource = Static<typeof VerifiedSourceSchema>;

const report = {
  workflowRunId: IdSchemas.workflowRunId,
  goal: text(4000),
  summary: text(4000),
  readSources: Type.Array(VerifiedSourceSchema),
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
};
const WrapUpSchema = closed({ reason: WrapUpReasonSchema });

/**
 * Input of report-publish; UserInteraction reads and shows it. A normal report has
 * `degraded = false`, every conclusion with at least one verified source, and `wrapUp` only
 * when Workflow wrapped up early. A degraded report (no valid FINISH) has `degraded = true`,
 * `wrapUp` always, and neither conclusions nor unconfirmed items.
 */
export const AnalysisReportSchema = Type.Union(
  [
    closed({
      ...report,
      degraded: Type.Literal(false),
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
      wrapUp: Type.Optional(WrapUpSchema),
    }),
    closed({
      ...report,
      degraded: Type.Literal(true),
      conclusions: Type.Array(Type.Never(), { maxItems: 0 }),
      unconfirmed: Type.Array(Type.Never(), { maxItems: 0 }),
      wrapUp: WrapUpSchema,
    }),
  ],
  { $id: 'workflow.AnalysisReport.v0' },
);
export type AnalysisReport = Static<typeof AnalysisReportSchema>;
