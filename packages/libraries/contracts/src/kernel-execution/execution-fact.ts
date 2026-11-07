import { Type, type Static, type TProperties, type TSchema } from 'typebox';
import { ContextAssembleOutputSchema } from '../context/history-entry.js';
import {
  RepositoryOrientOutputSchema,
  RepositorySearchOutputSchema,
} from '../context/repository.js';
import { CommandOutputSchema, GitInspectOutputSchema } from '../executor/command.js';
import { FileReadOutputSchema } from '../executor/file-read.js';
import { FileWriteOutputSchema } from '../executor/file-write.js';
import { OutputReadOutputSchema } from '../executor/output-read.js';
import { WebFetchOutputSchema, WebSearchOutputSchema } from '../executor/web.js';
import { ModelCallOutputSchema, TokenUsageSchema } from '../executor/model-call.js';
import { RepositoryListOutputSchema } from '../executor/repository-list.js';
import { IdSchemas } from '../platform-common/ids.js';
import {
  EXECUTOR_FAILED_CODES,
  EXECUTOR_REJECTED_CODES,
  TERMINATION_CODES,
  VIOLATION_CODES,
  reasonCodeOf,
} from '../platform-common/reason-code.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';

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
    /** Present when `cancelExecution` ended it: why (Interface/KernelSupervisor 7). */
    cancelReason: Type.Optional(Type.Enum(['PAUSED', 'ABORTED'])),
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

const artifact = closed({ mediaType: text(128), text: Type.String() });
/** `artifact` is the preview; `fullOutput` is present only when the preview cut something. */
const toolResult = <O extends TSchema>(output: O) =>
  closed({
    output,
    artifact: artifact,
    fullOutput: Type.Optional(closed({ text: Type.String() })),
  });
const OrientResultSchema = toolResult(RepositoryOrientOutputSchema);
const SearchResultSchema = toolResult(RepositorySearchOutputSchema);
const ListResultSchema = toolResult(RepositoryListOutputSchema);
const FileReadResultSchema = toolResult(FileReadOutputSchema);
const FileWriteResultSchema = toolResult(FileWriteOutputSchema);
const OutputReadResultSchema = toolResult(OutputReadOutputSchema);
const CommandResultSchema = toolResult(CommandOutputSchema);
const GitInspectResultSchema = toolResult(GitInspectOutputSchema);
const WebSearchResultSchema = toolResult(WebSearchOutputSchema);
const WebFetchResultSchema = toolResult(WebFetchOutputSchema);
/** `artifact.text` is the JSON `{ items: [{ toolCallId, text, omittedBytes }] }` (ExecutorSet 6.4). */
const PruneResultSchema = closed({
  output: closed({ items: count(), omittedBytes: count() }),
  artifact: artifact,
});
const AssembleResultSchema = closed({
  output: ContextAssembleOutputSchema,
  artifact: artifact,
});
/** `reasoning` is present when the model returned thinking; it is stored apart from the output. */
const ModelResultSchema = closed({
  output: ModelCallOutputSchema,
  artifact: artifact,
  reasoning: Type.Optional(closed({ text: Type.String() })),
});

export const ExecutionResultSchema = Type.Union(
  [
    OrientResultSchema,
    SearchResultSchema,
    ListResultSchema,
    FileReadResultSchema,
    FileWriteResultSchema,
    OutputReadResultSchema,
    CommandResultSchema,
    GitInspectResultSchema,
    WebSearchResultSchema,
    WebFetchResultSchema,
    AssembleResultSchema,
    PruneResultSchema,
    ModelResultSchema,
  ],
  { $id: 'kernel.execution.ExecutionResult.v1' },
);
export type ExecutionResult = Static<typeof ExecutionResultSchema>;

const inSession = { sessionId: IdSchemas.sessionId };
const NON_MODEL_KINDS = Type.Enum([
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'REPOSITORY_LIST',
  'FILE_READ',
  'FILE_WRITE',
  'FILE_EDIT',
  'OUTPUT_READ',
  'COMMAND',
  'GIT_INSPECT',
  'WEB_SEARCH',
  'WEB_FETCH',
  'CONTEXT_ASSEMBLE',
  'CONTEXT_PRUNE',
]);
const [modelRejected, , modelTerminated, modelUnconfirmed, modelViolation] = notCompleted(
  Type.Literal('MODEL'),
  { ...inSession, ...modelFields },
);

export const ExecutionFactSchema = Type.Union(
  [
    completed('REPOSITORY_ORIENT', OrientResultSchema, inSession),
    completed('REPOSITORY_SEARCH', SearchResultSchema, inSession),
    completed('REPOSITORY_LIST', ListResultSchema, inSession),
    completed('FILE_READ', FileReadResultSchema, inSession),
    completed('FILE_WRITE', FileWriteResultSchema, inSession),
    completed('FILE_EDIT', FileWriteResultSchema, inSession),
    completed('OUTPUT_READ', OutputReadResultSchema, inSession),
    completed('COMMAND', CommandResultSchema, inSession),
    completed('GIT_INSPECT', GitInspectResultSchema, inSession),
    completed('WEB_SEARCH', WebSearchResultSchema, inSession),
    completed('WEB_FETCH', WebFetchResultSchema, inSession),
    completed('CONTEXT_ASSEMBLE', AssembleResultSchema, inSession),
    completed('CONTEXT_PRUNE', PruneResultSchema, inSession),
    completed('MODEL', ModelResultSchema, {
      ...inSession,
      requestState: Type.Literal('SENT'),
      usage: Type.Optional(TokenUsageSchema),
    }),
    ...notCompleted(NON_MODEL_KINDS, inSession),
    modelRejected,
    closed({
      ...fact,
      ...started,
      ...inSession,
      ...modelFields,
      executionKind: Type.Literal('MODEL'),
      outcome: Type.Literal('FAILED'),
      reasonCode: reasonCodeOf(EXECUTOR_FAILED_CODES),
      retryable: Type.Boolean(),
      /** From Retry-After; the wait is the larger of this and the back-off (Execution 4a). */
      retryAfterMs: Type.Optional(count()),
    }),
    modelTerminated,
    modelUnconfirmed,
    modelViolation,
  ],
  { $id: 'kernel.execution.ExecutionFact.v1' },
);
export type ExecutionFact = Static<typeof ExecutionFactSchema>;
