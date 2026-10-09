import { Type, type Static, type TSchema } from 'typebox';
import { ContextPackSchema, ModelToolSpecSchema } from '../context/context-pack.js';
import { SEARCH_MODES } from '../context/repository.js';
import { FileReadInputSchema } from '../executor/file-read.js';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
import { HandoffBriefSchema } from '../workflow/handoff.js';
import { StatusFactsSchema, StepRecordSchema } from '../workflow/step-record.js';

export const EXECUTOR_KINDS = [
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'FILE_READ',
  'CONTEXT_ASSEMBLE',
  'MODEL',
] as const;
/** The execution kinds that are dispatched to the Supervisor. */
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

const RepositoryScopeSchema = closed({
  kind: Type.Literal('REPOSITORY'),
  repositoryRoot: text(4096),
  exclusions: Type.Array(text(512)),
});
const ModelScopeSchema = closed({
  kind: Type.Literal('MODEL'),
  provider: text(64),
  apiModelId: text(128),
  apiProtocol: Type.Enum(['OPENAI_CHAT_COMPLETIONS', 'ANTHROPIC_MESSAGES']),
  baseUrl: text(512),
  thinking: Type.Enum(['DISABLED', 'ENABLED']),
  thinkingEffort: Type.Optional(text(32)),
});
const NoScopeSchema = closed({ kind: Type.Literal('NONE') });
/** Derived by Core: REPOSITORY from the Lease, MODEL from the pinned Model and Agent. */
export const ExecutionScopeSchema = Type.Union(
  [RepositoryScopeSchema, ModelScopeSchema, NoScopeSchema],
  { $id: 'kernel.execution.ExecutionScope.v0' },
);
export type ExecutionScope = Static<typeof ExecutionScopeSchema>;

/** `maxOutputTokens` is set for MODEL, `maxFiles` for REPOSITORY_ORIENT. */
export const ExecutionLimitsSchema = closed(
  {
    deadline: TimestampSchema,
    maxOutputBytes: count(1),
    maxOutputTokens: Type.Optional(count(1)),
    maxFiles: Type.Optional(count(1)),
  },
  'kernel.execution.ExecutionLimits.v0',
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

const ResolvedStepSchema = closed({
  step: StepRecordSchema,
  outputText: Type.Optional(Type.String()),
});
export type ResolvedStep = Static<typeof ResolvedStepSchema>;

/** ContextAssembleInput after Execution resolved the references and the pinned definitions. */
export const AssembleExecutorInputSchema = closed(
  {
    objective: text(4000),
    final: Type.Boolean(),
    tokenBudget: count(1),
    instructions: Type.String({ maxLength: 100000 }),
    toolSpecs: Type.Array(ModelToolSpecSchema),
    handoff: Type.Optional(HandoffBriefSchema),
    orientPack: Type.Optional(ContextPackSchema),
    history: Type.Array(ResolvedStepSchema),
    status: StatusFactsSchema,
  },
  'kernel.execution.AssembleExecutorInput.v0',
);
export type AssembleExecutorInput = Static<typeof AssembleExecutorInputSchema>;

export const ModelExecutorInputSchema = closed(
  { contextPack: ContextPackSchema, final: Type.Boolean() },
  'kernel.execution.ModelExecutorInput.v0',
);
export type ModelExecutorInput = Static<typeof ModelExecutorInputSchema>;

const request = <K extends ExecutorKind, I extends TSchema, S extends TSchema>(
  executionKind: K,
  input: I,
  scope: S,
) =>
  closed({
    workflowRunId: IdSchemas.workflowRunId,
    unitAttemptId: IdSchemas.unitAttemptId,
    executionId: IdSchemas.executionId,
    runEpoch: count(1),
    executionKind: Type.Literal(executionKind),
    input,
    scope,
    limits: ExecutionLimitsSchema,
    // Back-off of a technical retry: the Supervisor starts the Executor only after it.
    notBefore: Type.Optional(TimestampSchema),
  });

/** One variant per executionKind, which fixes the input type and the scope kind together. */
export const ExecutionRequestSchema = Type.Union(
  [
    request('REPOSITORY_ORIENT', OrientExecutorInputSchema, RepositoryScopeSchema),
    request('REPOSITORY_SEARCH', SearchExecutorInputSchema, RepositoryScopeSchema),
    request('FILE_READ', FileReadInputSchema, RepositoryScopeSchema),
    request('CONTEXT_ASSEMBLE', AssembleExecutorInputSchema, NoScopeSchema),
    request('MODEL', ModelExecutorInputSchema, ModelScopeSchema),
  ],
  { $id: 'kernel.execution.ExecutionRequest.v0' },
);
export type ExecutionRequest = Static<typeof ExecutionRequestSchema>;
export type ExecutorInput = ExecutionRequest['input'];
