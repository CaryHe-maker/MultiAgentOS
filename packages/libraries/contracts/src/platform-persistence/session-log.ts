import { Type, type Static, type TProperties } from 'typebox';
import {
  CompactionSummaryInputSchema,
  CompactionTargetSchema,
  CompactionUsageSchema,
  PrunedItemSchema,
} from '../context/compaction.js';
import { WrapUpReasonSchema } from '../context/history-entry.js';
import { DefinitionRefSchema, PinnedDefinitionRefSchema } from '../catalog/definition-schemas.js';
import { TokenUsageSchema, ThinkingEffortSchema } from '../executor/model-call.js';
import { INTERRUPT_REASONS } from '../kernel-control/interrupt.js';
import {
  HUMAN_REQUEST_KINDS,
  HumanFieldSchema,
  LOCAL_QUESTION_KINDS,
  MAX_QUESTION_CHARS,
  MAX_QUESTION_FIELDS,
} from '../kernel-control/human-request.js';
import { CLOSE_REASONS } from '../kernel-control/run-outcome.js';
import { BudgetViewSchema, TurnUsageSchema } from '../kernel-unit/budget-state.js';
import { JobExitSchema } from '../kernel-execution/supervisor-requests.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas, ReferenceIdSchema, ToolCallIdSchema } from '../platform-common/ids.js';
import { ReasonCodeSchema } from '../platform-common/reason-code.js';
import {
  Sha256Schema,
  TimestampSchema,
  closed,
  count,
  text,
} from '../platform-common/schema-helpers.js';

/**
 * What a task of `run_subagents` adds to its node (M2Design 3.6). Who called it, and under which
 * delegation, is on the `DELEGATE` edge that leads to it.
 */
export const SpawnNodeSchema = closed({
  writeScope: Type.Array(text(500), { maxItems: 10 }),
  /** What the task is responsible for, in one line (Orchestration 3.7). */
  role: Type.Optional(text(80)),
  /** False when the caller lent the scope without commands (D17). */
  commands: Type.Optional(Type.Boolean()),
  acceptance: Type.Array(text(300), { maxItems: 10 }),
  inputs: Type.Array(ArtifactRefSchema, { maxItems: 10 }),
  effort: Type.Optional(ThinkingEffortSchema),
  /** The share of budget reserved for it, after the Kernel clamped the request. */
  tokens: count(1),
  clamped: Type.Optional(Type.Enum(['MIN', 'MAX'])),
});
export type SpawnNode = Static<typeof SpawnNodeSchema>;

/**
 * The task (MissionTree node) an AGENT node is a segment of (Orchestration 3.2): written when the
 * node is made, with the parent task, so the tree is read from the graph and never inferred. The
 * root task of a graph has no `parentId`.
 */
export const NodeMissionSchema = closed({
  id: IdSchemas.missionScopeId,
  parentId: Type.Optional(IdSchemas.missionScopeId),
});
export type NodeMission = Static<typeof NodeMissionSchema>;

/** What wakes a task that slept (Orchestration 4.2); several are alternatives. */
export const WakeConditionSchema = Type.Union([
  closed({
    kind: Type.Literal('children'),
    mode: Type.Enum(['all', 'any']),
    names: Type.Optional(Type.Array(text(64), { minItems: 1, maxItems: 12 })),
  }),
  closed({
    kind: Type.Literal('siblings'),
    mode: Type.Enum(['all', 'any']),
    names: Type.Optional(Type.Array(text(64), { minItems: 1, maxItems: 12 })),
  }),
  closed({
    kind: Type.Literal('jobs'),
    mode: Type.Enum(['all', 'any']),
    jobIds: Type.Optional(Type.Array(text(32), { minItems: 1, maxItems: 8 })),
  }),
  closed({ kind: Type.Literal('message') }),
  closed({ kind: Type.Literal('timer'), seconds: count(1) }),
  closed({ kind: Type.Literal('human'), nodeId: IdSchemas.nodeId }),
]);
export type WakeCondition = Static<typeof WakeConditionSchema>;

/** Node and edge of a GraphRevision as the log stores them (M2Design 3.1, 3.2). */
export const GraphNodeRecordSchema = closed({
  nodeId: IdSchemas.nodeId,
  path: text(512),
  name: text(64),
  kind: Type.Enum(['AGENT', 'HUMAN']),
  trigger: Type.Enum(['all_success', 'all_done']),
  iteration: count(1),
  loopId: Type.Optional(text(64)),
  agentRef: Type.Optional(DefinitionRefSchema),
  goal: Type.Optional(text(4000)),
  inputFrom: Type.Optional(Type.Literal('HANDOFF')),
  output: Type.Optional(Type.Boolean()),
  /** Of an AGENT node: the task it is a segment of. */
  mission: Type.Optional(NodeMissionSchema),
  spawn: Type.Optional(SpawnNodeSchema),
  /** A HUMAN node that asks the user something for the AgentRun that called `ask_user`. */
  ask: Type.Optional(
    closed({
      kind: Type.Enum(LOCAL_QUESTION_KINDS),
      question: text(MAX_QUESTION_CHARS),
      fields: Type.Optional(Type.Array(HumanFieldSchema, { maxItems: MAX_QUESTION_FIELDS })),
      reviewRef: Type.Optional(ArtifactRefSchema),
    }),
  ),
});
export type GraphNodeRecord = Static<typeof GraphNodeRecordSchema>;

/**
 * One call that suspends an AgentRun until the nodes it dispatched have ended: the model's tool call
 * and the Kernel's reservation that funds it. Shared by the `DELEGATE` and `RESUME` edges of the call.
 */
export const EdgeCallSchema = closed({
  toolCallId: ToolCallIdSchema,
  /** The Kernel's reservation that funds a call to SubAgents; a question to the user has none. */
  delegationId: Type.Optional(IdSchemas.delegationId),
});
export type EdgeCall = Static<typeof EdgeCallSchema>;

export const GraphEdgeRecordSchema = closed({
  from: IdSchemas.nodeId,
  to: IdSchemas.nodeId,
  /**
   * `DELEGATE`: from a caller to a node it dispatched. `RESUME`: back from a question to the caller
   * that waits for it (M2Design 3.1). Both carry `call`. `CONTINUES`: from a segment that slept to
   * the segment that took over when its task woke (Orchestration 3.2); no readiness follows it.
   */
  kind: Type.Enum(['DEPENDS', 'CONDITIONAL', 'DELEGATE', 'RESUME', 'CONTINUES']),
  call: Type.Optional(EdgeCallSchema),
  when: Type.Optional(
    closed({
      field: text(128),
      equals: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
      in: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Boolean()]))),
    }),
  ),
});
export type GraphEdgeRecord = Static<typeof GraphEdgeRecordSchema>;

const base = {
  seq: count(1),
  at: TimestampSchema,
};
const inRun = { ...base, workflowRunId: IdSchemas.workflowRunId };
const inTurn = { ...inRun, turnId: Type.Optional(IdSchemas.turnId) };
const record = <T extends string, C extends TProperties, P extends TProperties>(
  type: T,
  common: C,
  fields: P,
) => closed({ ...common, type: Type.Literal(type), ...fields });

/**
 * Who gives or takes a handover: the main Agent of a chat, one AgentRun, or a task, whichever of
 * its segments reads it (Orchestration 3.4).
 */
export const HandoverPartySchema = Type.Union([
  closed({ kind: Type.Literal('MAIN') }),
  closed({ kind: Type.Literal('AGENT_RUN'), agentRunId: IdSchemas.agentRunId }),
  closed({ kind: Type.Literal('MISSION'), missionId: IdSchemas.missionScopeId }),
]);
export type HandoverParty = Static<typeof HandoverPartySchema>;

/** The most results one handover carries: the result of the task and what it listed. */
export const MAX_HANDOVER_ITEMS = 21;

const InputSourceSchema = Type.Union([
  closed({
    kind: Type.Literal('TOOL_CALL'),
    modelTurnRequestId: IdSchemas.requestId,
    toolCallId: ToolCallIdSchema,
    workflowFields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  closed({ kind: Type.Literal('STRUCTURED'), input: Type.Unknown() }),
]);

/**
 * One line of `log.v1.jsonl` (Interface/Persistence 2). Structured fields and artifact
 * references only, never a body. An unknown `type` fails the Schema, which refuses the log.
 */
export const SessionLogRecordSchema = Type.Union(
  [
    record('SESSION_STARTED', base, {
      formatVersion: Type.Literal(1),
      repositoryRoot: text(4096),
      definitionsDigest: Sha256Schema,
      definitionVersions: Type.Array(text(160)),
      /** What the probe found (M2Design 6.2); absent in a log from before commands. */
      sandbox: Type.Optional(
        closed({
          state: Type.Enum(['ISOLATED', 'UNISOLATED', 'UNAVAILABLE']),
          reason: Type.Optional(Type.Enum(['NO_BWRAP', 'USERNS_DENIED', 'PROFILE_FAILED'])),
        }),
      ),
    }),
    /**
     * The Session is now worked on in another folder (M2Design 2.3). Everything of the Session that
     * belongs to a folder starts again from here: file baselines, project instructions, the
     * snapshots and what can be undone. What is kept is the conversation and its artifacts.
     */
    record('WORKSPACE_BOUND', base, {
      repositoryRoot: text(4096),
      previousRoot: text(4096),
    }),
    record('WORKFLOW_RUN_STARTED', inRun, {
      mode: Type.Enum(['CHAT', 'ORCHESTRATION']),
      templateRef: Type.Optional(DefinitionRefSchema),
      preset: Type.Enum(['standard', 'readonly']),
      initialInput: Type.Boolean(),
    }),
    record('WORKFLOW_RUN_ENDED', inRun, {
      closeReason: Type.Enum([...CLOSE_REASONS, 'PROCESS_EXITED', 'FORKED']),
    }),
    record('TURN_STARTED', inTurn, {
      promptNodeId: IdSchemas.nodeId,
      template: Type.Optional(DefinitionRefSchema),
    }),
    record('TURN_ENDED', inTurn, {
      reason: Type.Enum([
        'COMPLETED',
        'ABORTED',
        'TIMEOUT',
        'BUDGET',
        'RUN_CLOSED',
        'PROCESS_EXITED',
      ]),
      usage: Type.Optional(TurnUsageSchema),
    }),
    record('GRAPH_EXTENDED', inTurn, {
      revision: count(1),
      source: Type.Enum(['TEMPLATE', 'CHAT_GROWTH', 'LOOP', 'SPAWN', 'STEER', 'ASK', 'WAKE']),
      nodes: Type.Array(GraphNodeRecordSchema),
      edges: Type.Array(GraphEdgeRecordSchema),
    }),
    record('NODE_STARTED', inTurn, { nodeId: IdSchemas.nodeId, path: text(512) }),
    /**
     * The `RESUME` edges of a call were followed: every node it dispatched has ended (M2Design 3.3).
     * The graph says the call came back; the AgentRun of the node, which waited, goes on.
     */
    record('NODE_RESUMED', inTurn, { nodeId: IdSchemas.nodeId, call: EdgeCallSchema }),
    record('NODE_ENDED', inTurn, {
      nodeId: IdSchemas.nodeId,
      /** `YIELDED`: the segment went to wait before its work was done; its task goes on. */
      status: Type.Enum(['SUCCEEDED', 'FAILED', 'SKIPPED', 'INTERRUPTED', 'YIELDED']),
      skipReason: Type.Optional(Type.Enum(['DEPENDENCY_FAILED', 'NOT_TAKEN'])),
      resultRef: Type.Optional(ArtifactRefSchema),
      /** The structured result conditions read, such as a planner's `action`. */
      result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    record('HUMAN_REQUESTED', inTurn, {
      humanRequestId: IdSchemas.humanRequestId,
      nodeId: IdSchemas.nodeId,
      kind: Type.Enum(HUMAN_REQUEST_KINDS),
      /** A local question (M2Design 4.2): who asked, and what. */
      attachedAgentRunId: Type.Optional(IdSchemas.agentRunId),
      question: Type.Optional(text(MAX_QUESTION_CHARS)),
      fields: Type.Optional(Type.Array(HumanFieldSchema, { maxItems: MAX_QUESTION_FIELDS })),
      reviewRef: Type.Optional(ArtifactRefSchema),
    }),
    record('HUMAN_ANSWERED', inTurn, {
      nodeId: IdSchemas.nodeId,
      humanRequestId: Type.Optional(IdSchemas.humanRequestId),
      kind: Type.Enum([...HUMAN_REQUEST_KINDS, 'steer']),
      /** `unrequested`: a steer, which nobody was waiting for. */
      origin: Type.Enum(['initial', 'requested', 'unrequested']),
      inputId: IdSchemas.inputId,
      contentRef: ArtifactRefSchema,
      attachedAgentRunId: Type.Optional(IdSchemas.agentRunId),
      /** A steer whose target had ended went to its parent; this is the target it was meant for. */
      redirectedFrom: Type.Optional(IdSchemas.agentRunId),
    }),
    record('AGENT_RUN_REGISTERED', inTurn, {
      agentRunId: IdSchemas.agentRunId,
      nodeId: IdSchemas.nodeId,
      agentRef: PinnedDefinitionRefSchema,
      effort: ThinkingEffortSchema,
      /** Of a SubAgent: the AgentRun that started it. */
      parentAgentRunId: Type.Optional(IdSchemas.agentRunId),
      /** The task this AgentRun is a segment of (Orchestration 3.4). */
      missionId: Type.Optional(IdSchemas.missionScopeId),
    }),
    /**
     * A segment went to wait before its work was done (Orchestration 4): it ends, its task sleeps
     * until one of `until` holds or `timeoutSeconds` pass. The note to the next segment is in the
     * model output, at `source`.
     */
    record('SEGMENT_YIELDED', inTurn, {
      nodeId: IdSchemas.nodeId,
      missionId: IdSchemas.missionScopeId,
      agentRunId: IdSchemas.agentRunId,
      until: Type.Array(WakeConditionSchema, { minItems: 1, maxItems: 8 }),
      timeoutSeconds: count(1),
      source: Type.Optional(
        closed({ modelTurnRequestId: IdSchemas.requestId, toolCallId: ToolCallIdSchema }),
      ),
    }),
    /** A task that slept is woken, by the events at these log positions (Orchestration 4.3). */
    record('MISSION_WOKEN', inTurn, {
      missionId: IdSchemas.missionScopeId,
      causes: Type.Array(
        closed({
          kind: Type.Enum([
            'CHILDREN',
            'SIBLINGS',
            'JOB',
            'MESSAGE',
            'TIMER',
            'TIMEOUT',
            'HUMAN',
            'STALLED',
            'ROLLED_BACK',
            'RESUMED',
            'INTERRUPTED',
          ]),
          seq: Type.Optional(count(1)),
        }),
        { minItems: 1, maxItems: 64 },
      ),
    }),
    /** A timer of a sleeping task is due (Orchestration 4.2): what a wake by time reads. */
    record('MISSION_TIMER_DUE', inTurn, {
      missionId: IdSchemas.missionScopeId,
      timerId: text(160),
    }),
    /** The one record that says a task has ended (Orchestration 3.2). */
    record('MISSION_ENDED', inTurn, {
      missionId: IdSchemas.missionScopeId,
      status: Type.Enum(['SUCCEEDED', 'FAILED', 'INTERRUPTED']),
    }),
    /**
     * A message from one task to others along the tree (Orchestration 5): the text is in the model
     * output of the sender, at `source`; it is material, never an instruction or a permission.
     */
    record('MISSION_MESSAGE', inTurn, {
      from: IdSchemas.missionScopeId,
      fromLabel: text(64),
      to: Type.Array(IdSchemas.missionScopeId, { minItems: 1, maxItems: 12 }),
      /** From a parent to its child: the child ends its round and starts again (D20). */
      interrupt: Type.Optional(Type.Boolean()),
      source: closed({
        modelTurnRequestId: IdSchemas.requestId,
        outputRef: ArtifactRefSchema,
        toolCallId: ToolCallIdSchema,
      }),
    }),
    /**
     * A command of a task runs on as a job (Orchestration 6.1): `jobId` is its name in the task,
     * `jobKey` the execution it detached from, `requestId` the Unit whose result said so.
     */
    record('JOB_STARTED', inTurn, {
      missionId: IdSchemas.missionScopeId,
      jobId: text(32),
      jobKey: IdSchemas.executionId,
      requestId: IdSchemas.requestId,
      command: text(200),
      promoted: Type.Boolean(),
    }),
    /** What a read of `job_output` reached: the next one goes on from there (Orchestration 6.2). */
    record('JOB_READ', inTurn, {
      missionId: IdSchemas.missionScopeId,
      jobId: text(32),
      nextOffset: count(),
    }),
    /** A job has ended (Orchestration 6.4); `tail` is the end of what it printed. */
    record('JOB_ENDED', inTurn, {
      missionId: IdSchemas.missionScopeId,
      jobId: text(32),
      exit: Type.Union([JobExitSchema, closed({ lost: Type.Literal(true) })]),
      durationMs: count(),
      totalBytes: count(),
      /** Where it was read up to when it ended: what the notice calls unread. */
      readUpTo: count(),
      tail: Type.String({ maxLength: 8192 }),
    }),
    record('AGENT_RUN_ENDED', inTurn, {
      agentRunId: IdSchemas.agentRunId,
      outcome: text(64),
      wrapUpReason: Type.Optional(text(64)),
    }),
    record('UNIT_SUBMITTED', inTurn, {
      requestId: IdSchemas.requestId,
      path: text(512),
      agentRunId: IdSchemas.agentRunId,
      unitRunId: IdSchemas.unitRunId,
      unitRef: PinnedDefinitionRefSchema,
      inputSource: InputSourceSchema,
    }),
    record('UNIT_COMPLETED', inTurn, {
      requestId: IdSchemas.requestId,
      status: Type.Enum(['OK', 'REJECTED', 'FAILED']),
      reasonCode: Type.Optional(ReasonCodeSchema),
      output: Type.Optional(Type.Unknown()),
      outputRef: Type.Optional(ArtifactRefSchema),
      fullRef: Type.Optional(ArtifactRefSchema),
      budget: BudgetViewSchema,
    }),
    record('UNIT_INTERRUPTED', inTurn, { requestId: IdSchemas.requestId, reason: text(200) }),
    record('MODEL_TURN', inTurn, {
      requestId: IdSchemas.requestId,
      agentRunId: IdSchemas.agentRunId,
      outputRef: ArtifactRefSchema,
      toolCalls: Type.Array(
        closed({
          toolName: text(128),
          toolCallId: ToolCallIdSchema,
          argsDigest: Sha256Schema,
        }),
      ),
      reasoningRef: Type.Optional(ArtifactRefSchema),
      replayable: Type.Boolean(),
      usage: Type.Optional(TokenUsageSchema),
    }),
    record('MODEL_ATTEMPT_FAILED', inTurn, {
      requestId: IdSchemas.requestId,
      reasonCode: ReasonCodeSchema,
    }),
    /** What the model is told instead of a result; a call must always get an answer. */
    record('FEEDBACK', inTurn, {
      agentRunId: IdSchemas.agentRunId,
      code: text(64),
      message: text(16000),
      toolCallId: Type.Optional(ToolCallIdSchema),
    }),
    record('PROJECT_FILE_LOADED', inRun, {
      path: text(512),
      ref: ArtifactRefSchema,
      sha256: Sha256Schema,
      trusted: Type.Optional(Type.Boolean()),
      /** Of a nested `AGENTS.md`: the projection that loaded it. */
      agentRunId: Type.Optional(IdSchemas.agentRunId),
    }),
    /** A nested `AGENTS.md` beyond the limit is noted, not read. */
    record('PROJECT_FILE_LOADED', inRun, {
      path: text(512),
      agentRunId: IdSchemas.agentRunId,
      skipped: Type.Literal('LIMIT'),
    }),
    record('TODOS_UPDATED', inTurn, {
      agentRunId: IdSchemas.agentRunId,
      source: closed({ modelTurnRequestId: IdSchemas.requestId, toolCallId: ToolCallIdSchema }),
      counts: closed({
        total: count(),
        pending: count(),
        inProgress: count(),
        completed: count(),
        cancelled: count(),
      }),
    }),
    record('WORKSPACE_REVERTED', inRun, {
      revertedTurnIds: Type.Array(IdSchemas.turnId, { minItems: 1 }),
      forced: Type.Boolean(),
      externalFiles: Type.Array(text(4096)),
      backupSnapshot: Type.Optional(text(64)),
    }),
    record('WORKSPACE_DIVERGED', inRun, { files: Type.Array(text(4096), { minItems: 1 }) }),
    record('SESSION_FORKED', base, {
      fromSessionId: IdSchemas.sessionId,
      fromSeq: count(),
    }),
    record('REQUEST_CONTEXT', inTurn, {
      agentRunId: IdSchemas.agentRunId,
      modelRef: DefinitionRefSchema,
      thinking: ThinkingEffortSchema,
      toolsDigest: Sha256Schema,
      runtimeContext: closed({
        workingDirectory: text(4096),
        sandbox: text(64),
        currentDate: Type.String({ format: 'date' }),
      }),
    }),
    record('CONTEXT_ASSEMBLED', inTurn, {
      requestId: IdSchemas.requestId,
      projectionDigest: Sha256Schema,
      headDigest: Sha256Schema,
      elidedEntries: Type.Optional(Type.Array(count(1))),
      tokenCount: count(),
      tokenBudget: count(1),
    }),
    /** The next model call of this AgentRun is its last, and why (M2Design 7.3). */
    /** The run was interrupted from outside the conversation (Module/Workflow 9.2a). */
    record('RUN_INTERRUPTED', inRun, { reason: Type.Enum(INTERRUPT_REASONS) }),
    /** The user paused the run, and resumed it, perhaps with a note (M2Design 4.3, 4.5). */
    record('RUN_PAUSED', inTurn, {}),
    record('RUN_RESUMED', inTurn, { steerInputId: Type.Optional(IdSchemas.inputId) }),
    /**
     * Results cut to head and tail for room (M2Design 9.6). The projection shows the cut result
     * from here on; the full output stays readable through `read_output`.
     */
    /**
     * Results one AgentRun hands to another, by what Workflow checked: the registry that
     * `read_output` reads the reference `referenceId/toolCallId` from (M2Design 3.7). Written
     * once, never changed; `to` is the only one who may read the items.
     */
    record('REFERENCES_REGISTERED', inTurn, {
      referenceId: ReferenceIdSchema,
      from: closed({ agentRunId: IdSchemas.agentRunId, label: text(64) }),
      to: HandoverPartySchema,
      items: Type.Array(
        closed({ toolCallId: ToolCallIdSchema, tool: text(128), ref: ArtifactRefSchema }),
        { minItems: 1, maxItems: MAX_HANDOVER_ITEMS },
      ),
    }),
    record('TOOL_RESULTS_PRUNED', inRun, {
      compactionId: IdSchemas.compactionId,
      target: CompactionTargetSchema,
      items: Type.Array(PrunedItemSchema, { minItems: 1 }),
    }),
    /**
     * `[fromSeq, toSeq]` of the log is replaced in the projection by the summary, except the
     * entries in `keptSeqs` (PINNED ones and the user messages Kernel chose); the projection must
     * not choose again.
     */
    record('CONTEXT_COMPACTED', inRun, {
      compactionId: IdSchemas.compactionId,
      target: CompactionTargetSchema,
      fromSeq: count(1),
      toSeq: count(1),
      keptSeqs: Type.Array(count(1)),
      summaryRef: ArtifactRefSchema,
      summaryInput: CompactionSummaryInputSchema,
      usage: CompactionUsageSchema,
    }),
    /** The Turns the summary covered were undone: it stands in for nothing any more. */
    record('CONTEXT_COMPACTION_REVOKED', inRun, {
      compactionId: IdSchemas.compactionId,
      reason: Type.Literal('TURN_REVERTED'),
    }),
    record('AGENT_WRAP_UP', inTurn, {
      agentRunId: IdSchemas.agentRunId,
      reason: WrapUpReasonSchema,
      round: count(1),
    }),
    record('AUTHORIZATION_REQUESTED', inRun, {
      questionId: IdSchemas.questionId,
      capability: text(64),
      resourceKeyDigest: Sha256Schema,
    }),
    record('AUTHORIZATION_DECIDED', inRun, {
      questionId: IdSchemas.questionId,
      capability: text(64),
      resourceKeyDigest: Sha256Schema,
      resolution: Type.Enum(['GRANTED', 'DECLINED', 'CANCELLED']),
    }),
    record('LOG_TAIL_REPAIRED', base, { truncatedBytes: count(1) }),
    record('STALE_UNITS_SETTLED', base, {
      requestIds: Type.Array(IdSchemas.requestId),
      turnIds: Type.Array(IdSchemas.turnId),
      workflowRunIds: Type.Array(IdSchemas.workflowRunId),
    }),
  ],
  { $id: 'platform.persistence.SessionLogRecord.v1' },
);
export type SessionLogRecord = Static<typeof SessionLogRecordSchema>;
export type SessionLogRecordType = SessionLogRecord['type'];
