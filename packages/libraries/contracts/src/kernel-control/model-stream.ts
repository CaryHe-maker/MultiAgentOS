import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import { MODEL_PROGRESS_MAX_DELTA } from '../kernel-execution/model-progress.js';
import { TimestampSchema, closed, text } from '../platform-common/schema-helpers.js';

/**
 * Kernel core to UserInteraction: a piece of what one model call is thinking (see
 * `kernel.execution.ModelProgress`). It travels beside the ordered event sequences: no `eventId`,
 * no `seq`, and a receiver that is late or absent simply misses it. `callId` is the execution of
 * the call, so a viewer can tell one call's thinking from the next.
 */
const stream = {
  sessionId: IdSchemas.sessionId,
  workflowRunId: IdSchemas.workflowRunId,
  agentRunId: IdSchemas.agentRunId,
  callId: IdSchemas.executionId,
  at: TimestampSchema,
};

export const ModelStreamSchema = Type.Union(
  [
    closed({
      ...stream,
      kind: Type.Enum(['REASONING', 'TEXT']),
      delta: text(MODEL_PROGRESS_MAX_DELTA),
    }),
    closed({ ...stream, kind: Type.Literal('END') }),
  ],
  { $id: 'kernel.control.ModelStream.v1' },
);
export type ModelStream = Static<typeof ModelStreamSchema>;
