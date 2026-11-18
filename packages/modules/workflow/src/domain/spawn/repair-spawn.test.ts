import { RunSubagentsArgsSchema, RunSubagentsNestedArgsSchema } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { GOAL_CHARS, repairSpawnArgs, taskSchemaOf } from './repair-spawn.js';

const worker = (name: string, extra: object = {}) => ({
  name,
  agent: 'worker',
  goal: `change ${name}`,
  writeScope: [`src/${name}`],
  ...extra,
});
/** The form of a task of the root's spawn tool. */
const ROOT = taskSchemaOf(RunSubagentsArgsSchema);
const tasksOf = (args: unknown) => (args as { tasks: { name: string }[] }).tasks;

describe('repairSpawnArgs (D56)', () => {
  it('leaves a valid call as it is', () => {
    const args = { plan: 'p', tasks: [worker('a'), worker('b')] };
    expect(repairSpawnArgs(args, ROOT)).toEqual({ args, notes: [], cut: [] });
  });

  it('cuts a role, drops an effort that is none and the fields context and acceptance, and says so', () => {
    const repaired = repairSpawnArgs(
      {
        tasks: [
          worker('a', {
            role: 'r'.repeat(200),
            effort: 'medium',
            context: 'inherit',
            acceptance: ['tests pass'],
          }),
        ],
      },
      ROOT,
    );
    const [task] = tasksOf(repaired.args) as Record<string, unknown>[];
    expect((task?.['role'] as string).length).toBe(80);
    expect(task).not.toHaveProperty('effort');
    expect(task).not.toHaveProperty('context');
    expect(task).not.toHaveProperty('acceptance');
    expect(repaired.notes).toEqual([
      'task a: effort "medium" is not none, low, high or max; it runs at its Agent\'s own effort',
    ]);
  });

  it('takes out a task that is still not valid, with the tasks that wait for it', () => {
    const repaired = repairSpawnArgs(
      {
        tasks: [
          worker('a'),
          { agent: 'worker', goal: 'no name', writeScope: ['src/x'] },
          worker('b', { agent: 'wizard' }),
          worker('c', { dependsOn: ['b'] }),
        ],
      },
      ROOT,
    );
    expect(tasksOf(repaired.args).map((task) => task.name)).toEqual(['a']);
    expect(repaired.notes).toHaveLength(3);
    expect(repaired.notes[0]).toMatch(/^task #1 \(index 1\) was not started: .*name/u);
    expect(repaired.notes[1]).toMatch(/^task b \(index 2\) was not started: agent/u);
    expect(repaired.notes[2]).toBe(
      'task c was not started: it depends on b, which was not started',
    );
  });

  it('takes a writeScope left out as empty, for the check of the call to judge (D96)', () => {
    const repaired = repairSpawnArgs(
      {
        tasks: [
          { name: 'look', agent: 'explorer', goal: 'look around' },
          { name: 'build', agent: 'worker', goal: 'build it' },
        ],
      },
      ROOT,
    );
    expect(repaired.notes).toEqual([]);
    expect(tasksOf(repaired.args)).toEqual([
      expect.objectContaining({ name: 'look', writeScope: [] }),
      expect.objectContaining({ name: 'build', writeScope: [] }),
    ]);
  });

  it('keeps a goal too long for the graph as its beginning, and names the task', () => {
    const repaired = repairSpawnArgs(
      {
        tasks: [worker('a', { goal: 'g'.repeat(GOAL_CHARS + 50) })],
      },
      ROOT,
    );
    const [task] = tasksOf(repaired.args) as Record<string, unknown>[];
    expect((task?.['goal'] as string).length).toBe(GOAL_CHARS);
    expect(repaired.cut).toEqual(['a']);
  });

  it('refuses as written when no task is left, so every reason is read', () => {
    const args = { tasks: [{ agent: 'worker' }] };
    const repaired = repairSpawnArgs(args, ROOT);
    expect(repaired.args).toBe(args);
    expect(repaired.notes).toHaveLength(1);
  });
});

describe('the form of a task is the one of the spawn tool (D88, D89)', () => {
  it('keeps a task with split for the root, and takes it out below it, where the field is not', () => {
    const tasks = [
      { name: 'big', agent: 'worker', split: true, goal: 'the large part', writeScope: ['src'] },
      { name: 'small', agent: 'worker', goal: 'the small part', writeScope: ['docs'] },
    ];
    expect(repairSpawnArgs({ tasks }, ROOT).notes).toEqual([]);
    const nested = repairSpawnArgs({ tasks }, taskSchemaOf(RunSubagentsNestedArgsSchema));
    expect(nested.notes.join('\n')).toContain('task big (index 0) was not started');
  });

  it('offers a specialist to the root only: a lead starts explorers and workers (D93)', () => {
    const tasks = [
      { name: 'fix', agent: 'fixer', goal: 'make the check pass', writeScope: ['src'] },
    ];
    expect(repairSpawnArgs({ tasks }, ROOT).notes).toEqual([]);
    const nested = repairSpawnArgs({ tasks }, taskSchemaOf(RunSubagentsNestedArgsSchema));
    expect(nested.notes.join('\n')).toContain('task fix (index 0) was not started: agent');
  });
});
