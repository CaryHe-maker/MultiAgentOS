import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { closed, count } from '../platform-common/schema-helpers.js';

export const ReportPublishOutputSchema = closed(
  { conclusionCount: count(), unconfirmedCount: count(), degraded: Type.Boolean() },
  'kernel.unit.ReportPublishOutput.v1',
);
export type ReportPublishOutput = Static<typeof ReportPublishOutputSchema>;

/**
 * Workflow never holds the goal text, so `report` is an AnalysisReport without `goal`
 * and Execution fills it in from `goalRef`, then validates the whole report before storing it.
 */
export const ReportPublishInputSchema = closed(
  { goalRef: ArtifactRefSchema, report: Type.Record(Type.String(), Type.Unknown()) },
  'kernel.unit.ReportPublishInput.v1',
);
export type ReportPublishInput = Static<typeof ReportPublishInputSchema>;
