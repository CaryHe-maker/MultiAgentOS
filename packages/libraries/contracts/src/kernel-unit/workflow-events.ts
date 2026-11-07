import { Type, type Static } from 'typebox';
import { DefinitionRefSchema, pinnedRefOf } from '../catalog/definition-schemas.js';
import {
  CompactionTargetSchema,
  CompactionSummaryInputSchema,
  CompactionUsageSchema,
  PrunedItemSchema,
} from '../context/compaction.js';
import { WorkspaceRevertedSchema } from '../kernel-control/interaction-events.js';
import { LOCAL_QUESTION_KINDS } from '../kernel-control/human-request.js';
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
    /** Cancelled by a pause or an abort (M2Design 4.4); what it used is already in `budget`. */
    closed({
      ...report,
      unitAttemptId: IdSchemas.unitAttemptId,
      status: Type.Literal('INTERRUPTED'),
      interruptedBy: Type.Enum(['PAUSED', 'ABORTED']),
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
const answeredContent = {
  type: Type.Literal('HumanAnswered'),
  inputId: IdSchemas.inputId,
  contentRef: ArtifactRefSchema,
};
export const HumanAnsweredSchema = Type.Union(
  [
    closed({ ...humanAnswered, origin: Type.Literal('initial') }),
    closed({
      ...humanAnswered,
      origin: Type.Literal('requested'),
      humanRequestId: IdSchemas.humanRequestId,
    }),
    /** The answer to a local question: it opens no Turn (M2Design 4.2). */
    closed({
      ...answeredContent,
      kind: Type.Enum(LOCAL_QUESTION_KINDS),
      origin: Type.Literal('requested'),
      humanRequestId: IdSchemas.humanRequestId,
    }),
    /** A note slipped in while the run goes on: no request before it, no Turn after (M2Design 4.5). */
    closed({
      ...answeredContent,
      kind: Type.Literal('steer'),
      targetAgentRunId: Type.Optional(IdSchemas.agentRunId),
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

export const RunPausedSchema = closed(
  { type: Type.Literal('RunPaused') },
  'kernel.unit.RunPaused.v1',
);
export type RunPaused = Static<typeof RunPausedSchema>;

/** `steer` is the note added while continuing; Workflow turns it into a HUMAN(steer) first. */
export const RunResumedSchema = closed(
  {
    type: Type.Literal('RunResumed'),
    steer: Type.Optional(
      closed({
        inputId: IdSchemas.inputId,
        contentRef: ArtifactRefSchema,
        targetAgentRunId: Type.Optional(IdSchemas.agentRunId),
      }),
    ),
  },
  'kernel.unit.RunResumed.v1',
);
export type RunResumed = Static<typeof RunResumedSchema>;

/** A question that waited for the user is gone because the run was interrupted. */
export const HumanCancelledSchema = closed(
  {
    type: Type.Literal('HumanCancelled'),
    humanRequestId: IdSchemas.humanRequestId,
    nodeId: IdSchemas.nodeId,
    reason: Type.Enum(INTERRUPT_REASONS),
  },
  'kernel.unit.HumanCancelled.v1',
);
export type HumanCancelled = Static<typeof HumanCancelledSchema>;

/** Kernel asks for the material of a compaction: Workflow answers with `reportCompactionSource`. */
export const CompactionSourceQuerySchema = closed(
  {
    type: Type.Literal('CompactionSourceQuery'),
    compactionId: IdSchemas.compactionId,
    target: CompactionTargetSchema,
  },
  'kernel.unit.CompactionSourceQuery.v1',
);
export type CompactionSourceQuery = Static<typeof CompactionSourceQuerySchema>;

/** Tool results were cut; Workflow records `TOOL_RESULTS_PRUNED`, then `ackCompaction(PRUNE)`. */
export const ToolResultsPrunedSchema = closed(
  {
    type: Type.Literal('ToolResultsPruned'),
    compactionId: IdSchemas.compactionId,
    target: CompactionTargetSchema,
    items: Type.Array(PrunedItemSchema, { minItems: 1 }),
  },
  'kernel.unit.ToolResultsPruned.v1',
);
export type ToolResultsPruned = Static<typeof ToolResultsPrunedSchema>;

/**
 * A summary was written; Workflow records `CONTEXT_COMPACTED`, then `ackCompaction(SUMMARY)`.
 * `keptSeqs` are the user messages of the range that stay as they are (M2Design 9.6, the tiers).
 */
export const ContextCompactedForWorkflowSchema = closed(
  {
    type: Type.Literal('ContextCompacted'),
    compactionId: IdSchemas.compactionId,
    target: CompactionTargetSchema,
    fromSeq: count(1),
    toSeq: count(1),
    keptSeqs: Type.Array(count(1)),
    summaryRef: ArtifactRefSchema,
    summaryInput: CompactionSummaryInputSchema,
    usage: CompactionUsageSchema,
  },
  'kernel.unit.ContextCompacted.v1',
);
export type ContextCompactedForWorkflow = Static<typeof ContextCompactedForWorkflowSchema>;

export const KernelToWorkflowEventSchema = Type.Union([
  RunStartSchema,
  UnitReportSchema,
  HumanAnsweredSchema,
  TurnClosedSchema,
  RunClosedSchema,
  WorkspaceRevertedSchema,
  WorkspaceDivergedSchema,
  RunInterruptedSchema,
  RunPausedSchema,
  RunResumedSchema,
  HumanCancelledSchema,
  CompactionSourceQuerySchema,
  ToolResultsPrunedSchema,
  ContextCompactedForWorkflowSchema,
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
