import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas, ToolCallIdSchema } from '../platform-common/ids.js';
import { Sha256Schema, closed, count } from '../platform-common/schema-helpers.js';

/**
 * The shared pieces of context compaction (M2Design 9.6). Kernel decides and does it, Workflow
 * hands over the material and records the result.
 */

/** What is compacted: main's projection of the whole Session, or the projection of one AgentRun. */
export const CompactionTargetSchema = Type.Union(
  [
    closed({ kind: Type.Literal('MAIN') }),
    closed({ kind: Type.Literal('AGENT_RUN'), agentRunId: IdSchemas.agentRunId }),
  ],
  { $id: 'context.CompactionTarget.v1' },
);
export type CompactionTarget = Static<typeof CompactionTargetSchema>;

/** Why a compaction started. */
export const COMPACTION_TRIGGERS = ['AUTO', 'OVERFLOW', 'USER'] as const;
export type CompactionTrigger = (typeof COMPACTION_TRIGGERS)[number];

/** One tool result that was cut to its head and tail. */
export const PrunedItemSchema = closed(
  {
    requestId: IdSchemas.requestId,
    toolCallId: ToolCallIdSchema,
    /** The cut result, kept for good. */
    prunedRef: ArtifactRefSchema,
    /** What `read_output` reads back: the full output when it was cut before, else the preview. */
    readableRef: ArtifactRefSchema,
    omittedBytes: count(1),
  },
  'context.PrunedItem.v1',
);
export type PrunedItem = Static<typeof PrunedItemSchema>;

/** How the summary request was made, and how much older history it had to leave out. */
export const CompactionSummaryInputSchema = closed(
  { mode: Type.Enum(['PREFIX', 'TEXT']), omittedEntries: count() },
  'context.CompactionSummaryInput.v1',
);
export type CompactionSummaryInput = Static<typeof CompactionSummaryInputSchema>;

/** What the summary requests of one compaction used, together. */
export const CompactionUsageSchema = closed(
  { inputTokens: count(), outputTokens: count(), cachedInputTokens: count() },
  'context.CompactionUsage.v1',
);
export type CompactionUsage = Static<typeof CompactionUsageSchema>;

/** What the provider reported for a model turn: the estimate of the next call starts from it. */
export const MeasuredUsageSchema = closed(
  { inputTokens: count(), outputTokens: count(), headDigest: Sha256Schema },
  'context.MeasuredUsage.v1',
);
export type MeasuredUsage = Static<typeof MeasuredUsageSchema>;

/** Why a compaction that was asked for did not happen (shown to the user). */
export const COMPACTION_FAILURES = [
  'NOTHING_TO_COMPACT',
  'BUDGET_INSUFFICIENT',
  'SUMMARY_FAILED',
  'NOT_RECORDED',
] as const;
export type CompactionFailure = (typeof COMPACTION_FAILURES)[number];

/**
 * The sections a summary must have (the Prompt `compaction-system` asks for exactly these, and a
 * test holds the two together): `model-call` refuses an answer that lacks one.
 */
export const COMPACTION_SECTIONS = [
  'Goal and requirements',
  'Work done and findings',
  'Key decisions',
  'Files involved',
  'Outputs that may be read again',
  'Open items',
] as const;

/** Added to the instruction of the second try, after an answer that was not a summary. */
export const COMPACTION_STRICT_SUFFIX =
  '\n\nYour last reply was not a summary in the format above. Reply with the six sections and nothing else, and call no tool.';
