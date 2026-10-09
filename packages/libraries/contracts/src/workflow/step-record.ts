import { Type, type Static } from 'typebox';
import { RepositorySearchOutputSchema } from '../context/repository.js';
import { FileReadOutputSchema } from '../executor/file-read.js';
import { ModelToolCallSchema } from '../executor/model-tool-call.js';
import { BudgetStateSchema } from '../kernel-unit/budget-state.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas, ToolCallIdSchema } from '../platform-common/ids.js';
import { ReasonCodeSchema } from '../platform-common/reason-code.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';

const ModelTurnStepSchema = closed({
  kind: Type.Literal('MODEL_TURN'),
  round: count(1),
  requestId: IdSchemas.requestId,
  toolCalls: Type.Array(ModelToolCallSchema),
});

const toolResult = {
  kind: Type.Literal('TOOL_RESULT'),
  round: count(1),
  requestId: IdSchemas.requestId,
  toolCallId: ToolCallIdSchema,
  toolName: text(128),
};
const ToolResultStepSchema = Type.Union([
  closed({
    ...toolResult,
    status: Type.Literal('OK'),
    output: Type.Union([RepositorySearchOutputSchema, FileReadOutputSchema]),
    outputRef: ArtifactRefSchema,
  }),
  closed({
    ...toolResult,
    status: Type.Enum(['REJECTED', 'FAILED']),
    reasonCode: ReasonCodeSchema,
  }),
]);

export const FEEDBACK_CODES = [
  'INVALID_ACTION',
  'UNKNOWN_TOOL',
  'INVALID_ARGUMENTS',
  'TOO_MANY_TOOL_CALLS',
  'DUPLICATE_CALL',
  'NOT_EXECUTED',
  'MODEL_CALL_FAILED',
  'WRAP_UP_NOTICE',
] as const;
export type FeedbackCode = (typeof FEEDBACK_CODES)[number];

const FeedbackStepSchema = closed({
  kind: Type.Literal('FEEDBACK'),
  round: count(1),
  code: Type.Enum(FEEDBACK_CODES),
  toolCallId: Type.Optional(ToolCallIdSchema),
  message: text(1000),
});

/** One entry of an AgentRun history, in the order it happened (M1Interface 6.6). */
export const StepRecordSchema = Type.Union(
  [ModelTurnStepSchema, ToolResultStepSchema, FeedbackStepSchema],
  { $id: 'workflow.StepRecord.v0' },
);
export type StepRecord = Static<typeof StepRecordSchema>;
export type ModelTurnStep = Static<typeof ModelTurnStepSchema>;
export type ToolResultStep = Static<typeof ToolResultStepSchema>;
export type FeedbackStep = Static<typeof FeedbackStepSchema>;

export const WRAP_UP_REASONS = [
  'ROUND_LIMIT',
  'BUDGET_WRAP_UP',
  'BUDGET_EXHAUSTED',
  'USER_DECLINED',
  'NO_PROGRESS',
  'REGENERATION_LIMIT',
] as const;
/** Shared with `AnalysisReport.wrapUp`. */
export const WrapUpReasonSchema = Type.Enum(WRAP_UP_REASONS);
export type WrapUpReason = Static<typeof WrapUpReasonSchema>;

export const StatusFactsSchema = closed(
  {
    roundsUsed: count(),
    maxRounds: count(1),
    final: Type.Boolean(),
    budgetState: BudgetStateSchema,
    wrapUpReason: Type.Optional(WrapUpReasonSchema),
  },
  'workflow.StatusFacts.v0',
);
export type StatusFacts = Static<typeof StatusFactsSchema>;
