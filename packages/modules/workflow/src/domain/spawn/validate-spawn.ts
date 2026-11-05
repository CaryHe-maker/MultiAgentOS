import {
  normalizeRequestPath,
  writeRootCovers,
  writeRootsOverlap,
  type RunSubagentsArgs,
  type ThinkingEffort,
} from '@multiagentos/contracts';

/**
 * The one validation of `run_subagents` (M2Design 3.6): either every task is accepted, or the call
 * does not run and the caller is told each rule that failed. The budget rule belongs to the
 * Kernel, which alone knows what can be lent.
 */
export type SpawnErrorCode =
  | 'TOO_MANY_TASKS'
  | 'DUPLICATE_NAME'
  | 'UNKNOWN_DEPENDENCY'
  | 'CYCLE'
  | 'TOO_DEEP'
  | 'UNKNOWN_AGENT'
  | 'WRITE_SCOPE_REQUIRED'
  | 'WRITE_SCOPE_FORBIDDEN'
  | 'WRITE_SCOPE_OUTSIDE'
  | 'WRITE_SCOPE_OVERLAP'
  | 'EFFORT_NOT_ALLOWED'
  | 'INPUT_NOT_READABLE'
  | 'SPAWN_LIMIT';

export interface SpawnError {
  readonly code: SpawnErrorCode;
  readonly task?: string;
  readonly message: string;
}

export interface SpawnAgentFacts {
  /** The Agent may write, so a task for it names the files it may change. */
  readonly writes: boolean;
  readonly allowedEfforts: readonly ThinkingEffort[];
}

export interface SpawnRules {
  readonly maxSubagentsPerCall: number;
  readonly maxDependencyDepth: number;
  readonly maxTasks: number;
  readonly maxSpawnCalls: number;
}

export interface SpawnContext {
  readonly rules: SpawnRules;
  /** The Agents `run_subagents` may start, by id. */
  readonly agents: ReadonlyMap<string, SpawnAgentFacts>;
  /** What the caller may write, normalized. */
  readonly callerRoots: readonly string[];
  /** What this Turn spawned before this call. */
  readonly spawned: { readonly tasks: number; readonly calls: number };
  /** An artifact the caller can read itself, so it may hand it over. */
  readonly readable: (artifactId: string) => boolean;
}

export type SpawnTask = RunSubagentsArgs['tasks'][number];

export interface SpawnPlan {
  /** In the order the caller wrote them: results are joined in this order. */
  readonly tasks: readonly (SpawnTask & { readonly writeRoots: readonly string[] })[];
}

export type SpawnValidation =
  | { readonly ok: true; readonly plan: SpawnPlan }
  | { readonly ok: false; readonly errors: readonly SpawnError[] };

/** The tasks a task waits for, directly or not. */
function ancestorsOf(tasks: ReadonlyMap<string, readonly string[]>, name: string): Set<string> {
  const found = new Set<string>();
  const stack = [...(tasks.get(name) ?? [])];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (found.has(next)) continue;
    found.add(next);
    stack.push(...(tasks.get(next) ?? []));
  }
  return found;
}

/** The longest chain of tasks that wait for each other, counted in edges; undefined on a cycle. */
function depthOf(tasks: ReadonlyMap<string, readonly string[]>): number | undefined {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (name: string): number | undefined => {
    const known = depth.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return undefined;
    visiting.add(name);
    let deepest = 0;
    for (const before of tasks.get(name) ?? []) {
      const d = visit(before);
      if (d === undefined) return undefined;
      deepest = Math.max(deepest, d + 1);
    }
    visiting.delete(name);
    depth.set(name, deepest);
    return deepest;
  };
  let longest = 0;
  for (const name of tasks.keys()) {
    const d = visit(name);
    if (d === undefined) return undefined;
    longest = Math.max(longest, d);
  }
  return longest;
}

export function validateSpawn(args: RunSubagentsArgs, context: SpawnContext): SpawnValidation {
  const { rules } = context;
  const errors: SpawnError[] = [];
  const add = (code: SpawnErrorCode, message: string, task?: string) =>
    errors.push({ code, message, ...(task === undefined ? {} : { task }) });
  const { tasks } = args;

  if (tasks.length > rules.maxSubagentsPerCall)
    add(
      'TOO_MANY_TASKS',
      `this call has ${String(tasks.length)} tasks, at most ${String(rules.maxSubagentsPerCall)} are allowed`,
    );
  if (context.spawned.calls >= rules.maxSpawnCalls)
    add('SPAWN_LIMIT', `${String(rules.maxSpawnCalls)} calls of run_subagents were already made`);
  else if (context.spawned.tasks + tasks.length > rules.maxTasks)
    add(
      'SPAWN_LIMIT',
      `${String(context.spawned.tasks)} tasks were already started, at most ${String(rules.maxTasks)} are allowed`,
    );

  const names = new Set<string>();
  for (const task of tasks) {
    if (names.has(task.name))
      add('DUPLICATE_NAME', `the name ${task.name} is used twice`, task.name);
    names.add(task.name);
  }
  const waits = new Map<string, readonly string[]>();
  for (const task of tasks) {
    const before = [...new Set(task.dependsOn ?? [])];
    for (const each of before)
      if (!names.has(each))
        add(
          'UNKNOWN_DEPENDENCY',
          `${task.name} depends on ${each}, which is not in this call`,
          task.name,
        );
    waits.set(
      task.name,
      before.filter((each) => names.has(each)),
    );
  }
  const depth = names.size === tasks.length ? depthOf(waits) : 0;
  if (depth === undefined) add('CYCLE', 'the tasks wait for each other in a circle');
  else if (depth > rules.maxDependencyDepth)
    add(
      'TOO_DEEP',
      `tasks wait for each other ${String(depth)} levels deep, at most ${String(rules.maxDependencyDepth)} are allowed`,
    );

  const roots = new Map<string, readonly string[]>();
  for (const task of tasks) {
    const facts = context.agents.get(task.agent);
    if (facts === undefined) {
      add('UNKNOWN_AGENT', `${task.agent} cannot be started`, task.name);
      continue;
    }
    if (task.effort !== undefined && !facts.allowedEfforts.includes(task.effort))
      add(
        'EFFORT_NOT_ALLOWED',
        `${task.agent} allows the efforts ${facts.allowedEfforts.join(', ')}, not ${task.effort}`,
        task.name,
      );
    const scope = task.writeScope ?? [];
    if (facts.writes && scope.length === 0)
      add('WRITE_SCOPE_REQUIRED', `${task.name} needs a writeScope`, task.name);
    if (!facts.writes && scope.length > 0)
      add(
        'WRITE_SCOPE_FORBIDDEN',
        `${task.name} is a ${task.agent} and has no writeScope`,
        task.name,
      );
    const normalized: string[] = [];
    for (const path of scope) {
      const root = normalizeRequestPath(path);
      if (root === undefined || !context.callerRoots.some((own) => writeRootCovers(own, root)))
        add(
          'WRITE_SCOPE_OUTSIDE',
          `${path} is not inside what you may write (${context.callerRoots.join(', ')})`,
          task.name,
        );
      else normalized.push(root);
    }
    roots.set(task.name, normalized);
    for (const ref of task.inputs ?? [])
      if (!context.readable(ref.artifactId))
        add('INPUT_NOT_READABLE', `${ref.artifactId} is not something you can read`, task.name);
  }

  // Two tasks that can run at the same time must not write the same files.
  for (let i = 0; i < tasks.length; i += 1)
    for (let j = i + 1; j < tasks.length; j += 1) {
      const left = tasks[i];
      const right = tasks[j];
      if (left === undefined || right === undefined) continue;
      if (ancestorsOf(waits, left.name).has(right.name)) continue;
      if (ancestorsOf(waits, right.name).has(left.name)) continue;
      const a = roots.get(left.name) ?? [];
      const b = roots.get(right.name) ?? [];
      if (a.length > 0 && b.length > 0 && writeRootsOverlap(a, b))
        add(
          'WRITE_SCOPE_OVERLAP',
          `${left.name} and ${right.name} can run at the same time and write the same files; make one depend on the other or split the scopes`,
          left.name,
        );
    }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    plan: {
      tasks: tasks.map((task) => ({ ...task, writeRoots: roots.get(task.name) ?? [] })),
    },
  };
}
