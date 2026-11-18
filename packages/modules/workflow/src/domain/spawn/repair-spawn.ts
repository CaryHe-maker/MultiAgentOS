import { validate } from '@multiagentos/contracts';

type Schema = Parameters<typeof validate>[0];

/**
 * What a `run_subagents` call becomes before its form is checked (D56): a detail of one task does
 * not cost the caller the whole call. What can be set right is (a role cut to its length, an
 * effort that is no effort left out, a field the call no longer has dropped, a goal too long for
 * the graph cut there while the call keeps it whole), and a task that is still not
 * valid is taken out, with every task that waits for it, and said why. The tasks left are checked
 * and started as any call.
 */
export interface RepairedSpawn {
  readonly args: unknown;
  /** One line per task taken out, and per correction worth telling. */
  readonly notes: readonly string[];
  /** The tasks whose goal was cut: the call holds it whole. */
  readonly cut: readonly string[];
}

export const GOAL_CHARS = 4000;
const ROLE_CHARS = 80;
const EFFORTS = new Set(['none', 'low', 'high', 'max']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first reason the form of a task is refused, said for the model to act on. */
function formError(task: unknown, taskSchema: Schema): string | undefined {
  const checked = validate(taskSchema, task);
  if (checked.ok) return undefined;
  // "/name must be ..." reads as "name must be ..."; the task as a whole has no path.
  return checked.issues
    .map((issue) => issue.replace(/^\/ /u, 'the task ').replace(/^\//u, ''))
    .join('; ');
}

/**
 * The form of one task of `parameters`, the spawn tool's own (D89): the root's has `split` and
 * the specialists, a lead's has explorers and workers only (D88, D93).
 */
export function taskSchemaOf(parameters: Schema): Schema {
  const items = (parameters as { properties?: { tasks?: { items?: unknown } } }).properties?.tasks
    ?.items;
  if (typeof items !== 'object' || items === null)
    throw new Error('the spawn tool declares no form of a task');
  return items;
}

export function repairSpawnArgs(args: unknown, taskSchema: Schema): RepairedSpawn {
  if (!isRecord(args) || !Array.isArray(args['tasks'])) return { args, notes: [], cut: [] };
  const notes: string[] = [];
  const cut: string[] = [];
  const kept: Record<string, unknown>[] = [];
  const out = new Set<string>();
  (args['tasks'] as unknown[]).forEach((raw, index) => {
    const label =
      isRecord(raw) && typeof raw['name'] === 'string' ? raw['name'] : `#${String(index)}`;
    if (!isRecord(raw)) {
      notes.push(`task ${label} (index ${String(index)}) was not started: it is not an object`);
      return;
    }
    const task: Record<string, unknown> = { ...raw };
    // Every worker and explorer starts with its caller's context now (D56): the field is gone.
    delete task['context'];
    // A task has no criteria any more (Mission baseline 1, D93): what it must deliver is its goal.
    delete task['acceptance'];
    // writeScope is required (D96); left out it is empty, and the check of the call says whether
    // the task needs one (WRITE_SCOPE_REQUIRED), as it does for `[]`.
    if (task['writeScope'] === undefined) task['writeScope'] = [];
    if (typeof task['role'] === 'string' && task['role'].length > ROLE_CHARS)
      task['role'] = `${task['role'].slice(0, ROLE_CHARS - 1)}…`;
    const effort = task['effort'];
    if (effort !== undefined && !(typeof effort === 'string' && EFFORTS.has(effort))) {
      notes.push(
        `task ${label}: effort ${JSON.stringify(task['effort'])} is not none, low, high or max; it runs at its Agent's own effort`,
      );
      delete task['effort'];
    }
    let shortened = false;
    if (typeof task['goal'] === 'string' && task['goal'].length > GOAL_CHARS) {
      task['goal'] = task['goal'].slice(0, GOAL_CHARS);
      shortened = true;
    }
    const error = formError(task, taskSchema);
    if (error !== undefined) {
      notes.push(`task ${label} (index ${String(index)}) was not started: ${error}`);
      if (typeof raw['name'] === 'string') out.add(raw['name']);
      return;
    }
    if (shortened) cut.push(label);
    kept.push(task);
  });
  // A task that waits for one that was taken out cannot start either.
  for (let changed = true; changed;) {
    changed = false;
    for (const task of kept) {
      const name = task['name'] as string;
      if (out.has(name)) continue;
      const missing = ((task['dependsOn'] as string[] | undefined) ?? []).find((each) =>
        out.has(each),
      );
      if (missing === undefined) continue;
      notes.push(`task ${name} was not started: it depends on ${missing}, which was not started`);
      out.add(name);
      changed = true;
    }
  }
  const tasks = kept.filter((task) => !out.has(task['name'] as string));
  // With nothing left the call is refused as written, so the caller reads every reason.
  if (tasks.length === 0) return { args, notes, cut: [] };
  return { args: { ...args, tasks }, notes, cut: cut.filter((name) => !out.has(name)) };
}
