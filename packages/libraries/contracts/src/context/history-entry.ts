import { Type, type Static } from 'typebox';
import { BudgetViewSchema } from '../kernel-unit/budget-state.js';
import { MeasuredUsageSchema } from './compaction.js';
import { ArtifactRefSchema, artifactRefOf } from '../platform-common/common-schemas.js';
import { IdSchemas, ReferenceIdSchema, ToolCallIdSchema } from '../platform-common/ids.js';
import { MEDIA_TYPES } from '../platform-common/media-types.js';
import { ReasonCodeSchema } from '../platform-common/reason-code.js';
import { Sha256Schema, closed, count, text } from '../platform-common/schema-helpers.js';

const entry = {
  /** `seq` of the log record the entry comes from. */
  seq: count(1),
  turnId: Type.Optional(IdSchemas.turnId),
  category: Type.Enum(['PINNED', 'NORMAL']),
};

/**
 * One line of a projection (Module/Workflow 8.3). Bodies stay in artifacts, so the same log
 * prefix always gives the same entries. A tool result only ever names its preview: `fullRef`
 * reaches the model through `read_output` alone.
 */
export const ContextHistoryEntrySchema = Type.Union(
  [
    closed({ ...entry, kind: Type.Literal('HUMAN'), contentRef: ArtifactRefSchema }),
    closed({
      ...entry,
      kind: Type.Literal('MODEL_TURN'),
      modelId: text(64),
      outputRef: artifactRefOf(MEDIA_TYPES.modelOutput),
      reasoningRef: Type.Optional(ArtifactRefSchema),
      replayable: Type.Boolean(),
      /** Only in the material of a compaction: what the provider counted for this turn. */
      measured: Type.Optional(MeasuredUsageSchema),
    }),
    closed({
      ...entry,
      kind: Type.Literal('TOOL_RESULT'),
      toolCallId: ToolCallIdSchema,
      toolName: text(64),
      status: Type.Enum(['OK', 'REJECTED', 'FAILED', 'INTERRUPTED']),
      outputRef: Type.Optional(ArtifactRefSchema),
      reasonCode: Type.Optional(ReasonCodeSchema),
      /** A command that runs on as a job: its name in the task (Orchestration 6.1). */
      jobId: Type.Optional(text(32)),
      /**
       * `outputRef` is the result cut to head and tail by a compaction (M2Design 9.6); this is the
       * `seq` of the record that cut it, which the estimate needs to know what a measurement predates.
       */
      prunedAt: Type.Optional(count(1)),
      /** Only in the material of a compaction (Kernel never shows these to the model). */
      requestId: Type.Optional(IdSchemas.requestId),
      fullRef: Type.Optional(ArtifactRefSchema),
    }),
    /** A predecessor's handoff, by the tool call that holds it; PINNED in the target's view. */
    closed({
      ...entry,
      kind: Type.Literal('HANDOFF'),
      outputRef: artifactRefOf(MEDIA_TYPES.modelOutput),
      toolCallId: ToolCallIdSchema,
    }),
    /** Answers a tool call that did not run, or corrects a reply without one. */
    closed({
      ...entry,
      kind: Type.Literal('FEEDBACK'),
      text: text(16000),
      toolCallId: Type.Optional(ToolCallIdSchema),
    }),
    /** `AGENTS.md`, appended when the run first reads the repository (M2Design 9.5). */
    closed({
      ...entry,
      kind: Type.Literal('PROJECT_INSTRUCTIONS'),
      path: text(512),
      ref: ArtifactRefSchema,
      trusted: Type.Boolean(),
    }),
    /** The task a SubAgent was started with, PINNED in its own view (M2Design 3.6). */
    closed({
      ...entry,
      kind: Type.Literal('TASK'),
      name: text(64),
      agent: text(64),
      goal: text(4000),
      acceptance: Type.Array(text(300), { maxItems: 10 }),
      writeScope: Type.Array(text(500), { maxItems: 10 }),
      inputs: Type.Array(ArtifactRefSchema, { maxItems: 10 }),
    }),
    /**
     * The result of a task, by the model output that holds its `finish_subagent` call: PINNED in
     * the view of the task that depends on it, NORMAL in the view of the caller (M2Design 3.6).
     */
    closed({
      ...entry,
      kind: Type.Literal('SUBAGENT_RESULT'),
      name: text(64),
      agent: text(64),
      status: Type.Enum(['DONE', 'PARTIAL', 'BLOCKED', 'FAILED', 'SKIPPED']),
      notes: Type.Array(text(300), { maxItems: 10 }),
      outputRef: Type.Optional(artifactRefOf(MEDIA_TYPES.modelOutput)),
      toolCallId: Type.Optional(ToolCallIdSchema),
      /** What the task handed over, read by `read_output` as `referenceId/toolCallId`. */
      referenceId: Type.Optional(ReferenceIdSchema),
      references: Type.Optional(
        Type.Array(closed({ toolCallId: ToolCallIdSchema, tool: text(128) }), { maxItems: 20 }),
      ),
    }),
    /** What the user answered to `ask_user`: the result of that call, the text in an artifact. */
    closed({
      ...entry,
      kind: Type.Literal('HUMAN_ANSWER'),
      toolCallId: ToolCallIdSchema,
      question: Type.Enum(['ask', 'confirm', 'review']),
      contentRef: ArtifactRefSchema,
    }),
    /**
     * The summary that took the place of `[fromSeq, toSeq]` of the log (M2Design 9.6). `seq` is the
     * record of the compaction; the entry stands where the first replaced entry stood.
     */
    closed({
      ...entry,
      kind: Type.Literal('SUMMARY'),
      compactionId: IdSchemas.compactionId,
      fromSeq: count(1),
      toSeq: count(1),
      contentRef: ArtifactRefSchema,
    }),
    /**
     * A message from another task (Orchestration 5), by the model output that holds its
     * `send_message` call: material from that task, never an instruction.
     */
    closed({
      ...entry,
      kind: Type.Literal('MESSAGE'),
      from: text(64),
      /** It interrupted the receiver: shown so that it is dealt with first (D20). */
      interrupt: Type.Optional(Type.Boolean()),
      outputRef: artifactRefOf(MEDIA_TYPES.modelOutput),
      toolCallId: ToolCallIdSchema,
    }),
    /** Runtime context, interruption and repair records: generated text, no artifact. */
    closed({ ...entry, kind: Type.Literal('NOTE'), text: text(2000) }),
  ],
  { $id: 'context.ContextHistoryEntry.v1' },
);
export type ContextHistoryEntry = Static<typeof ContextHistoryEntrySchema>;

/** Why the next model call is the final call; a quota names the limit it reached. */
export const WRAP_UP_REASONS = [
  'BUDGET_WRAP_UP',
  'TOOL_UNIT_LIMIT',
  'WALL_CLOCK_LIMIT',
  'REPEATED_INTENT',
  'CONSECUTIVE_ERRORS',
  'CONTEXT_LIMIT',
  'NO_PROGRESS',
  'ROUND_LIMIT',
  'REGENERATION_LIMIT',
  'MEMORY_LIMIT',
] as const;

/** Shared with `AnalysisReport.wrapUp`, which adds the endings that are not wrap-ups. */
export const WrapUpReasonSchema = Type.Enum(WRAP_UP_REASONS);
export type WrapUpReason = Static<typeof WrapUpReasonSchema>;

export const StatusFactsSchema = closed({
  round: count(1),
  maxRounds: count(1),
  budget: BudgetViewSchema,
  final: Type.Boolean(),
  wrapUpReason: Type.Optional(WrapUpReasonSchema),
});
export type StatusFacts = Static<typeof StatusFactsSchema>;

/** `final` here and `status.final` say the same thing and must be equal. */
export const ContextAssembleInputSchema = Type.Refine(
  closed(
    {
      final: Type.Boolean(),
      orientPackRef: Type.Optional(artifactRefOf(MEDIA_TYPES.contextPack)),
      history: Type.Array(ContextHistoryEntrySchema),
      status: StatusFactsSchema,
      /** Tools the model is no longer offered, by model name (M2Design 3.6). */
      withdrawnTools: Type.Optional(Type.Array(text(64), { maxItems: 8 })),
    },
    'context.ContextAssembleInput.v1',
  ),
  (input) => input.final === input.status.final,
  () => 'final must equal status.final',
);
export type ContextAssembleInput = Static<typeof ContextAssembleInputSchema>;

/** Nothing is dropped per call; only the final-call safeguard elides entries (ExecutorSet 6.2). */
export const ContextAssembleOutputSchema = Type.Refine(
  closed(
    {
      contextPackId: IdSchemas.contextPackId,
      tokenCount: count(),
      tokenBudget: count(1),
      prefixSha256: Sha256Schema,
      projectionDigest: Sha256Schema,
      headDigest: Sha256Schema,
      elidedEntries: Type.Array(count(1)),
      /** A summary request in text form: the older whole model turns it left out. */
      omittedEntries: Type.Optional(count()),
    },
    'context.ContextAssembleOutput.v1',
  ),
  (output) => output.tokenCount <= output.tokenBudget,
  () => 'tokenCount must not exceed tokenBudget',
);
export type ContextAssembleOutput = Static<typeof ContextAssembleOutputSchema>;
