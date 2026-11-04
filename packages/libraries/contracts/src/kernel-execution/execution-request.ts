import { Type, type Static, type TSchema } from 'typebox';
import {
  AssembleContextPackSchema,
  ModelToolSpecSchema,
  OrientContextPackSchema,
} from '../context/context-pack.js';
import { StatusFactsSchema } from '../context/history-entry.js';
import { ModelToolCallSchema } from '../executor/model-tool-call.js';
import { RepositoryListInputSchema } from '../executor/repository-list.js';
import { SEARCH_MODES } from '../context/repository.js';
import { FileReadInputSchema } from '../executor/file-read.js';
import { IdSchemas, ToolCallIdSchema } from '../platform-common/ids.js';
import { ReasonCodeSchema } from '../platform-common/reason-code.js';
import { ExclusionRuleSchema } from '../platform-common/repository-exclusions.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';

const RepositoryScopeSchema = closed({
  kind: Type.Literal('REPOSITORY'),
  /** The realpath of the repository root. */
  repositoryRoot: text(4096),
  exclusions: Type.Array(ExclusionRuleSchema),
});
const modelScope = {
  kind: Type.Literal('MODEL'),
  provider: text(64),
  apiModelId: text(128),
  apiProtocol: Type.Enum(['OPENAI_CHAT_COMPLETIONS', 'ANTHROPIC_MESSAGES']),
  baseUrl: Type.String({ pattern: '^https://[^\\s]+$', maxLength: 512 }),
};
/** `thinkingEffort` is present exactly when thinking is ENABLED. */
const ModelScopeSchema = Type.Union([
  closed({ ...modelScope, thinking: Type.Literal('DISABLED') }),
  closed({ ...modelScope, thinking: Type.Literal('ENABLED'), thinkingEffort: text(32) }),
]);
const NoScopeSchema = closed({ kind: Type.Literal('NONE') });
/** Derived by Core: REPOSITORY from the Lease, MODEL from the pinned Model and Agent. */
export const ExecutionScopeSchema = Type.Union(
  [RepositoryScopeSchema, ModelScopeSchema, NoScopeSchema],
  { $id: 'kernel.execution.ExecutionScope.v1' },
);
export type ExecutionScope = Static<typeof ExecutionScopeSchema>;

const limits = { deadline: TimestampSchema, maxOutputBytes: count(1) };

export const OrientExecutorInputSchema = closed(
  { objective: text(4000), tokenBudget: count(1) },
  'kernel.execution.OrientExecutorInput.v1',
);
export type OrientExecutorInput = Static<typeof OrientExecutorInputSchema>;

/** The search input with defaults filled in. */
export const SearchExecutorInputSchema = closed(
  {
    query: text(500),
    mode: Type.Enum(SEARCH_MODES),
    maxItems: Type.Integer({ minimum: 1, maximum: 50 }),
    tokenBudget: count(1),
  },
  'kernel.execution.SearchExecutorInput.v1',
);
export type SearchExecutorInput = Static<typeof SearchExecutorInputSchema>;

export type ExecutorInput = ExecutionRequest['input'];

/** `maxBytes` is `min(previewMaxBytes, maxOutputBytes)` (M2Design 8.2). */
const PreviewLimitsSchema = closed({ maxBytes: count(1), maxLines: count(1) });
const toolLimits = {
  ...limits,
  preview: PreviewLimitsSchema,
  maxFullOutputBytes: count(1),
};
const PlainLimitsSchema = closed(toolLimits);
const OrientLimitsSchema = closed({ ...toolLimits, maxFiles: count(1) });
const ModelLimitsSchema = closed({ ...limits, maxOutputTokens: count(1) });
const AssembleLimitsSchema = closed(limits);
export const ExecutionLimitsSchema = Type.Union(
  [PlainLimitsSchema, OrientLimitsSchema, ModelLimitsSchema, AssembleLimitsSchema],
  { $id: 'kernel.execution.ExecutionLimits.v1' },
);
export type ExecutionLimits = Static<typeof ExecutionLimitsSchema>;

const ResolvedHistoryEntrySchema = Type.Union([
  closed({
    seq: count(1),
    turnId: Type.Optional(IdSchemas.turnId),
    category: Type.Enum(['PINNED', 'NORMAL']),
    kind: Type.Enum(['HUMAN', 'NOTE']),
    text: Type.String(),
  }),
  closed({
    seq: count(1),
    turnId: Type.Optional(IdSchemas.turnId),
    category: Type.Enum(['PINNED', 'NORMAL']),
    kind: Type.Literal('MODEL_TURN'),
    text: Type.Optional(Type.String()),
    toolCalls: Type.Array(ModelToolCallSchema),
    reasoningContent: Type.Optional(Type.String()),
  }),
  closed({
    seq: count(1),
    turnId: Type.Optional(IdSchemas.turnId),
    category: Type.Enum(['PINNED', 'NORMAL']),
    kind: Type.Literal('TOOL_RESULT'),
    toolCallId: ToolCallIdSchema,
    toolName: text(64),
    status: Type.Enum(['OK', 'REJECTED', 'FAILED', 'INTERRUPTED']),
    reasonCode: Type.Optional(ReasonCodeSchema),
    /** The preview; a tool that gave none is worded by the Executor from its status. */
    text: Type.Optional(Type.String()),
  }),
  closed({
    seq: count(1),
    turnId: Type.Optional(IdSchemas.turnId),
    category: Type.Enum(['PINNED', 'NORMAL']),
    kind: Type.Literal('PROJECT_INSTRUCTIONS'),
    path: text(512),
    text: Type.String(),
    trusted: Type.Boolean(),
  }),
  closed({
    seq: count(1),
    turnId: Type.Optional(IdSchemas.turnId),
    category: Type.Enum(['PINNED', 'NORMAL']),
    kind: Type.Literal('FEEDBACK'),
    text: Type.String(),
    toolCallId: Type.Optional(ToolCallIdSchema),
  }),
]);
export type ResolvedHistoryEntry = Static<typeof ResolvedHistoryEntrySchema>;

/** ContextAssembleInput.v1 after Execution resolved references and pinned definitions. */
export const AssembleExecutorInputSchema = Type.Refine(
  closed(
    {
      final: Type.Boolean(),
      tokenBudget: count(1),
      instructions: Type.String({ maxLength: 100000 }),
      toolSpecs: Type.Array(ModelToolSpecSchema),
      orientPack: Type.Optional(OrientContextPackSchema),
      history: Type.Array(ResolvedHistoryEntrySchema),
      status: StatusFactsSchema,
    },
    'kernel.execution.AssembleExecutorInput.v1',
  ),
  (input) => input.final === input.status.final,
  () => 'final must equal status.final',
);
export type AssembleExecutorInput = Static<typeof AssembleExecutorInputSchema>;

export const ModelExecutorInputSchema = closed(
  {
    contextPack: AssembleContextPackSchema,
    final: Type.Boolean(),
    finalMode: Type.Optional(Type.Enum(['AUTO', 'FORCED'])),
  },
  'kernel.execution.ModelExecutorInput.v1',
);
export type ModelExecutorInput = Static<typeof ModelExecutorInputSchema>;

const request = <K extends string, I extends TSchema, S extends TSchema, L extends TSchema>(
  executionKind: K,
  input: I,
  scope: S,
  limitsOf: L,
) =>
  closed({
    sessionId: IdSchemas.sessionId,
    workflowRunId: IdSchemas.workflowRunId,
    unitAttemptId: IdSchemas.unitAttemptId,
    executionId: IdSchemas.executionId,
    runEpoch: count(1),
    executionKind: Type.Literal(executionKind),
    input,
    scope,
    limits: limitsOf,
    notBefore: Type.Optional(TimestampSchema),
  });

export const ExecutionRequestSchema = Type.Union(
  [
    request(
      'REPOSITORY_ORIENT',
      OrientExecutorInputSchema,
      RepositoryScopeSchema,
      OrientLimitsSchema,
    ),
    request(
      'REPOSITORY_SEARCH',
      SearchExecutorInputSchema,
      RepositoryScopeSchema,
      PlainLimitsSchema,
    ),
    request('REPOSITORY_LIST', RepositoryListInputSchema, RepositoryScopeSchema, PlainLimitsSchema),
    request('FILE_READ', FileReadInputSchema, RepositoryScopeSchema, PlainLimitsSchema),
    request('CONTEXT_ASSEMBLE', AssembleExecutorInputSchema, NoScopeSchema, AssembleLimitsSchema),
    request('MODEL', ModelExecutorInputSchema, ModelScopeSchema, ModelLimitsSchema),
  ],
  { $id: 'kernel.execution.ExecutionRequest.v1' },
);
export type ExecutionRequest = Static<typeof ExecutionRequestSchema>;
