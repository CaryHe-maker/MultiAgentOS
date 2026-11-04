import { Type, type Static } from 'typebox';
import { closed, text } from '../platform-common/schema-helpers.js';

/** The arguments of `update_todos`: the whole list each time (M2Design 3.5). */
export const UpdateTodosArgsSchema = Type.Refine(
  closed(
    {
      todos: Type.Array(
        closed({
          content: text(200),
          status: Type.Enum(['pending', 'in_progress', 'done', 'cancelled']),
        }),
        { maxItems: 30 },
      ),
    },
    'workflow.UpdateTodosArgs.v1',
  ),
  (args) => args.todos.filter((todo) => todo.status === 'in_progress').length <= 1,
  () => 'at most one todo may be in progress',
);
export type UpdateTodosArgs = Static<typeof UpdateTodosArgsSchema>;
