import { Type, type Static, type TSchema } from 'typebox';
import {
  AssembleContextPackSchema,
  AssembleContextPackV1Schema,
  ModelToolSpecSchema,
  OrientContextPackSchema,
} from '../context/context-pack.js';
import { StatusFactsV1Schema } from '../context/history-entry.js';
import { ModelToolCallSchema } from '../executor/model-tool-call.js';
import { RepositoryListInputSchema } from '../executor/repository-list.js';
import { SEARCH_MODES } from '../context/repository.js';
import { FileReadInputSchema } from '../executor/file-read.js';
import { IdSchemas, ToolCallIdSchema } from '../platform-common/ids.js';
import { ExclusionRuleSchema } from '../platform-common/repository-exclusions.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
import { HandoffBriefSchema } from '../workflow/handoff.js';
import { StatusFactsSchema, StepRecordSchema } from '../workflow/step-record.js';

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
  { $id: 'kernel.execution.ExecutionScope.v0' },
);
export type ExecutionScope = Static<typeof ExecutionScopeSchema>;

const limits = { deadline: TimestampSchema, maxOutputBytes: count(1) };
const PlainLimitsSchema = closed(limits);
const OrientLimitsSchema = closed({ ...limits, maxFiles: count(1) });
const ModelLimitsSchema = closed({ ...limits, maxOutputTokens: count(1) });
/**
 * `maxFiles` is present exactly for REPOSITORY_ORIENT and `maxOutputTokens` exactly for MODEL;
 * every other kind has neither.
 */
export const ExecutionLimitsSchema = Type.Union(
  [PlainLimitsSchema, OrientLimitsSchema, ModelLimitsSchema],
  { $id: 'kernel.execution.ExecutionLimits.v0' },
);
export type ExecutionLimits = Static<typeof ExecutionLimitsSchema>;

export const OrientExecutorInputSchema = closed(
  { objective: text(4000), tokenBudget: count(1) },
  'kernel.execution.OrientExecutorInput.v0',
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
  'kernel.execution.SearchExecutorInput.v0',
);
export type SearchExecutorInput = Static<typeof SearchExecutorInputSchema>;

/** `outputText` is the resolved artifact of an OK TOOL_RESULT step, and of nothing else. */
const ResolvedStepSchema = Type.Refine(
  closed({ step: StepRecordSchema, outputText: Type.Optional(Type.String()) }),
  ({ step, outputText }) =>
    (step.kind === 'TOOL_RESULT' && step.status === 'OK') === (outputText !== undefined),
  () => 'outputText must be present exactly for an OK TOOL_RESULT step',
);
export type ResolvedStep = Static<typeof ResolvedStepSchema>;

/** ContextAssembleInput after Execution resolved the references and the pinned definitions. */
export const AssembleExecutorInputSchema = Type.Refine(
  closed(
    {
      objective: text(4000),
      final: Type.Boolean(),
      tokenBudget: count(1),
      instructions: Type.String({ maxLength: 100000 }),
      toolSpecs: Type.Array(ModelToolSpecSchema),
      handoff: Type.Optional(HandoffBriefSchema),
      orientPack: Type.Optional(OrientContextPackSchema),
      history: Type.Array(ResolvedStepSchema),
      status: StatusFactsSchema,
    },
    'kernel.execution.AssembleExecutorInput.v0',
  ),
  (input) => input.final === input.status.final,
  () => 'final must equal status.final',
);
export type AssembleExecutorInput = Static<typeof AssembleExecutorInputSchema>;

export const ModelExecutorInputSchema = closed(
  { contextPack: AssembleContextPackSchema, final: Type.Boolean() },
  'kernel.execution.ModelExecutorInput.v0',
);
export type ModelExecutorInput = Static<typeof ModelExecutorInputSchema>;

const request = <K extends string, I extends TSchema, S extends TSchema, L extends TSchema>(
  executionKind: K,
  input: I,
  scope: S,
  limitsOf: L,
) =>
  closed({
    workflowRunId: IdSchemas.workflowRunId,
    unitAttemptId: IdSchemas.unitAttemptId,
    executionId: IdSchemas.executionId,
    runEpoch: count(1),
    executionKind: Type.Literal(executionKind),
    input,
    scope,
    limits: limitsOf,
    // Back-off of a technical retry: the Supervisor starts the Executor only after it.
    notBefore: Type.Optional(TimestampSchema),
  });

/** One variant per executionKind, which fixes the input, the scope and the limits together. */
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
    request('FILE_READ', FileReadInputSchema, RepositoryScopeSchema, PlainLimitsSchema),
    request('CONTEXT_ASSEMBLE', AssembleExecutorInputSchema, NoScopeSchema, PlainLimitsSchema),
    request('MODEL', ModelExecutorInputSchema, ModelScopeSchema, ModelLimitsSchema),
  ],
  { $id: 'kernel.execution.ExecutionRequest.v0' },
);
export type ExecutionRequest = Static<typeof ExecutionRequestSchema>;
export type ExecutorInput = ExecutionRequest['input'];

// --- Major 1 (Library/SharedContracts 3.5) ----------------------------------------------------

/** `maxLines` is absent for `v0` Units, whose preview limit is `maxOutputBytes` alone. */
const PreviewLimitsSchema = closed({ maxBytes: count(1), maxLines: Type.Optional(count(1)) });
const limitsV1 = {
  ...limits,
  preview: PreviewLimitsSchema,
  maxFullOutputBytes: count(1),
};
const PlainLimitsV1Schema = closed(limitsV1);
const OrientLimitsV1Schema = closed({ ...limitsV1, maxFiles: count(1) });
const ModelLimitsV1Schema = closed({ ...limits, maxOutputTokens: count(1) });
const AssembleLimitsV1Schema = closed(limits);
export const ExecutionLimitsV1Schema = Type.Union(
  [PlainLimitsV1Schema, OrientLimitsV1Schema, ModelLimitsV1Schema, AssembleLimitsV1Schema],
  { $id: 'kernel.execution.ExecutionLimits.v1' },
);
export type ExecutionLimitsV1 = Static<typeof ExecutionLimitsV1Schema>;

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
    text: Type.String(),
  }),
]);
export type ResolvedHistoryEntry = Static<typeof ResolvedHistoryEntrySchema>;

/** ContextAssembleInput.v1 after Execution resolved references and pinned definitions. */
export const AssembleExecutorInputV1Schema = Type.Refine(
  closed(
    {
      final: Type.Boolean(),
      tokenBudget: count(1),
      instructions: Type.String({ maxLength: 100000 }),
      toolSpecs: Type.Array(ModelToolSpecSchema),
      projectInstructions: Type.Optional(closed({ text: Type.String(), trusted: Type.Boolean() })),
      orientPack: Type.Optional(OrientContextPackSchema),
      history: Type.Array(ResolvedHistoryEntrySchema),
      status: StatusFactsV1Schema,
    },
    'kernel.execution.AssembleExecutorInput.v1',
  ),
  (input) => input.final === input.status.final,
  () => 'final must equal status.final',
);
export type AssembleExecutorInputV1 = Static<typeof AssembleExecutorInputV1Schema>;

export const ModelExecutorInputV1Schema = closed(
  {
    contextPack: AssembleContextPackV1Schema,
    final: Type.Boolean(),
    finalMode: Type.Optional(Type.Enum(['AUTO', 'FORCED'])),
  },
  'kernel.execution.ModelExecutorInput.v1',
);
export type ModelExecutorInputV1 = Static<typeof ModelExecutorInputV1Schema>;

const requestV1 = <K extends string, I extends TSchema, S extends TSchema, L extends TSchema>(
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

export const ExecutionRequestV1Schema = Type.Union(
  [
    requestV1(
      'REPOSITORY_ORIENT',
      OrientExecutorInputSchema,
      RepositoryScopeSchema,
      OrientLimitsV1Schema,
    ),
    requestV1(
      'REPOSITORY_SEARCH',
      SearchExecutorInputSchema,
      RepositoryScopeSchema,
      PlainLimitsV1Schema,
    ),
    requestV1(
      'REPOSITORY_LIST',
      RepositoryListInputSchema,
      RepositoryScopeSchema,
      PlainLimitsV1Schema,
    ),
    requestV1('FILE_READ', FileReadInputSchema, RepositoryScopeSchema, PlainLimitsV1Schema),
    requestV1(
      'CONTEXT_ASSEMBLE',
      Type.Union([AssembleExecutorInputSchema, AssembleExecutorInputV1Schema]),
      NoScopeSchema,
      AssembleLimitsV1Schema,
    ),
    requestV1(
      'MODEL',
      Type.Union([ModelExecutorInputSchema, ModelExecutorInputV1Schema]),
      ModelScopeSchema,
      ModelLimitsV1Schema,
    ),
  ],
  { $id: 'kernel.execution.ExecutionRequest.v1' },
);
export type ExecutionRequestV1 = Static<typeof ExecutionRequestV1Schema>;
