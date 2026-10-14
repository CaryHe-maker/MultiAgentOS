import { AnalysisReportSchema, assertValid } from '@multiagentos/contracts';
import type { AnalysisReport, AnalysisReportDraft, WrapUpReason } from '@multiagentos/contracts';
import type { WorkflowState } from './state.js';
import { reportSources, withEmptyFileNotice } from './report-sources.js';

export interface NormalReportInput {
  readonly workflowRunId: string;
  readonly goal: string;
  readonly draft: AnalysisReportDraft;
  readonly reads: WorkflowState['reads'];
  readonly agentRounds: AnalysisReport['agentRounds'];
  readonly createdAt: string;
  readonly snapshotId?: string;
  readonly wrapUpReason?: WrapUpReason;
}

/** Verify each whole conclusion against one covering read per source, in receipt order. */
export function createNormalReport(input: NormalReportInput): AnalysisReport {
  const conclusions: Extract<AnalysisReport, { readonly degraded: false }>['conclusions'] = [];
  const unconfirmed: Extract<AnalysisReport, { readonly degraded: false }>['unconfirmed'] = [];
  for (const conclusion of input.draft.conclusions) {
    if (conclusion.sources.length === 0) {
      unconfirmed.push({ statement: conclusion.statement, reason: 'NO_SOURCE' });
      continue;
    }
    const sources = conclusion.sources.map((source) => {
      const read = input.reads.find(
        ({ output }) =>
          output.path === source.path &&
          output.startLine <= source.startLine &&
          output.endLine >= source.endLine,
      );
      return read === undefined
        ? undefined
        : {
            ...source,
            readRequestId: read.requestId,
            readContentSha256: read.output.contentSha256,
          };
    });
    if (sources.some((source) => source === undefined))
      unconfirmed.push({ statement: conclusion.statement, reason: 'SOURCE_NOT_READ' });
    else
      conclusions.push({
        statement: conclusion.statement,
        sources: sources.filter((source) => source !== undefined),
      });
  }
  for (const statement of input.draft.unconfirmed)
    unconfirmed.push({ statement, reason: 'MODEL_UNCONFIRMED' });
  const { readSources, emptyFileCount } = reportSources(input.reads);
  return assertValid<AnalysisReport>(AnalysisReportSchema, {
    workflowRunId: input.workflowRunId,
    goal: input.goal,
    summary: withEmptyFileNotice(input.draft.summary, emptyFileCount),
    conclusions,
    unconfirmed,
    readSources,
    agentRounds: input.agentRounds,
    degraded: false,
    createdAt: input.createdAt,
    ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
    ...(input.wrapUpReason === undefined ? {} : { wrapUp: { reason: input.wrapUpReason } }),
  });
}
