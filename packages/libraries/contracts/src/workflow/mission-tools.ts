import { Type, type Static } from 'typebox';
import { closed, text } from '../platform-common/schema-helpers.js';

/** The longest a task may sleep before it is woken anyway (Orchestration 4.2). */
export const MAX_SLEEP_SECONDS = 3600;
/** A backstop, not the way to wait: events wake a task long before (Orchestration 4.2). */
export const DEFAULT_SLEEP_SECONDS = 600;

/**
 * What the model may wait for with `sleep` (Orchestration 4.2). The answer of a question is not
 * among them: `ask_user` waits for it by itself.
 */
export const SleepConditionSchema = Type.Union([
  /** Default `any`: woken as each subtask ends, to use its result at once (D28). */
  closed({
    kind: Type.Literal('children'),
    mode: Type.Optional(Type.Enum(['all', 'any'])),
    names: Type.Optional(Type.Array(text(64), { minItems: 1, maxItems: 12 })),
  }),
  /** Sibling tasks: default `all` of the named ones (or of all siblings), woken when they end (D28). */
  closed({
    kind: Type.Literal('siblings'),
    mode: Type.Optional(Type.Enum(['all', 'any'])),
    names: Type.Optional(Type.Array(text(64), { minItems: 1, maxItems: 12 })),
  }),
  closed({
    kind: Type.Literal('jobs'),
    mode: Type.Optional(Type.Enum(['all', 'any'])),
    jobIds: Type.Optional(Type.Array(text(32), { minItems: 1, maxItems: 8 })),
  }),
  closed({ kind: Type.Literal('message') }),
  closed({
    kind: Type.Literal('timer'),
    seconds: Type.Integer({ minimum: 1, maximum: MAX_SLEEP_SECONDS }),
  }),
]);
export type SleepCondition = Static<typeof SleepConditionSchema>;

/**
 * Parameters of `sleep` (Orchestration 4.1): the segment ends, and the task is woken by any one of
 * `until`, or when `timeoutSeconds` pass. `note` is what the next segment reads first.
 */
export const SleepArgsSchema = closed(
  {
    until: Type.Array(SleepConditionSchema, { minItems: 1, maxItems: 4 }),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SLEEP_SECONDS })),
    note: Type.Optional(text(1000)),
  },
  'workflow.SleepArgs.v1',
);
export type SleepArgs = Static<typeof SleepArgsSchema>;

/** Parameters of `job_output` (Orchestration 6.2): what a job printed since the last read. */
export const JobOutputArgsSchema = closed(
  {
    jobId: text(32),
    /** Read from the start of what is still kept instead of from the last read. */
    fromStart: Type.Optional(Type.Boolean()),
  },
  'workflow.JobOutputArgs.v1',
);
export type JobOutputArgs = Static<typeof JobOutputArgsSchema>;

/** Parameters of `job_kill` (Orchestration 6.2). */
export const JobKillArgsSchema = closed(
  { jobId: text(32), reason: Type.Optional(text(400)) },
  'workflow.JobKillArgs.v1',
);
export type JobKillArgs = Static<typeof JobKillArgsSchema>;

/** `job_list` takes nothing. */
export const JobListArgsSchema = closed({}, 'workflow.JobListArgs.v1');
export type JobListArgs = Static<typeof JobListArgsSchema>;

/**
 * Parameters of `send_message` (Orchestration 5): to the parent, all children, all siblings, or a
 * child or sibling by its task name. The text is material for the receiver, never an instruction
 * it has to follow, and it carries no permission.
 */
export const SendMessageArgsSchema = closed(
  {
    to: text(64),
    /**
     * inform (default) tells; request asks for something and expects a reply; reply answers a
     * request (`replyTo`), and goes to the task that asked whatever `to` says (D25).
     */
    kind: Type.Optional(Type.Enum(['inform', 'request', 'reply'])),
    /** What the receiver reads first: one or two lines. */
    summary: Type.Optional(text(300)),
    text: text(4000),
    /**
     * Tool calls of the sender's own, handed over with the message: the receiver reads them with
     * read_output (`ref_N/<toolCallId>`). Only to one task.
     */
    references: Type.Optional(Type.Array(text(64), { minItems: 1, maxItems: 8 })),
    /** The id of the request this answers (shown with the request). */
    replyTo: Type.Optional(text(64)),
    /**
     * Interrupts the receiver (Orchestration 5.2, D20, D21): only to a child of the sender. The
     * receiver ends its round, and a new segment starts with the message at the end of its context.
     */
    interrupt: Type.Optional(Type.Boolean()),
  },
  'workflow.SendMessageArgs.v1',
);
export type SendMessageArgs = Static<typeof SendMessageArgsSchema>;

/** Parameters of `view_tasks` (Orchestration 3.7): none; the result is the tree as it is now. */
export const ViewTasksArgsSchema = closed({}, 'workflow.ViewTasksArgs.v1');
export type ViewTasksArgs = Static<typeof ViewTasksArgsSchema>;

/**
 * Parameters of `stop_subagents` (Orchestration 5.1, D19): children of the caller by task name, or
 * `all` for every child that has not ended. They stop with their whole subtree.
 */
export const StopSubagentsArgsSchema = closed(
  {
    names: Type.Array(text(64), { minItems: 1, maxItems: 12 }),
    reason: text(500),
  },
  'workflow.StopSubagentsArgs.v1',
);
export type StopSubagentsArgs = Static<typeof StopSubagentsArgsSchema>;
