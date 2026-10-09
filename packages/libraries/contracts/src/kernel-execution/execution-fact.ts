import { Type, type Static } from 'typebox';
import { TokenUsageSchema } from '../executor/model-call.js';
import { UnitOutputSchema } from '../kernel-unit/unit-io.js';
import { IdSchemas } from '../platform-common/ids.js';
import { ReasonCodeSchema } from '../platform-common/reason-code.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';

/** `artifact` is written to the ArtifactStore by Execution, which produces `outputRef`. */
export const ExecutionResultSchema = closed(
  {
    output: UnitOutputSchema,
    artifact: Type.Optional(closed({ mediaType: text(128), text: Type.String() })),
  },
  'kernel.execution.ExecutionResult.v0',
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
  runEpoch: count(1),
  usage: Type.Optional(TokenUsageSchema),
  // Required for MODEL.
  requestState: Type.Optional(RequestStateSchema),
  // Absent when the execution was cancelled before it started.
  startedAt: Type.Optional(TimestampSchema),
  endedAt: TimestampSchema,
};
/** Exactly one per executionId; the Supervisor gives the single verdict. */
export const ExecutionFactSchema = Type.Union(
  [
    closed({ ...fact, outcome: Type.Literal('COMPLETED'), result: ExecutionResultSchema }),
    closed({
      ...fact,
      outcome: Type.Literal('FAILED'),
      reasonCode: ReasonCodeSchema,
      retryable: Type.Boolean(),
    }),
    closed({
      ...fact,
      outcome: Type.Enum(['REJECTED', 'TERMINATED', 'VIOLATION', 'STOP_UNCONFIRMED']),
      reasonCode: ReasonCodeSchema,
    }),
  ],
  { $id: 'kernel.execution.ExecutionFact.v0' },
);
export type ExecutionFact = Static<typeof ExecutionFactSchema>;
