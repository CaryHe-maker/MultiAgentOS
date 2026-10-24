import { AnalysisReportSchema, assertValid } from '@multiagentos/contracts';
import type {
  AnalysisReport,
  ReportLastIssue,
  RunFailure,
  WrapUpReason,
} from '@multiagentos/contracts';
import type { InvalidActionReason } from './analysis-action.js';

/**
 * The summary of a degraded report is a required field with no model text behind it. It is a
 * fixed placeholder for tools and records; UserInteraction describes the ending to the user
 * from `wrapUp` and does not show this text (docs/M1/Module/Workflow.md 10.2).
 */
export const DEGRADED_REPORT_SUMMARY =
  'Degraded report: the analysis ended without a valid finish. The reason is in wrapUp.';

/** Why the last call did not finish, as the cycle knows it; the report keeps only the code. */
export type LastReportIssue =
  | { readonly kind: 'FAILURE'; readonly failure: RunFailure }
  | { readonly kind: 'INVALID_OUTPUT'; readonly reason: InvalidActionReason }
  | { readonly kind: 'NO_FINISH' };

export interface DegradedReportInput {
  readonly workflowRunId: string;
  readonly goal: string;
  readonly reason: WrapUpReason;
  readonly readSources: readonly AnalysisReport['readSources'][number][];
  readonly agentRounds: readonly AnalysisReport['agentRounds'][number][];
  readonly snapshotId?: string;
  readonly createdAt: string;
  readonly lastIssue?: LastReportIssue;
  /** Paths of successfully read empty files, which cannot be line sources. */
  readonly emptyPaths?: readonly string[];
}

/** The report states the reason code only; failure.detail never leaves Workflow. */
function reportIssue(issue: LastReportIssue): ReportLastIssue {
  if (issue.kind === 'FAILURE') return { kind: 'FAILURE', code: issue.failure.code };
  if (issue.kind === 'INVALID_OUTPUT') return { kind: 'INVALID_OUTPUT', reason: issue.reason };
  return { kind: 'NO_FINISH' };
}

/** Builds a report from known facts only: no conclusions, no model content, no user-facing text. */
export function createDegradedReport(input: DegradedReportInput): AnalysisReport {
  return assertValid<AnalysisReport>(AnalysisReportSchema, {
    workflowRunId: input.workflowRunId,
    goal: input.goal,
    summary: DEGRADED_REPORT_SUMMARY,
    degraded: true,
    wrapUp: {
      reason: input.reason,
      ...(input.lastIssue === undefined ? {} : { lastIssue: reportIssue(input.lastIssue) }),
    },
    conclusions: [],
    unconfirmed: [],
    readSources: input.readSources.map((source) => ({ ...source })),
    agentRounds: input.agentRounds.map((agent) => ({ ...agent })),
    ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
    ...(input.emptyPaths === undefined || input.emptyPaths.length === 0
      ? {}
      : { emptyReads: [...input.emptyPaths] }),
    createdAt: input.createdAt,
  });
}
