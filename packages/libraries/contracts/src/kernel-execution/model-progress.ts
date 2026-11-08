import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, text } from '../platform-common/schema-helpers.js';

/** The most one progress message carries; the sender splits and merges to stay within it. */
export const MODEL_PROGRESS_MAX_DELTA = 16_384;

/**
 * What a model call shows while it is still running: a piece of the thinking the provider streams,
 * and the end of the stream (docs/M2/Phase1Console.md 4). It is for the person watching and for
 * nothing else: it is not a fact, has no sequence number, is never written to the Session log and
 * is dropped when nobody can take it, so no decision may depend on it. The call's result and its
 * thinking, in full, still arrive once, as the one fact of the execution.
 */
const progress = {
  sessionId: IdSchemas.sessionId,
  workflowRunId: IdSchemas.workflowRunId,
  executionId: IdSchemas.executionId,
  at: TimestampSchema,
};

/** Supervisor to Kernel core. */
export const ModelProgressSchema = Type.Union(
  [
    closed({
      ...progress,
      kind: Type.Enum(['REASONING', 'TEXT']),
      delta: text(MODEL_PROGRESS_MAX_DELTA),
    }),
    closed({ ...progress, kind: Type.Literal('END') }),
  ],
  { $id: 'kernel.execution.ModelProgress.v1' },
);
export type ModelProgress = Static<typeof ModelProgressSchema>;
