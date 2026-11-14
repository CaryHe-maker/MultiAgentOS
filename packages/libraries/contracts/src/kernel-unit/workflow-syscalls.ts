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
import {
  JOB_READ_MAX_BYTES,
  JobControlResultSchema,
} from '../kernel-execution/supervisor-requests.js';

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
    /**
     * The capabilities the tools are offered by, when they are more than the AgentRun may use: a
     * task that inherits the context of its caller is offered the caller's tools, so the request
     * has the prefix the provider cached, and a call beyond its own ceiling is refused
     * (Orchestration 3.9, D35). The requested ones when absent.
     */
    offeredCapabilities: Type.Optional(
      Type.Array(Type.Enum(PROTECTED_CAPABILITIES), { uniqueItems: true }),
    ),
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

/**
 * Reads or stops a background command of a task (Orchestration 6.2). Workflow keeps which task a
 * job belongs to and where its last read ended; the Kernel only passes it to the Supervisor.
 */
export const ControlJobRequestSchema = closed(
  {
    ...inRun,
    jobKey: IdSchemas.executionId,
    action: Type.Enum(['READ', 'STOP']),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: JOB_READ_MAX_BYTES })),
  },
  'kernel.unit.ControlJobRequest.v1',
);
export type ControlJobRequest = Static<typeof ControlJobRequestSchema>;

/** What makes a checkpoint inside a run (Orchestration 7.2); each input of the user is one of its own. */
export const CHECKPOINT_KINDS = ['ROOT_SPAWN', 'HUMAN_ANSWER', 'TEMPLATE'] as const;

/**
 * Asks for a checkpoint (Orchestration 7.3): the Kernel holds new writes and foreground commands,
 * waits for those in flight, takes a snapshot, and answers `CheckpointTaken`. Reads, the web and
 * model calls go on meanwhile; background commands are not waited for.
 */
export const TakeCheckpointRequestSchema = closed(
  {
    ...inRun,
    checkpointId: IdSchemas.checkpointId,
    kind: Type.Enum(CHECKPOINT_KINDS),
    label: text(200),
  },
  'kernel.unit.TakeCheckpointRequest.v1',
);
export type TakeCheckpointRequest = Static<typeof TakeCheckpointRequestSchema>;

/**
 * Cancels what one AgentRun has queued or running (Orchestration 5.1, 5.2): its task was stopped
 * or interrupted by its parent. Each Unit answers INTERRUPTED(ABORTED); the run goes on.
 */
export const HaltAgentRunRequestSchema = closed(
  { ...inRun, agentRunId: IdSchemas.agentRunId },
  'kernel.unit.HaltAgentRunRequest.v1',
);
export type HaltAgentRunRequest = Static<typeof HaltAgentRunRequestSchema>;

/**
 * Opens again a task that ended after the cut a rewind went back to (Orchestration 7.5): it is as it
 * was then, open and asleep, with no segment running. A funded task gets its share again from its
 * parent, as much of it as the parent can still lend; its write roots are held again.
 */
export const RestoreMissionRequestSchema = closed(
  {
    ...inRun,
    missionId: IdSchemas.missionScopeId,
    /** The share it had; absent for a task that spends from its parent's ledger. */
    tokens: Type.Optional(count(1)),
  },
  'kernel.unit.RestoreMissionRequest.v1',
);
export type RestoreMissionRequest = Static<typeof RestoreMissionRequestSchema>;

/**
 * Closes a task that sleeps and will not wake (Orchestration 5.1, 7.5): it was stopped, or a rewind
 * took it back. Its write roots are given back and the unused part of its share returns to its
 * parent, as when its last segment ends. A task already closed is left as it is.
 */
export const CloseMissionRequestSchema = closed(
  { ...inRun, missionId: IdSchemas.missionScopeId },
  'kernel.unit.CloseMissionRequest.v1',
);
export type CloseMissionRequest = Static<typeof CloseMissionRequestSchema>;

/**
 * Takes back a local question nobody will wait for any more (Orchestration 5.1, 7.5): the task that
 * asked was stopped, or a rewind asks it again. The user is told it is gone. One already answered
 * or gone is left as it is.
 */
export const WithdrawQuestionRequestSchema = closed(
  { ...inRun, humanRequestId: IdSchemas.humanRequestId },
  'kernel.unit.WithdrawQuestionRequest.v1',
);
export type WithdrawQuestionRequest = Static<typeof WithdrawQuestionRequestSchema>;

/**
 * A chat's main waits for the user, and a background command of the work has ended (Orchestration
 * 4.4, D12): the open input is taken back, and work without an input of the user opens, named by
 * `checkpointId`, which is taken first. Refused when the run no longer waits on this request (the
 * user has just answered): the notice then comes with that answer.
 */
export const WithdrawOpenInputRequestSchema = closed(
  { ...inRun, humanRequestId: IdSchemas.humanRequestId, checkpointId: IdSchemas.checkpointId },
  'kernel.unit.WithdrawOpenInputRequest.v1',
);
export type WithdrawOpenInputRequest = Static<typeof WithdrawOpenInputRequestSchema>;

export const JobControlContentSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    result: JobControlResultSchema,
  },
  'kernel.unit.JobControlContent.v1',
);
export type JobControlContent = Static<typeof JobControlContentSchema>;

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
    /**
     * The segment went to wait for the answer to its own question (`ask_user` as a sleep,
     * Orchestration 4.1): the question stays open after the AgentRun ends, and its answer wakes the
     * task. Absent, the questions of the AgentRun end with it.
     */
    keepsQuestions: Type.Optional(Type.Boolean()),
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
      /**
       * Asked again after a rewind to before its answer (Orchestration 7.5): the AgentRun that asked
       * has ended, and its task sleeps until the answer.
       */
      askedAgain: Type.Optional(Type.Boolean()),
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
    todos: Type.Optional(
      closed({
        total: Type.Integer({ minimum: 0, maximum: 30 }),
        completed: Type.Integer({ minimum: 0, maximum: 30 }),
        current: Type.Optional(text(80)),
      }),
    ),
    /**
     * A control call the AgentRun made (send_message, sleep, run_subagents, ...): it runs no Unit,
     * so the interface shows it as a line of its own, like a finished tool.
     */
    step: Type.Optional(closed({ toolName: text(64), argsSummary: text(80, 0) })),
  },
  'kernel.unit.UpdateActivityRequest.v1',
);
export type UpdateActivityRequest = Static<typeof UpdateActivityRequestSchema>;
