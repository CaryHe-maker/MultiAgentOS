import { Type, type Static } from 'typebox';
import { RepositorySearchOutputSchema } from '../context/repository.js';
import { FileReadOutputSchema } from '../executor/file-read.js';
import { ModelToolCallSchema } from '../executor/model-tool-call.js';
import { BudgetStateSchema } from '../kernel-unit/budget-state.js';
import { artifactRefOf } from '../platform-common/common-schemas.js';
import { IdSchemas, ToolCallIdSchema } from '../platform-common/ids.js';
import { MEDIA_TYPES } from '../platform-common/media-types.js';
import {
  UNIT_FAILED_CODES,
  UNIT_REJECTED_CODES,
  reasonCodeOf,
} from '../platform-common/reason-code.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';

const step = { round: count(1) };

/** The model's answer of one Round; `requestId` is the one of its model-call. */
const ModelTurnStepSchema = closed({
  ...step,
  kind: Type.Literal('MODEL_TURN'),
  requestId: IdSchemas.requestId,
  toolCalls: Type.Array(ModelToolCallSchema, { maxItems: 32 }),
});

const toolResult = {
  ...step,
  kind: Type.Literal('TOOL_RESULT'),
  /** The requestId of the tool Unit. */
  requestId: IdSchemas.requestId,
  toolCallId: ToolCallIdSchema,
  toolName: text(128),
};
/**
 * The result of one tool Unit. OK carries the output and its artifact, whose media type follows
 * the Unit: a ContextPack for repository-search, text for file-read. REJECTED and FAILED carry
 * a reason code of that status and nothing else.
 */
const ToolResultStepSchema = Type.Union([
  closed({
    ...toolResult,
    status: Type.Literal('OK'),
    output: RepositorySearchOutputSchema,
    outputRef: artifactRefOf(MEDIA_TYPES.contextPack),
  }),
  closed({
    ...toolResult,
    status: Type.Literal('OK'),
    output: FileReadOutputSchema,
    outputRef: artifactRefOf(MEDIA_TYPES.fileText),
  }),
  closed({
    ...toolResult,
    status: Type.Literal('REJECTED'),
    reasonCode: reasonCodeOf(UNIT_REJECTED_CODES),
  }),
  closed({
    ...toolResult,
    status: Type.Literal('FAILED'),
    reasonCode: reasonCodeOf(UNIT_FAILED_CODES),
  }),
]);

/** Feedback about one tool call: `toolCallId` is required. */
export const CALL_FEEDBACK_CODES = [
  'UNKNOWN_TOOL',
  'INVALID_ARGUMENTS',
  'TOO_MANY_TOOL_CALLS',
  'DUPLICATE_CALL',
  'NOT_EXECUTED',
] as const;
/** Feedback about the Round as a whole: `toolCallId` is not allowed. */
export const ROUND_FEEDBACK_CODES = ['MODEL_CALL_FAILED', 'WRAP_UP_NOTICE'] as const;
/** INVALID_ACTION is given once per tool call, or once without `toolCallId` when there was none. */
export const FEEDBACK_CODES = [
  'INVALID_ACTION',
  ...CALL_FEEDBACK_CODES,
  ...ROUND_FEEDBACK_CODES,
] as const;
export type FeedbackCode = (typeof FEEDBACK_CODES)[number];

const feedback = { ...step, kind: Type.Literal('FEEDBACK'), message: text(1000) };
const FeedbackStepSchema = Type.Union([
  closed({ ...feedback, code: Type.Enum(CALL_FEEDBACK_CODES), toolCallId: ToolCallIdSchema }),
  closed({ ...feedback, code: Type.Enum(ROUND_FEEDBACK_CODES) }),
  closed({
    ...feedback,
    code: Type.Literal('INVALID_ACTION'),
    toolCallId: Type.Optional(ToolCallIdSchema),
  }),
]);

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

/** `roundsUsed` never exceeds `maxRounds`. */
export const StatusFactsSchema = Type.Refine(
  closed(
    {
      roundsUsed: count(),
      maxRounds: Type.Integer({ minimum: 1, maximum: 100 }),
      final: Type.Boolean(),
      budgetState: BudgetStateSchema,
      wrapUpReason: Type.Optional(WrapUpReasonSchema),
    },
    'workflow.StatusFacts.v0',
  ),
  (status) => status.roundsUsed <= status.maxRounds,
  () => 'roundsUsed must not exceed maxRounds',
);
export type StatusFacts = Static<typeof StatusFactsSchema>;
