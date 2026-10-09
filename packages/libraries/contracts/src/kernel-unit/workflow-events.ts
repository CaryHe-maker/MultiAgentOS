import { Type, type Static } from 'typebox';
import { PinnedDefinitionRefSchema } from '../catalog/definition-schemas.js';
import { runEndVariants } from '../kernel-control/run-outcome.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { ExecutionKindSchema } from '../platform-common/execution-kind.js';
import { IdSchemas } from '../platform-common/ids.js';
import { ReasonCodeSchema } from '../platform-common/reason-code.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
import { BudgetStateSchema } from './budget-state.js';
import { UnitOutputSchema } from './unit-io.js';

export const RunStartSchema = closed(
  { type: Type.Literal('RunStart'), goal: text(4000) },
  'kernel.unit.RunStart.v0',
);
export type RunStart = Static<typeof RunStartSchema>;

const unitReport = {
  type: Type.Literal('UnitReport'),
  requestId: IdSchemas.requestId,
  agentRunId: IdSchemas.agentRunId,
  unitRef: PinnedDefinitionRefSchema,
  executionKind: ExecutionKindSchema,
  // Absent only for USER_DECLINED, which is delivered before a UnitAttempt exists.
  unitAttemptId: Type.Optional(IdSchemas.unitAttemptId),
  budgetState: BudgetStateSchema,
};
/**
 * Every submitUnit that got a SyscallAck gets exactly one UnitReport, or ends with RunClosed.
 * OK carries `output` and `outputRef`; REJECTED and FAILED carry `reasonCode`.
 */
export const UnitReportSchema = Type.Union(
  [
    closed({
      ...unitReport,
      status: Type.Literal('OK'),
      output: UnitOutputSchema,
      outputRef: ArtifactRefSchema,
    }),
    closed({
      ...unitReport,
      status: Type.Enum(['REJECTED', 'FAILED']),
      reasonCode: ReasonCodeSchema,
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
