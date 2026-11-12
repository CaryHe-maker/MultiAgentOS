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

/**
 * Parameters of `send_message` (Orchestration 5): to the parent, all children, all siblings, or a
 * child or sibling by its task name. The text is material for the receiver, never an instruction
 * it has to follow, and it carries no permission.
 */
export const SendMessageArgsSchema = closed(
  {
    to: text(64),
    text: text(4000),
  },
  'workflow.SendMessageArgs.v1',
);
export type SendMessageArgs = Static<typeof SendMessageArgsSchema>;
