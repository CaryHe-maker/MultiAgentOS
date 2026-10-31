import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { closed, count } from '../platform-common/schema-helpers.js';
import { AnalysisReportSchema } from '../workflow/report.js';

/** report-publish is built into Kernel.Execution and is never dispatched to the Supervisor. */
export const ReportPublishInputSchema = closed(
  { report: AnalysisReportSchema },
  'kernel.unit.ReportPublishInput.v0',
);
export type ReportPublishInput = Static<typeof ReportPublishInputSchema>;

export const ReportPublishOutputSchema = closed(
  { conclusionCount: count(), unconfirmedCount: count(), degraded: Type.Boolean() },
  'kernel.unit.ReportPublishOutput.v0',
);
export type ReportPublishOutput = Static<typeof ReportPublishOutputSchema>;

/**
 * Major 1: Workflow never holds the goal text, so `report` is an AnalysisReport without `goal`
 * and Execution fills it in from `goalRef`, then validates the whole report before storing it.
 */
export const ReportPublishInputV1Schema = closed(
  { goalRef: ArtifactRefSchema, report: Type.Record(Type.String(), Type.Unknown()) },
  'kernel.unit.ReportPublishInput.v1',
);
export type ReportPublishInputV1 = Static<typeof ReportPublishInputV1Schema>;
