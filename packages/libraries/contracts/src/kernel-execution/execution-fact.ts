import { Type, type Static, type TProperties, type TSchema } from 'typebox';
import { ContextAssembleOutputSchema } from '../context/assemble.js';
import {
  RepositoryOrientOutputSchema,
  RepositorySearchOutputSchema,
} from '../context/repository.js';
import { FileReadOutputSchema } from '../executor/file-read.js';
import { ModelCallOutputSchema, TokenUsageSchema } from '../executor/model-call.js';
import { IdSchemas } from '../platform-common/ids.js';
import { MEDIA_TYPES } from '../platform-common/media-types.js';
import {
  EXECUTOR_FAILED_CODES,
  EXECUTOR_REJECTED_CODES,
  TERMINATION_CODES,
  VIOLATION_CODES,
  reasonCodeOf,
} from '../platform-common/reason-code.js';
import { TimestampSchema, closed, count } from '../platform-common/schema-helpers.js';

const result = <O extends TSchema>(output: O, mediaType: string) =>
  closed({
    output,
    /** Written to the ArtifactStore by Execution, which produces `outputRef`. */
    artifact: closed({ mediaType: Type.Literal(mediaType), text: Type.String() }),
  });
const OrientResultSchema = result(RepositoryOrientOutputSchema, MEDIA_TYPES.contextPack);
const SearchResultSchema = result(RepositorySearchOutputSchema, MEDIA_TYPES.contextPack);
const FileReadResultSchema = result(FileReadOutputSchema, MEDIA_TYPES.fileText);
const AssembleResultSchema = result(ContextAssembleOutputSchema, MEDIA_TYPES.contextPack);
const ModelResultSchema = result(ModelCallOutputSchema, MEDIA_TYPES.modelOutput);

/**
 * What a completed Executor hands back: the output of its kind and the artifact, always
 * present and always of that kind's media type (M1Interface 6.1).
 */
export const ExecutionResultSchema = Type.Union(
  [
    OrientResultSchema,
    SearchResultSchema,
    FileReadResultSchema,
    AssembleResultSchema,
    ModelResultSchema,
  ],
  { $id: 'kernel.execution.ExecutionResult.v0' },
);
export type ExecutionResult = Static<typeof ExecutionResultSchema>;

export const EXECUTION_OUTCOMES = [
  'COMPLETED',
  'REJECTED',
  'FAILED',
  'TERMINATED',
  'VIOLATION',
  'STOP_UNCONFIRMED',
] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

/**
 * NOT_SENT: the request was not sent or the provider refused to process it, so nothing was
 * consumed. SENT: the provider processed it. UNKNOWN: it cannot be told.
 */
export const RequestStateSchema = Type.Enum(['NOT_SENT', 'SENT', 'UNKNOWN']);
export type RequestState = Static<typeof RequestStateSchema>;

const fact = {
  workflowRunId: IdSchemas.workflowRunId,
  unitAttemptId: IdSchemas.unitAttemptId,
  executionId: IdSchemas.executionId,
  /** Returned unchanged from the ExecutionRequest. */
  runEpoch: count(1),
  endedAt: TimestampSchema,
};
const started = { startedAt: TimestampSchema };
const completed = <K extends string, R extends TSchema, P extends TProperties>(
  executionKind: K,
  resultOf: R,
  extra: P,
) =>
  closed({
    ...fact,
    ...started,
    ...extra,
    executionKind: Type.Literal(executionKind),
    outcome: Type.Literal('COMPLETED'),
    result: resultOf,
  });
/** The five ways an execution of the given kinds ends without completing. */
const notCompleted = <K extends TSchema, P extends TProperties>(executionKind: K, extra: P) => {
  const common = { ...fact, ...extra, executionKind };
  const rejected = closed({
    ...common,
    ...started,
    outcome: Type.Literal('REJECTED'),
    reasonCode: reasonCodeOf(EXECUTOR_REJECTED_CODES),
  });
  const failed = closed({
    ...common,
    ...started,
    outcome: Type.Literal('FAILED'),
    reasonCode: reasonCodeOf(EXECUTOR_FAILED_CODES),
    retryable: Type.Boolean(),
  });
  const terminated = closed({
    ...common,
    // Absent only when the execution was cancelled before the Executor started.
    startedAt: Type.Optional(TimestampSchema),
    outcome: Type.Literal('TERMINATED'),
    reasonCode: reasonCodeOf(TERMINATION_CODES),
  });
  const unconfirmed = closed({
    ...common,
    ...started,
    outcome: Type.Literal('STOP_UNCONFIRMED'),
    reasonCode: reasonCodeOf(TERMINATION_CODES),
  });
  const violation = closed({
    ...common,
    ...started,
    outcome: Type.Literal('VIOLATION'),
    reasonCode: reasonCodeOf(VIOLATION_CODES),
  });
  return [rejected, failed, terminated, unconfirmed, violation] as [
    typeof rejected,
    typeof failed,
    typeof terminated,
    typeof unconfirmed,
    typeof violation,
  ];
};

/** Only a MODEL execution has a request state and a usage; `requestState` is then required. */
const modelFields = { requestState: RequestStateSchema, usage: Type.Optional(TokenUsageSchema) };
const NON_MODEL_KINDS = Type.Enum([
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'FILE_READ',
  'CONTEXT_ASSEMBLE',
]);

/**
 * Exactly one per executionId; the Supervisor gives the single verdict. `executionKind` is the
 * kind of the ExecutionRequest it answers, and it decides the rest: the result type of a
 * COMPLETED fact, and whether `requestState` and `usage` exist at all. Each outcome accepts only
 * its own reason codes (M1Interface 7.3), and a completed MODEL execution is always SENT.
 */
export const ExecutionFactSchema = Type.Union(
  [
    completed('REPOSITORY_ORIENT', OrientResultSchema, {}),
    completed('REPOSITORY_SEARCH', SearchResultSchema, {}),
    completed('FILE_READ', FileReadResultSchema, {}),
    completed('CONTEXT_ASSEMBLE', AssembleResultSchema, {}),
    completed('MODEL', ModelResultSchema, {
      requestState: Type.Literal('SENT'),
      usage: Type.Optional(TokenUsageSchema),
    }),
    ...notCompleted(NON_MODEL_KINDS, {}),
    ...notCompleted(Type.Literal('MODEL'), modelFields),
  ],
  { $id: 'kernel.execution.ExecutionFact.v0' },
);
export type ExecutionFact = Static<typeof ExecutionFactSchema>;
