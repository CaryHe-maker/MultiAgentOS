import { Type, type Static } from 'typebox';
import { closed, text } from '../platform-common/schema-helpers.js';

/** The longest a task may sleep before it is woken anyway (Orchestration 4.2). */
export const MAX_SLEEP_SECONDS = 3600;
export const DEFAULT_SLEEP_SECONDS = 1800;

/**
 * What the model may wait for with `sleep` (Orchestration 4.2). The answer of a question is not
 * among them: `ask_user` waits for it by itself.
 */
export const SleepConditionSchema = Type.Union([
  closed({
    kind: Type.Literal('children'),
    mode: Type.Enum(['all', 'any']),
    names: Type.Optional(Type.Array(text(64), { minItems: 1, maxItems: 12 })),
  }),
  closed({
    kind: Type.Literal('jobs'),
    mode: Type.Enum(['all', 'any']),
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
    text: text(4000),
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
