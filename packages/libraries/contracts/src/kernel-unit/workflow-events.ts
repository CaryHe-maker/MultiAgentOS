import { Type, type Static, type TSchema } from 'typebox';
import { pinnedRefOf } from '../catalog/definition-schemas.js';
import { ContextAssembleOutputSchema } from '../context/assemble.js';
import {
  RepositoryOrientOutputSchema,
  RepositorySearchOutputSchema,
} from '../context/repository.js';
import { FileReadOutputSchema } from '../executor/file-read.js';
import { ModelCallOutputSchema } from '../executor/model-call.js';
import { runEndVariants } from '../kernel-control/run-outcome.js';
import { artifactRefOf } from '../platform-common/common-schemas.js';
import { REPOSITORY_KINDS } from '../platform-common/execution-kind.js';
import { IdSchemas } from '../platform-common/ids.js';
import { MEDIA_TYPES } from '../platform-common/media-types.js';
import {
  UNIT_FAILED_CODES,
  UNIT_REJECTED_CODES,
  reasonCodeOf,
} from '../platform-common/reason-code.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
import { BudgetStateSchema } from './budget-state.js';
import { ReportPublishOutputSchema } from './report-publish.js';

export const RunStartSchema = closed(
  { type: Type.Literal('RunStart'), goal: text(4000) },
  'kernel.unit.RunStart.v0',
);
export type RunStart = Static<typeof RunStartSchema>;

/** The execution kinds an M1 Unit can have; the other three are rejected at submitUnit. */
export const UNIT_KINDS = [
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'FILE_READ',
  'CONTEXT_ASSEMBLE',
  'MODEL',
  'REPORT_PUBLISH',
] as const;

const unitReport = {
  type: Type.Literal('UnitReport'),
  requestId: IdSchemas.requestId,
  agentRunId: IdSchemas.agentRunId,
  unitRef: pinnedRefOf('UNIT'),
  budgetState: BudgetStateSchema,
};
const ok = <K extends string, O extends TSchema>(executionKind: K, output: O, mediaType: string) =>
  closed({
    ...unitReport,
    executionKind: Type.Literal(executionKind),
    unitAttemptId: IdSchemas.unitAttemptId,
    status: Type.Literal('OK'),
    output,
    outputRef: artifactRefOf(mediaType),
  });
const rejectedCodes = UNIT_REJECTED_CODES.filter((code) => code !== 'USER_DECLINED');

/**
 * Every submitUnit that got a SyscallAck gets exactly one UnitReport, or ends with RunClosed.
 * The variants leave no optional field:
 *
 * - OK: one per execution kind, with the output of that kind, an `outputRef` of that kind's
 *   media type (M1Interface 6.1) and the `unitAttemptId`.
 * - REJECTED with USER_DECLINED: only for a Unit that reads the repository, and without
 *   `unitAttemptId`, because the user declined before an attempt existed.
 * - REJECTED or FAILED otherwise: the `unitAttemptId` and a reason code of that status.
 */
export const UnitReportSchema = Type.Union(
  [
    ok('REPOSITORY_ORIENT', RepositoryOrientOutputSchema, MEDIA_TYPES.contextPack),
    ok('REPOSITORY_SEARCH', RepositorySearchOutputSchema, MEDIA_TYPES.contextPack),
    ok('FILE_READ', FileReadOutputSchema, MEDIA_TYPES.fileText),
    ok('CONTEXT_ASSEMBLE', ContextAssembleOutputSchema, MEDIA_TYPES.contextPack),
    ok('MODEL', ModelCallOutputSchema, MEDIA_TYPES.modelOutput),
    ok('REPORT_PUBLISH', ReportPublishOutputSchema, MEDIA_TYPES.analysisReport),
    closed({
      ...unitReport,
      executionKind: Type.Enum(REPOSITORY_KINDS),
      status: Type.Literal('REJECTED'),
      reasonCode: Type.Literal('USER_DECLINED'),
    }),
    closed({
      ...unitReport,
      executionKind: Type.Enum(UNIT_KINDS),
      unitAttemptId: IdSchemas.unitAttemptId,
      status: Type.Literal('REJECTED'),
      reasonCode: reasonCodeOf(rejectedCodes),
    }),
    closed({
      ...unitReport,
      executionKind: Type.Enum(UNIT_KINDS),
      unitAttemptId: IdSchemas.unitAttemptId,
      status: Type.Literal('FAILED'),
      reasonCode: reasonCodeOf(UNIT_FAILED_CODES),
    }),
  ],
  { $id: 'kernel.unit.UnitReport.v0' },
);
export type UnitReport = Static<typeof UnitReportSchema>;

/** Exactly one per run, and the last event sent to Workflow. */
export const RunClosedSchema = Type.Union(runEndVariants('RunClosed'), {
  $id: 'kernel.unit.RunClosed.v0',
});
export type RunClosed = Static<typeof RunClosedSchema>;

export const KernelToWorkflowEventSchema = Type.Union([
  RunStartSchema,
  UnitReportSchema,
  RunClosedSchema,
]);
export type KernelToWorkflowEvent = Static<typeof KernelToWorkflowEventSchema>;

/** `seq` rises by one from 1 per run and receiver; events are deduplicated by `eventId`. */
export const WorkflowInboxEventSchema = closed(
  {
    eventId: IdSchemas.eventId,
    workflowRunId: IdSchemas.workflowRunId,
    seq: count(1),
    occurredAt: TimestampSchema,
    event: KernelToWorkflowEventSchema,
  },
  'kernel.unit.WorkflowInboxEvent.v0',
);
export type WorkflowInboxEvent = Static<typeof WorkflowInboxEventSchema>;
