import { Type, type Static, type TSchema } from 'typebox';
import {
  AssembleContextPackSchema,
  ModelToolSpecSchema,
  OrientContextPackSchema,
} from '../context/context-pack.js';
import { SEARCH_MODES } from '../context/repository.js';
import { FileReadInputSchema } from '../executor/file-read.js';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
import { HandoffBriefSchema } from '../workflow/handoff.js';
import { StatusFactsSchema, StepRecordSchema } from '../workflow/step-record.js';

const RepositoryScopeSchema = closed({
  kind: Type.Literal('REPOSITORY'),
  /** The realpath of the repository root. */
  repositoryRoot: text(4096),
  exclusions: Type.Array(text(512)),
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
