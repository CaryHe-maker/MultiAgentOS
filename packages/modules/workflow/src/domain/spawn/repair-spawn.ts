import { SubagentTaskSchema, validate } from '@multiagentos/contracts';

/**
 * What a `run_subagents` call becomes before its form is checked (D56): a detail of one task does
 * not cost the caller the whole call. What can be set right is (a role cut to its length, an
 * effort that is no effort left out, a field the call no longer has dropped, a goal or a criterion
 * too long for the graph cut there while the call keeps it whole), and a task that is still not
 * valid is taken out, with every task that waits for it, and said why. The tasks left are checked
 * and started as any call.
 */
export interface RepairedSpawn {
  readonly args: unknown;
  /** One line per task taken out, and per correction worth telling. */
  readonly notes: readonly string[];
  /** The tasks whose goal or criteria were cut: the call holds them whole. */
  readonly cut: readonly string[];
}

export const GOAL_CHARS = 4000;
export const CRITERION_CHARS = 300;
const ROLE_CHARS = 80;
const EFFORTS = new Set(['none', 'low', 'high', 'max']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first reason the form of a task is refused, said for the model to act on. */
function formError(task: unknown): string | undefined {
  const checked = validate(SubagentTaskSchema, task);
  if (checked.ok) return undefined;
  // "/name must be ..." reads as "name must be ..."; the task as a whole has no path.
  return checked.issues
    .map((issue) => issue.replace(/^\/ /u, 'the task ').replace(/^\//u, ''))
    .join('; ');
}

export function repairSpawnArgs(args: unknown): RepairedSpawn {
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
    if (Array.isArray(task['acceptance']))
      task['acceptance'] = task['acceptance'].map((each: unknown) => {
        if (typeof each !== 'string' || each.length <= CRITERION_CHARS) return each;
        shortened = true;
        return each.slice(0, CRITERION_CHARS);
      });
    const error = formError(task);
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
