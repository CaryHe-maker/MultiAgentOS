import { Type, type Static, type TSchema } from 'typebox';
import { AssembleContextPackSchema, ModelToolSpecSchema } from '../context/context-pack.js';
import { StatusFactsSchema } from '../context/history-entry.js';
import { ModelToolCallSchema } from '../executor/model-tool-call.js';
import { RepositoryListInputSchema } from '../executor/repository-list.js';
import { SEARCH_MODES } from '../context/repository.js';
import { FileReadInputSchema } from '../executor/file-read.js';
import { CommandExecutorInputSchema, GitInspectInputSchema } from '../executor/command.js';
import { FileEditInputSchema, FileWriteInputSchema } from '../executor/file-write.js';
import { WebFetchInputSchema, WebSearchInputSchema } from '../executor/web.js';
import { IdSchemas, ToolCallIdSchema } from '../platform-common/ids.js';
import { ReasonCodeSchema } from '../platform-common/reason-code.js';
import { ExclusionRuleSchema } from '../platform-common/repository-exclusions.js';
import { SandboxScopeSchema } from '../platform-common/sandbox.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';

const RepositoryScopeSchema = closed({
  kind: Type.Literal('REPOSITORY'),
  /** The realpath of the repository root. */
  repositoryRoot: text(4096),
  exclusions: Type.Array(ExclusionRuleSchema),
  /**
   * Present for `external.read`: the root is a folder outside the workspace that the user allowed,
   * and this call stays below `below` (relative to it, '' for all of it). Paths are shown in full
   * and project instructions are not looked for (ExecutorSet 5e).
   */
  external: Type.Optional(closed({ below: Type.String({ maxLength: 1024 }) })),
});
/** Derived by Core from the ceiling of the AgentRun: what a write may touch (ExecutorSet 5b). */
const WorkspaceScopeSchema = closed({
  kind: Type.Literal('WORKSPACE'),
  repositoryRoot: text(4096),
  writableRoots: Type.Array(text(1024), { minItems: 1 }),
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
/** Derived by Core: REPOSITORY and WORKSPACE from a Lease, MODEL from the pinned Model and Agent. */
export const ExecutionScopeSchema = Type.Union(
  [
    RepositoryScopeSchema,
    WorkspaceScopeSchema,
    SandboxScopeSchema,
    ModelScopeSchema,
    NoScopeSchema,
  ],
  { $id: 'kernel.execution.ExecutionScope.v1' },
);
export type ExecutionScope = Static<typeof ExecutionScopeSchema>;

const limits = { deadline: TimestampSchema, maxOutputBytes: count(1) };

/** The search input with defaults filled in. */
export const SearchExecutorInputSchema = closed(
  {
    query: text(500),
    mode: Type.Enum(SEARCH_MODES),
    maxItems: Type.Integer({ minimum: 1, maximum: 50 }),
    tokenBudget: count(1),
    /** Only files below this directory, relative to the root. */
    path: Type.Optional(text(1024)),
  },
  'kernel.execution.SearchExecutorInput.v1',
);
export type SearchExecutorInput = Static<typeof SearchExecutorInputSchema>;

/** `maxBytes` is `min(previewMaxBytes, maxOutputBytes)` (M2Design 8.2). */
const PreviewLimitsSchema = closed({ maxBytes: count(1), maxLines: count(1) });
const toolLimits = {
  ...limits,
  preview: PreviewLimitsSchema,
  maxFullOutputBytes: count(1),
};
const PlainLimitsSchema = closed(toolLimits);
const ModelLimitsSchema = closed({ ...limits, maxOutputTokens: count(1) });
const AssembleLimitsSchema = closed(limits);
export const ExecutionLimitsSchema = Type.Union(
  [PlainLimitsSchema, ModelLimitsSchema, AssembleLimitsSchema],
  { $id: 'kernel.execution.ExecutionLimits.v1' },
);
export type ExecutionLimits = Static<typeof ExecutionLimitsSchema>;

const ResolvedHistoryEntrySchema = Type.Union([
  closed({
    seq: count(1),
    category: Type.Enum(['PINNED', 'NORMAL']),
    kind: Type.Enum(['HUMAN', 'NOTE']),
    text: Type.String(),
  }),
  closed({
    seq: count(1),
    category: Type.Enum(['PINNED', 'NORMAL']),
    kind: Type.Literal('MODEL_TURN'),
    text: Type.Optional(Type.String()),
    toolCalls: Type.Array(ModelToolCallSchema),
    reasoningContent: Type.Optional(Type.String()),
  }),
  closed({
    seq: count(1),
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
    category: Type.Enum(['PINNED', 'NORMAL']),
    kind: Type.Literal('PROJECT_INSTRUCTIONS'),
    path: text(512),
    text: Type.String(),
    trusted: Type.Boolean(),
  }),
  closed({
    seq: count(1),
    category: Type.Enum(['PINNED', 'NORMAL']),
    kind: Type.Literal('FEEDBACK'),
    text: Type.String(),
    toolCallId: Type.Optional(ToolCallIdSchema),
  }),
  /** The summary of a compaction, in words; it is shown to the model as material, not as an order. */
  closed({
    seq: count(1),
    category: Type.Enum(['PINNED', 'NORMAL']),
    kind: Type.Literal('SUMMARY'),
    text: Type.String(),
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
      history: Type.Array(ResolvedHistoryEntrySchema),
      status: StatusFactsSchema,
      /**
       * A request for the summary of a compaction instead of a call of the AgentRun (M2Design 9.6):
       * PREFIX is the history as it is with the instruction after it, TEXT is the history written
       * out as one transcript, without tools, from which the oldest whole model turns are left
       * until it is estimated under `targetTokens`.
       */
      compaction: Type.Optional(
        closed({
          mode: Type.Enum(['PREFIX', 'TEXT']),
          instruction: Type.String({ maxLength: 20000 }),
          targetTokens: Type.Optional(count(1)),
        }),
      ),
      /** The AgentRun's last measured request; Kernel fills it, Workflow never holds tokens. */
      tokenCalibration: Type.Optional(
        closed({ measuredInputTokens: count(1), estimatedInputTokens: count(1) }),
      ),
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
    /** A summary request: no tool may be called, and these sections must be in the answer. */
    compaction: Type.Optional(closed({ requiredSections: Type.Array(text(100), { minItems: 1 }) })),
  },
  'kernel.execution.ModelExecutorInput.v1',
);
export type ModelExecutorInput = Static<typeof ModelExecutorInputSchema>;

/** Tool results to cut to head and tail (M2Design 9.6): the text is the preview the model sees now. */
export const PruneExecutorInputSchema = closed(
  {
    headBytes: count(1),
    tailBytes: count(1),
    items: Type.Array(closed({ toolCallId: ToolCallIdSchema, text: Type.String() }), {
      minItems: 1,
      maxItems: 500,
    }),
  },
  'kernel.execution.PruneExecutorInput.v1',
);
export type PruneExecutorInput = Static<typeof PruneExecutorInputSchema>;

/** `read_output` after Execution resolved `fullRef`; the Executor never sees a reference. */
export const OutputReadExecutorInputSchema = closed(
  {
    toolCallId: ToolCallIdSchema,
    content: Type.String(),
    offset: Type.Optional(count(1)),
    limit: Type.Optional(count(1)),
    pattern: Type.Optional(text(500)),
  },
  'kernel.execution.OutputReadExecutorInput.v1',
);
export type OutputReadExecutorInput = Static<typeof OutputReadExecutorInputSchema>;

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
      'REPOSITORY_SEARCH',
      SearchExecutorInputSchema,
      RepositoryScopeSchema,
      PlainLimitsSchema,
    ),
    request('REPOSITORY_LIST', RepositoryListInputSchema, RepositoryScopeSchema, PlainLimitsSchema),
    request('FILE_READ', FileReadInputSchema, RepositoryScopeSchema, PlainLimitsSchema),
    request('CONTEXT_ASSEMBLE', AssembleExecutorInputSchema, NoScopeSchema, AssembleLimitsSchema),
    request('CONTEXT_PRUNE', PruneExecutorInputSchema, NoScopeSchema, AssembleLimitsSchema),
    request('MODEL', ModelExecutorInputSchema, ModelScopeSchema, ModelLimitsSchema),
    request('FILE_WRITE', FileWriteInputSchema, WorkspaceScopeSchema, PlainLimitsSchema),
    request('FILE_EDIT', FileEditInputSchema, WorkspaceScopeSchema, PlainLimitsSchema),
    request('OUTPUT_READ', OutputReadExecutorInputSchema, NoScopeSchema, PlainLimitsSchema),
    request('COMMAND', CommandExecutorInputSchema, SandboxScopeSchema, PlainLimitsSchema),
    request('GIT_INSPECT', GitInspectInputSchema, RepositoryScopeSchema, PlainLimitsSchema),
    // The provider and its key belong to the Executor, so a web call has no scope of its own.
    request('WEB_SEARCH', WebSearchInputSchema, NoScopeSchema, PlainLimitsSchema),
    request('WEB_FETCH', WebFetchInputSchema, NoScopeSchema, PlainLimitsSchema),
  ],
  { $id: 'kernel.execution.ExecutionRequest.v1' },
);
export type ExecutionRequest = Static<typeof ExecutionRequestSchema>;
