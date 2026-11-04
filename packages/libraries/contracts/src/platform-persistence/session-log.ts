import { Type, type Static, type TProperties } from 'typebox';
import { WrapUpReasonSchema } from '../context/history-entry.js';
import { DefinitionRefSchema, PinnedDefinitionRefSchema } from '../catalog/definition-schemas.js';
import { TokenUsageSchema, ThinkingEffortSchema } from '../executor/model-call.js';
import { CLOSE_REASONS } from '../kernel-control/run-outcome.js';
import { BudgetViewSchema, TurnUsageSchema } from '../kernel-unit/budget-state.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas, ToolCallIdSchema } from '../platform-common/ids.js';
import { ReasonCodeSchema } from '../platform-common/reason-code.js';
import {
  Sha256Schema,
  TimestampSchema,
  closed,
  count,
  text,
} from '../platform-common/schema-helpers.js';

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
});
export type GraphNodeRecord = Static<typeof GraphNodeRecordSchema>;

export const GraphEdgeRecordSchema = closed({
  from: IdSchemas.nodeId,
  to: IdSchemas.nodeId,
  kind: Type.Enum(['DEPENDS', 'CONDITIONAL']),
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
      source: Type.Enum(['TEMPLATE', 'CHAT_GROWTH', 'LOOP', 'SPAWN']),
      nodes: Type.Array(GraphNodeRecordSchema),
      edges: Type.Array(GraphEdgeRecordSchema),
    }),
    record('NODE_STARTED', inTurn, { nodeId: IdSchemas.nodeId, path: text(512) }),
    record('NODE_ENDED', inTurn, {
      nodeId: IdSchemas.nodeId,
      status: Type.Enum(['SUCCEEDED', 'FAILED', 'SKIPPED', 'INTERRUPTED']),
      skipReason: Type.Optional(Type.Enum(['DEPENDENCY_FAILED', 'NOT_TAKEN'])),
      resultRef: Type.Optional(ArtifactRefSchema),
      /** The structured result conditions read, such as a planner's `action`. */
      result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    record('HUMAN_REQUESTED', inTurn, {
      humanRequestId: IdSchemas.humanRequestId,
      nodeId: IdSchemas.nodeId,
      kind: Type.Literal('prompt'),
    }),
    record('HUMAN_ANSWERED', inTurn, {
      nodeId: IdSchemas.nodeId,
      humanRequestId: Type.Optional(IdSchemas.humanRequestId),
      kind: Type.Literal('prompt'),
      origin: Type.Enum(['initial', 'requested']),
      inputId: IdSchemas.inputId,
      contentRef: ArtifactRefSchema,
      attachedAgentRunId: Type.Optional(IdSchemas.agentRunId),
    }),
    record('AGENT_RUN_REGISTERED', inTurn, {
      agentRunId: IdSchemas.agentRunId,
      nodeId: IdSchemas.nodeId,
      agentRef: PinnedDefinitionRefSchema,
      effort: ThinkingEffortSchema,
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
      message: text(1000),
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
        done: count(),
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
