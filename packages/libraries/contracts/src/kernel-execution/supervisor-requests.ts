import type { Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import { closed, count } from '../platform-common/schema-helpers.js';

/** Cancels every execution of the run whose runEpoch is lower than this one. */
export const CancelRunExecutionsRequestSchema = closed(
  { workflowRunId: IdSchemas.workflowRunId, runEpoch: count(1) },
  'kernel.execution.CancelRunExecutionsRequest.v0',
);
export type CancelRunExecutionsRequest = Static<typeof CancelRunExecutionsRequestSchema>;

/** `requestId` is the one of the ShutdownRequest that triggered the shutdown. */
export const SupervisorShutdownRequestSchema = closed(
  { requestId: IdSchemas.requestId },
  'kernel.execution.SupervisorShutdownRequest.v0',
);
export type SupervisorShutdownRequest = Static<typeof SupervisorShutdownRequestSchema>;
