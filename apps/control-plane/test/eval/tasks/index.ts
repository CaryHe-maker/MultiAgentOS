/**
 * Every task the evaluation system knows. A new task set is a file in this directory that
 * exports an array, added here; nothing else changes (docs/M2/Evaluation.md 7).
 */
import type { TaskSpec } from '../spec.js';
import { SELFCHECK_TASKS } from './selfcheck.js';

export const ALL_TASKS: readonly TaskSpec[] = [...SELFCHECK_TASKS];

/** `selfcheck.answer`, or a tag as `tag:safety`, or `all`. */
export function select(tasks: readonly TaskSpec[], wanted: readonly string[]): TaskSpec[] {
  if (wanted.length === 0 || wanted.includes('all')) return [...tasks];
  return tasks.filter((task) =>
    wanted.some((each) =>
      each.startsWith('tag:') ? task.tags.includes(each.slice(4)) : task.id === each,
    ),
  );
}
