import { Type, type Static } from 'typebox';
import { DefinitionRefSchema, pinnedRefOf } from '../catalog/definition-schemas.js';
import { WorkspaceRevertedSchema } from '../kernel-control/interaction-events.js';
import { INTERRUPT_REASONS } from '../kernel-control/interrupt.js';
import { runEnd } from '../kernel-control/run-outcome.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { ExecutionKindSchema } from '../platform-common/execution-kind.js';
import { IdSchemas } from '../platform-common/ids.js';
import {
  UNIT_FAILED_CODES,
  UNIT_REJECTED_CODES,
  reasonCodeOf,
} from '../platform-common/reason-code.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
import { BudgetViewSchema, TurnUsageSchema } from './budget-state.js';
import { UnitOutputSchema } from './unit-io.js';

/** `templateRef` is required for ORCHESTRATION; CHAT is a growth rule in code and has none. */
const runStart = {
  type: Type.Literal('RunStart'),
  preset: Type.Enum(['standard', 'readonly']),
  initialInput: Type.Boolean(),
};
export const RunStartSchema = Type.Union(
  [
    closed({ ...runStart, mode: Type.Literal('CHAT') }),
    closed({
      ...runStart,
      mode: Type.Literal('ORCHESTRATION'),
      templateRef: DefinitionRefSchema,
    }),
  ],
  { $id: 'kernel.unit.RunStart.v1' },
);
export type RunStart = Static<typeof RunStartSchema>;

const report = {
  type: Type.Literal('UnitReport'),
  requestId: IdSchemas.requestId,
  agentRunId: IdSchemas.agentRunId,
  unitRunId: IdSchemas.unitRunId,
  unitRef: pinnedRefOf('UNIT'),
  executionKind: ExecutionKindSchema,
  budget: BudgetViewSchema,
};
export const UnitReportSchema = Type.Union(
  [
    closed({
      ...report,
      unitAttemptId: IdSchemas.unitAttemptId,
      status: Type.Literal('OK'),
      output: UnitOutputSchema,
      outputRef: Type.Optional(ArtifactRefSchema),
      fullRef: Type.Optional(ArtifactRefSchema),
      reasoningRef: Type.Optional(ArtifactRefSchema),
      /** The files a write tool changed. */
      changedFiles: Type.Optional(Type.Array(text(1024))),
    }),
    closed({
      ...report,
      unitAttemptId: Type.Optional(IdSchemas.unitAttemptId),
      status: Type.Literal('REJECTED'),
      reasonCode: reasonCodeOf(UNIT_REJECTED_CODES.filter((code) => code !== 'QUOTA_EXHAUSTED')),
    }),
    /** Refused at admission, so there is no attempt; `quota` names the limit (Kernel/Monitor 3). */
    closed({
      ...report,
      status: Type.Literal('REJECTED'),
      reasonCode: Type.Literal('QUOTA_EXHAUSTED'),
      quota: Type.Enum(['TOOL_UNITS', 'WALL_CLOCK', 'MEMORY']),
    }),
    closed({
      ...report,
      unitAttemptId: IdSchemas.unitAttemptId,
      status: Type.Literal('FAILED'),
      reasonCode: reasonCodeOf(UNIT_FAILED_CODES),
    }),
  ],
  { $id: 'kernel.unit.UnitReport.v1' },
);
export type UnitReport = Static<typeof UnitReportSchema>;

const humanAnswered = {
  type: Type.Literal('HumanAnswered'),
  kind: Type.Literal('prompt'),
  inputId: IdSchemas.inputId,
  contentRef: ArtifactRefSchema,
  turnId: IdSchemas.turnId,
  template: Type.Optional(DefinitionRefSchema),
};
export const HumanAnsweredSchema = Type.Union(
  [
    closed({ ...humanAnswered, origin: Type.Literal('initial') }),
    closed({
      ...humanAnswered,
      origin: Type.Literal('requested'),
      humanRequestId: IdSchemas.humanRequestId,
    }),
  ],
  { $id: 'kernel.unit.HumanAnswered.v1' },
);
export type HumanAnswered = Static<typeof HumanAnsweredSchema>;

export const TurnClosedSchema = closed(
  {
    type: Type.Literal('TurnClosed'),
    turnId: IdSchemas.turnId,
    reason: Type.Enum(['COMPLETED', 'ABORTED', 'TIMEOUT', 'BUDGET', 'RUN_CLOSED']),
    usage: TurnUsageSchema,
    /** Absent when the snapshot failed: the Turn went on, and cannot be undone. */
    startSnapshot: Type.Optional(text(64)),
    endSnapshot: Type.Optional(text(64)),
    changedFileCount: Type.Optional(count()),
  },
  'kernel.unit.TurnClosed.v1',
);
export type TurnClosed = Static<typeof TurnClosedSchema>;

export const RunClosedSchema = Type.Union([...runEnd('RunClosed')], {
  $id: 'kernel.unit.RunClosed.v1',
});
export type RunClosed = Static<typeof RunClosedSchema>;

/** What opening the Session found changed since its last Turn (M2Design 2.3). */
export const WorkspaceDivergedSchema = closed(
  { type: Type.Literal('WorkspaceDiverged'), files: Type.Array(text(4096), { minItems: 1 }) },
  'kernel.unit.WorkspaceDiverged.v1',
);
export type WorkspaceDiverged = Static<typeof WorkspaceDivergedSchema>;

/**
 * The run is being interrupted (Kernel/Core 5c): what was in flight has been answered with
 * INTERRUPTED, and Workflow must not call a model again; it ends the run with what it has.
 */
export const RunInterruptedSchema = closed(
  { type: Type.Literal('RunInterrupted'), reason: Type.Enum(INTERRUPT_REASONS) },
  'kernel.unit.RunInterrupted.v1',
);
export type RunInterrupted = Static<typeof RunInterruptedSchema>;

export const KernelToWorkflowEventSchema = Type.Union([
  RunStartSchema,
  UnitReportSchema,
  HumanAnsweredSchema,
  TurnClosedSchema,
  RunClosedSchema,
  WorkspaceRevertedSchema,
  WorkspaceDivergedSchema,
  RunInterruptedSchema,
]);
export type KernelToWorkflowEvent = Static<typeof KernelToWorkflowEventSchema>;

export const WorkflowInboxEventSchema = closed(
  {
    eventId: IdSchemas.eventId,
    sessionId: IdSchemas.sessionId,
    workflowRunId: IdSchemas.workflowRunId,
    seq: count(1),
    occurredAt: TimestampSchema,
    event: KernelToWorkflowEventSchema,
  },
  'kernel.unit.WorkflowInboxEvent.v1',
);
export type WorkflowInboxEvent = Static<typeof WorkflowInboxEventSchema>;
