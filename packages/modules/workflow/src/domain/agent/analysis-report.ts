import type {
  AnalysisReportDraft,
  FileReadOutput,
  SessionLogRecord,
} from '@multiagentos/contracts';

/**
 * The report of `analyze` as Workflow builds it (Module/Workflow 9.2): conclusions are verified
 * against the reads of this run, and `goal` is left to Execution, which resolves the reference.
 * Every fact comes from the log, so the same log gives the same report.
 */
export interface AnalysisFacts {
  readonly reads: readonly { readonly requestId: string; readonly output: FileReadOutput }[];
  readonly snapshotId?: string;
}

export interface AgentRounds {
  readonly agentId: string;
  readonly agentRunId: string;
  readonly roundsUsed: number;
  readonly maxRounds: number;
}

export function analysisFacts(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
): AnalysisFacts {
  const units = new Map<string, string>();
  const reads: { requestId: string; output: FileReadOutput }[] = [];
  let snapshotId: string | undefined;
  for (const record of records) {
    if (!('workflowRunId' in record) || record.workflowRunId !== workflowRunId) continue;
    if (record.type === 'UNIT_SUBMITTED') units.set(record.requestId, record.unitRef.id);
    if (record.type !== 'UNIT_COMPLETED' || record.status !== 'OK') continue;
    const unit = units.get(record.requestId);
    if (unit === 'file-read')
      reads.push({ requestId: record.requestId, output: record.output as FileReadOutput });
    if (unit === 'repository-orient')
      snapshotId = (record.output as { readonly snapshotId: string }).snapshotId;
  }
  return { reads, ...(snapshotId === undefined ? {} : { snapshotId }) };
}

function readSources(facts: AnalysisFacts) {
  const emptyReads: string[] = [];
  const sources: {
    path: string;
    startLine: number;
    endLine: number;
    readRequestId: string;
    readContentSha256: string;
  }[] = [];
  for (const { requestId, output } of facts.reads) {
    if (output.totalLines === 0) {
      if (!emptyReads.includes(output.path)) emptyReads.push(output.path);
      continue;
    }
    sources.push({
      path: output.path,
      startLine: output.startLine,
      endLine: output.endLine,
      readRequestId: requestId,
      readContentSha256: output.contentSha256,
    });
  }
  return { sources, emptyReads };
}

interface ReportInput {
  readonly workflowRunId: string;
  readonly facts: AnalysisFacts;
  readonly agentRounds: readonly AgentRounds[];
  readonly createdAt: string;
}

function common(input: ReportInput) {
  const { sources, emptyReads } = readSources(input.facts);
  return {
    workflowRunId: input.workflowRunId,
    readSources: sources,
    agentRounds: input.agentRounds.map((rounds) => ({ ...rounds })),
    createdAt: input.createdAt,
    ...(input.facts.snapshotId === undefined ? {} : { snapshotId: input.facts.snapshotId }),
    ...(emptyReads.length === 0 ? {} : { emptyReads }),
  };
}

/** Each conclusion stands or falls whole, against one covering read per source. */
export function normalReportBody(
  input: ReportInput & { readonly draft: AnalysisReportDraft; readonly wrapUpReason?: string },
): Record<string, unknown> {
  const conclusions: { statement: string; sources: unknown[] }[] = [];
  const unconfirmed: { statement: string; reason: string }[] = [];
  for (const conclusion of input.draft.conclusions) {
    if (conclusion.sources.length === 0) {
      unconfirmed.push({ statement: conclusion.statement, reason: 'NO_SOURCE' });
      continue;
    }
    const sources = conclusion.sources.map((source) => {
      const read = input.facts.reads.find(
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
    else conclusions.push({ statement: conclusion.statement, sources });
  }
  for (const statement of input.draft.unconfirmed)
    unconfirmed.push({ statement, reason: 'MODEL_UNCONFIRMED' });
  return {
    ...common(input),
    summary: input.draft.summary,
    conclusions,
    unconfirmed,
    degraded: false,
    ...(input.wrapUpReason === undefined ? {} : { wrapUp: { reason: input.wrapUpReason } }),
  };
}

/** A fixed placeholder: UserInteraction explains the ending from `wrapUp`, not from this text. */
export const DEGRADED_REPORT_SUMMARY =
  'Degraded report: the analysis ended without a valid finish. The reason is in wrapUp.';

export function degradedReportBody(
  input: ReportInput & { readonly reason: string },
): Record<string, unknown> {
  return {
    ...common(input),
    summary: DEGRADED_REPORT_SUMMARY,
    degraded: true,
    wrapUp: { reason: input.reason },
    conclusions: [],
    unconfirmed: [],
  };
}
