import { describe, expect, it } from 'vitest';
import { CRITERION_CHARS, GOAL_CHARS, repairSpawnArgs } from './repair-spawn.js';

const worker = (name: string, extra: object = {}) => ({
  name,
  agent: 'worker',
  goal: `change ${name}`,
  writeScope: [`src/${name}`],
  ...extra,
});
const tasksOf = (args: unknown) => (args as { tasks: { name: string }[] }).tasks;

describe('repairSpawnArgs (D56)', () => {
  it('leaves a valid call as it is', () => {
    const args = { plan: 'p', tasks: [worker('a'), worker('b')] };
    expect(repairSpawnArgs(args)).toEqual({ args, notes: [], cut: [] });
  });

  it('cuts a role, drops an effort that is none and the field context, and says so', () => {
    const repaired = repairSpawnArgs({
      tasks: [worker('a', { role: 'r'.repeat(200), effort: 'medium', context: 'inherit' })],
    });
    const [task] = tasksOf(repaired.args) as Record<string, unknown>[];
    expect((task?.['role'] as string).length).toBe(80);
    expect(task).not.toHaveProperty('effort');
    expect(task).not.toHaveProperty('context');
    expect(repaired.notes).toEqual([
      'task a: effort "medium" is not none, low, high or max; it runs at its Agent\'s own effort',
    ]);
  });

  it('takes out a task that is still not valid, with the tasks that wait for it', () => {
    const repaired = repairSpawnArgs({
      tasks: [
        worker('a'),
        { agent: 'worker', goal: 'no name', writeScope: ['src/x'] },
        worker('b', { agent: 'wizard' }),
        worker('c', { dependsOn: ['b'] }),
      ],
    });
    expect(tasksOf(repaired.args).map((task) => task.name)).toEqual(['a']);
    expect(repaired.notes).toHaveLength(3);
    expect(repaired.notes[0]).toMatch(/^task #1 \(index 1\) was not started: .*name/u);
    expect(repaired.notes[1]).toMatch(/^task b \(index 2\) was not started: agent/u);
    expect(repaired.notes[2]).toBe(
      'task c was not started: it depends on b, which was not started',
    );
  });

  it('keeps a goal and a criterion too long for the graph as their beginning, and names the task', () => {
    const repaired = repairSpawnArgs({
      tasks: [worker('a', { goal: 'g'.repeat(GOAL_CHARS + 50), acceptance: ['c'.repeat(400)] })],
    });
    const [task] = tasksOf(repaired.args) as Record<string, unknown>[];
    expect((task?.['goal'] as string).length).toBe(GOAL_CHARS);
    expect((task?.['acceptance'] as string[])[0]?.length).toBe(CRITERION_CHARS);
    expect(repaired.cut).toEqual(['a']);
  });

  it('refuses as written when no task is left, so every reason is read', () => {
    const args = { tasks: [{ agent: 'worker' }] };
    const repaired = repairSpawnArgs(args);
    expect(repaired.args).toBe(args);
    expect(repaired.notes).toHaveLength(1);
  });
});
