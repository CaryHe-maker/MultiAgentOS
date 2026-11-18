import { Type, type Static } from 'typebox';
import { closed, text } from '../platform-common/schema-helpers.js';

/**
 * The arguments of `update_todos`: the whole list each time (M2Design 3.5). Several items may be
 * in progress at once, as work that runs in parallel is.
 */
export const UpdateTodosArgsSchema = closed(
  {
    todos: Type.Array(
      closed({
        content: text(200),
        status: Type.Enum(['pending', 'in_progress', 'completed', 'cancelled']),
      }),
      { maxItems: 30 },
    ),
  },
  'workflow.UpdateTodosArgs.v1',
);
export type UpdateTodosArgs = Static<typeof UpdateTodosArgsSchema>;
