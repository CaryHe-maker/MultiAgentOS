import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import { MODEL_PROGRESS_MAX_DELTA } from '../kernel-execution/model-progress.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';

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
      kind: Type.Literal('REASONING'),
      delta: text(MODEL_PROGRESS_MAX_DELTA),
    }),
    closed({ ...stream, kind: Type.Literal('ANSWER') }),
    closed({
      ...stream,
      kind: Type.Literal('TOOL'),
      name: text(64),
      target: Type.Optional(text(512)),
    }),
    /**
     * How full the context of main is, as the assembly of its next call counts it. `callId` is the
     * assembly's execution; `limit` is the `perCallInputLimit` the share is of.
     */
    closed({ ...stream, kind: Type.Literal('CONTEXT'), used: count(), limit: count(1) }),
    closed({ ...stream, kind: Type.Literal('END') }),
  ],
  { $id: 'kernel.control.ModelStream.v1' },
);
export type ModelStream = Static<typeof ModelStreamSchema>;
