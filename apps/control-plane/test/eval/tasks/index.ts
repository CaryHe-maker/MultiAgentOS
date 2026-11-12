/**
 * Every task the evaluation system knows. A new task set is a file in this directory that
 * exports an array, added here; nothing else changes (docs/M2/Evaluation.md 7).
 */
import type { TaskSpec } from '../spec.js';
import { DELIVERY_TASKS } from './delivery.js';
import { EXTERNAL_TASKS } from './external.js';
import { SUBAGENT_TASKS } from './subagents.js';
import { SELFCHECK_TASKS } from './selfcheck.js';
import { ORCHESTRATION_TASKS } from './orchestration.js';
import { ORCHESTRATION_HARD_TASKS } from './orchestration-hard.js';

export const ALL_TASKS: readonly TaskSpec[] = [
  ...SELFCHECK_TASKS,
  ...DELIVERY_TASKS,
  ...SUBAGENT_TASKS,
  ...EXTERNAL_TASKS,
  ...ORCHESTRATION_TASKS,
  ...ORCHESTRATION_HARD_TASKS,
];

/** `selfcheck.answer`, or a tag as `tag:safety`, or `all`. */
export function select(tasks: readonly TaskSpec[], wanted: readonly string[]): TaskSpec[] {
  if (wanted.length === 0 || wanted.includes('all')) return [...tasks];
  return tasks.filter((task) =>
    wanted.some((each) =>
      each.startsWith('tag:') ? task.tags.includes(each.slice(4)) : task.id === each,
    ),
  );
}
