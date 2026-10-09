import { Type, type Static } from 'typebox';
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
