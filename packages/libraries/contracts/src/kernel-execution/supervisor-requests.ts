import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import { closed, count } from '../platform-common/schema-helpers.js';

/** Cancels every execution of the run whose runEpoch is lower than this one. */
export const CancelRunExecutionsRequestSchema = closed(
  { workflowRunId: IdSchemas.workflowRunId, runEpoch: count(1) },
  'kernel.execution.CancelRunExecutionsRequest.v1',
);
export type CancelRunExecutionsRequest = Static<typeof CancelRunExecutionsRequestSchema>;

/**
 * Cancels one execution (Interface/KernelSupervisor 7). `cancelRun` stays for convergence. The
 * result is still the one fact of the execution: TERMINATED, carrying why it was cancelled, so
 * that Execution can answer the Unit with INTERRUPTED(PAUSED | ABORTED).
 */
export const CancelExecutionRequestSchema = closed(
  {
    executionId: IdSchemas.executionId,
    runEpoch: count(1),
    reason: Type.Enum(['PAUSED', 'ABORTED']),
  },
  'kernel.execution.CancelExecutionRequest.v1',
);
export type CancelExecutionRequest = Static<typeof CancelExecutionRequestSchema>;

/** `requestId` is the one of the ShutdownRequest that triggered the shutdown. */
export const SupervisorShutdownRequestSchema = closed(
  { requestId: IdSchemas.requestId },
  'kernel.execution.SupervisorShutdownRequest.v1',
);
export type SupervisorShutdownRequest = Static<typeof SupervisorShutdownRequestSchema>;
