import { Type, type Static } from 'typebox';
import { PROTECTED_CAPABILITIES, pinnedRefOf } from '../catalog/definition-schemas.js';
import { WorkflowRunFailureSchema } from '../kernel-control/run-outcome.js';
import { LOCAL_QUESTION_KINDS, localQuestionProperties } from '../kernel-control/human-request.js';
import { ThinkingEffortSchema } from '../executor/model-call.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { pathDerivedId } from '../platform-common/new-id.js';
import { Sha256Schema, closed, count, text } from '../platform-common/schema-helpers.js';
import { ContextHistoryEntrySchema } from '../context/history-entry.js';
import { UnitInputSchema } from './unit-io.js';

const inRun = {
  requestId: IdSchemas.requestId,
  sessionId: IdSchemas.sessionId,
  workflowRunId: IdSchemas.workflowRunId,
};

export const RegisterAgentRunRequestSchema = closed(
  {
    ...inRun,
    agentRunId: IdSchemas.agentRunId,
    nodeId: IdSchemas.nodeId,
    agentRef: pinnedRefOf('AGENT'),
    effort: ThinkingEffortSchema,
    workspaceViewId: Type.Literal('main'),
    display: closed({ label: text(80) }),
    /** May only narrow the ceiling, or registration is CAPABILITY_NOT_SUBSET (Kernel/Core 5a.1). */
    requestedCapabilities: Type.Array(Type.Enum(PROTECTED_CAPABILITIES), { uniqueItems: true }),
    /** Relative to the repository root; main has `['.']`, and none without `workspace.write`. */
    writeRoots: Type.Array(text(1024)),
    /**
     * A SubAgent names the AgentRun that spawned it, the reservation that funds it and its task in
     * that reservation: all three or none (M2Design 6.4, 7.3; Kernel/Core 5d).
     */
    parentAgentRunId: Type.Optional(IdSchemas.agentRunId),
    delegationId: Type.Optional(IdSchemas.delegationId),
    taskName: Type.Optional(text(64)),
    /**
     * The task this AgentRun is a segment of, and its parent task (Orchestration 8.1). The first
     * segment of a task opens its MissionScope; a later one registers into it. A segment of a task
     * that is not the root names its parent; the first segment of a spawned task also names the
     * delegation and task it was funded by. Without it, the AgentRun is a task of its own.
     */
    mission: Type.Optional(
      closed({
        missionId: IdSchemas.missionScopeId,
        parentMissionId: Type.Optional(IdSchemas.missionScopeId),
      }),
    ),
  },
  'kernel.unit.RegisterAgentRunRequest.v1',
);
export type RegisterAgentRunRequest = Static<typeof RegisterAgentRunRequestSchema>;

/** One task of a `run_subagents` call, as far as the Kernel needs to know it. */
export const DelegationTaskSchema = closed({
  name: text(64),
  agentRef: pinnedRefOf('AGENT'),
  /** Relative to the repository root; empty for an AgentRun that does not write. */
  writeRoots: Type.Array(text(1024)),
  /** Asked for; the Kernel keeps it between the Agent's minimum share and twice its default. */
  tokens: Type.Optional(count(1)),
});
export type DelegationTask = Static<typeof DelegationTaskSchema>;

export const MAX_DELEGATION_TASKS = 12;

/** Takes the shares of all tasks out of the parent's ledger, or none (M2Design 7.3, rule 2). */
export const ReserveDelegationRequestSchema = closed(
  {
    ...inRun,
    parentAgentRunId: IdSchemas.agentRunId,
    tasks: Type.Array(DelegationTaskSchema, { minItems: 1, maxItems: MAX_DELEGATION_TASKS }),
  },
  'kernel.unit.ReserveDelegationRequest.v1',
);
export type ReserveDelegationRequest = Static<typeof ReserveDelegationRequestSchema>;

/** What the tasks got; a share the Kernel moved to the limits of the Agent says which limit. */
export const DelegationReservedSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    delegationId: IdSchemas.delegationId,
    shares: Type.Array(
      closed({
        name: text(64),
        tokens: count(1),
        clamped: Type.Optional(Type.Enum(['MIN', 'MAX'])),
      }),
    ),
  },
  'kernel.unit.DelegationReserved.v1',
);
export type DelegationReserved = Static<typeof DelegationReservedSchema>;

/** Gives back the shares of the tasks that never registered (skipped, or refused). */
export const ReleaseDelegationRequestSchema = closed(
  { ...inRun, delegationId: IdSchemas.delegationId },
  'kernel.unit.ReleaseDelegationRequest.v1',
);
export type ReleaseDelegationRequest = Static<typeof ReleaseDelegationRequestSchema>;

/**
 * Keeps results that a handover carries for as long as the Session lives, so that what was handed
 * over can still be read after the days an output is otherwise kept (Kernel/Core 5g).
 */
/**
 * Asks the Kernel to wake a sleeping task after `seconds` (Orchestration 4.2, 8.5): time is the
 * Kernel's. When it is due, the Kernel sends `WakeDue`; a timer does not outlive its run.
 */
export const ScheduleWakeRequestSchema = closed(
  {
    ...inRun,
    missionId: IdSchemas.missionScopeId,
    timerId: text(160),
    seconds: Type.Integer({ minimum: 1, maximum: 3600 }),
  },
  'kernel.unit.ScheduleWakeRequest.v1',
);
export type ScheduleWakeRequest = Static<typeof ScheduleWakeRequestSchema>;

export const RetainArtifactsRequestSchema = closed(
  { ...inRun, refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 21 }) },
  'kernel.unit.RetainArtifactsRequest.v1',
);
export type RetainArtifactsRequest = Static<typeof RetainArtifactsRequestSchema>;

/** The material of a compaction: the projection of the target as it is now (Interface/WorkflowKernel 2.4). */
export const ReportCompactionSourceRequestSchema = closed(
  {
    ...inRun,
    compactionId: IdSchemas.compactionId,
    entries: Type.Array(ContextHistoryEntrySchema),
  },
  'kernel.unit.ReportCompactionSourceRequest.v1',
);
export type ReportCompactionSourceRequest = Static<typeof ReportCompactionSourceRequestSchema>;

/** The result of a compaction is in the log (`RECORDED`), or could not be put there (`FAILED`). */
export const AckCompactionRequestSchema = closed(
  {
    ...inRun,
    compactionId: IdSchemas.compactionId,
    stage: Type.Enum(['PRUNE', 'SUMMARY']),
    outcome: Type.Enum(['RECORDED', 'FAILED']),
  },
  'kernel.unit.AckCompactionRequest.v1',
);
export type AckCompactionRequest = Static<typeof AckCompactionRequestSchema>;

const matchesPath = (request: { requestId: string; path: string }) =>
  request.requestId === pathDerivedId('req', request.path);
const matchesUnitRun = (request: { unitRunId: string; path: string }) =>
  request.unitRunId === pathDerivedId('unr', request.path.replace(/#[0-9]+$/u, ''));

/** The `requestId` and `unitRunId` come from `path`, so a replayed log rebuilds them. */
export const SubmitUnitRequestSchema = Type.Refine(
  closed(
    {
      ...inRun,
      agentRunId: IdSchemas.agentRunId,
      unitRunId: IdSchemas.unitRunId,
      path: text(512),
      unitRef: pinnedRefOf('UNIT'),
      input: UnitInputSchema,
      display: closed({ toolName: text(64), argsSummary: text(80, 0) }),
    },
    'kernel.unit.SubmitUnitRequest.v1',
  ),
  (request) => matchesPath(request) && matchesUnitRun(request),
  () => 'requestId and unitRunId must be derived from path',
);
export type SubmitUnitRequest = Static<typeof SubmitUnitRequestSchema>;

export const EndAgentRunRequestSchema = closed(
  {
    ...inRun,
    agentRunId: IdSchemas.agentRunId,
    /**
     * The segment went to wait and its task goes on (Orchestration 4.1): the MissionScope stays open,
     * with its ledger and write roots. Absent or false, the task ends with this AgentRun.
     */
    missionContinues: Type.Optional(Type.Boolean()),
  },
  'kernel.unit.EndAgentRunRequest.v1',
);
export type EndAgentRunRequest = Static<typeof EndAgentRunRequestSchema>;

export const CloseRunRequestSchema = Type.Union(
  [
    closed({
      ...inRun,
      outcome: Type.Enum(['COMPLETED', 'BUDGET', 'CANCELLED', 'TIMEOUT', 'INTERRUPTED']),
      resultRef: Type.Optional(ArtifactRefSchema),
    }),
    closed({ ...inRun, outcome: Type.Literal('FAILED'), failure: WorkflowRunFailureSchema }),
  ],
  { $id: 'kernel.unit.CloseRunRequest.v1' },
);
export type CloseRunRequest = Static<typeof CloseRunRequestSchema>;

const requestHuman = {
  ...inRun,
  humanRequestId: IdSchemas.humanRequestId,
  nodeId: IdSchemas.nodeId,
};
/** Open input, which needs stillness, or a local question attached to the AgentRun that asked. */
export const RequestHumanRequestSchema = Type.Union(
  [
    closed({ ...requestHuman, kind: Type.Literal('prompt') }),
    closed({
      ...requestHuman,
      kind: Type.Enum(LOCAL_QUESTION_KINDS),
      ...localQuestionProperties,
    }),
  ],
  { $id: 'kernel.unit.RequestHumanRequest.v1' },
);
export type RequestHumanRequest = Static<typeof RequestHumanRequestSchema>;

/** `AGENTS.md` at the root or below it, with no `.` or `..` segment and no empty one. */
const INSTRUCTIONS_PATH = '(?:(?!\\.\\.?/)[^/]+/)*AGENTS\\.md';

/** Only `AGENTS.md` and repository templates; whether it may be read is decided behind this. */
export const ReadProjectFileRequestSchema = closed(
  {
    ...inRun,
    path: Type.String({
      pattern: `^(?:${INSTRUCTIONS_PATH}|\\.multiagentos/workflows/[a-z0-9][a-z0-9-]{0,63}\\.yaml)$`,
      maxLength: 512,
    }),
  },
  'kernel.unit.ReadProjectFileRequest.v1',
);
export type ReadProjectFileRequest = Static<typeof ReadProjectFileRequestSchema>;

const accepted = { requestId: IdSchemas.requestId, outcome: Type.Literal('ACCEPTED') };
export const ProjectFileContentSchema = Type.Union(
  [
    closed({ ...accepted, path: text(512), exists: Type.Literal(false) }),
    closed({
      ...accepted,
      path: Type.String({ pattern: `^${INSTRUCTIONS_PATH}$`, maxLength: 512 }),
      exists: Type.Literal(true),
      ref: ArtifactRefSchema,
      sha256: Sha256Schema,
      trusted: Type.Boolean(),
    }),
    closed({
      ...accepted,
      path: text(512),
      exists: Type.Literal(true),
      ref: ArtifactRefSchema,
      sha256: Sha256Schema,
      text: Type.String(),
    }),
  ],
  { $id: 'kernel.unit.ProjectFileContent.v1' },
);
export type ProjectFileContent = Static<typeof ProjectFileContentSchema>;

/** Only for the interface: Kernel puts it into the ActivityEvents as it is (WorkflowKernel 2.5). */
export const UpdateActivityRequestSchema = closed(
  {
    ...inRun,
    agentRunId: IdSchemas.agentRunId,
    todos: closed({
      total: Type.Integer({ minimum: 0, maximum: 30 }),
      completed: Type.Integer({ minimum: 0, maximum: 30 }),
      current: Type.Optional(text(80)),
    }),
  },
  'kernel.unit.UpdateActivityRequest.v1',
);
export type UpdateActivityRequest = Static<typeof UpdateActivityRequestSchema>;
