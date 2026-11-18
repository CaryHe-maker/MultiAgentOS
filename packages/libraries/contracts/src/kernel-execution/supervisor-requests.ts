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

/** How much of a job's output one read returns at most (Orchestration 6.2). */
export const JOB_READ_MAX_BYTES = 32_768;
/** What the end of a job carries of its output: the end of what it printed. */
export const JOB_TAIL_BYTES = 2048;

/**
 * Reads or stops a job, a command that runs on after its execution ended (Orchestration 6.1,
 * 6.2). `jobKey` is the executionId of the execution it detached from.
 */
export const JobControlRequestSchema = closed(
  {
    workflowRunId: IdSchemas.workflowRunId,
    jobKey: IdSchemas.executionId,
    action: Type.Enum(['READ', 'STOP']),
    /** READ: from this byte of everything it printed. */
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: JOB_READ_MAX_BYTES })),
  },
  'kernel.execution.JobControlRequest.v1',
);
export type JobControlRequest = Static<typeof JobControlRequestSchema>;

/** How a job ended, as the Supervisor saw it. */
export const JobExitSchema = closed({
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
  stopped: Type.Boolean(),
  /** Stopped at `jobMaxSeconds`. */
  timedOut: Type.Boolean(),
  unconfirmed: Type.Boolean(),
});
export type JobExit = Static<typeof JobExitSchema>;

/** What a job control answers; `found: false` for a job this Supervisor does not know. */
export const JobControlResultSchema = Type.Union(
  [
    closed({ found: Type.Literal(false) }),
    closed({
      found: Type.Literal(true),
      /** READ: the bytes from `offset` (or from the oldest still kept), and where the next read starts. */
      text: Type.String(),
      offset: Type.Integer({ minimum: 0 }),
      nextOffset: Type.Integer({ minimum: 0 }),
      /** Bytes between the asked offset and the oldest byte still kept. */
      skipped: Type.Integer({ minimum: 0 }),
      totalBytes: Type.Integer({ minimum: 0 }),
      exit: Type.Optional(JobExitSchema),
    }),
  ],
  { $id: 'kernel.execution.JobControlResult.v1' },
);
export type JobControlResult = Static<typeof JobControlResultSchema>;

/** A job has ended (Orchestration 6.4): the Supervisor tells the Kernel core. */
export const JobEndedFactSchema = closed(
  {
    sessionId: IdSchemas.sessionId,
    workflowRunId: IdSchemas.workflowRunId,
    jobKey: IdSchemas.executionId,
    exit: JobExitSchema,
    durationMs: Type.Integer({ minimum: 0 }),
    totalBytes: Type.Integer({ minimum: 0 }),
    /** The last `JOB_TAIL_BYTES` it printed. */
    tail: Type.String(),
  },
  'kernel.execution.JobEndedFact.v1',
);
export type JobEndedFact = Static<typeof JobEndedFactSchema>;
