import { describe, expect, it } from 'vitest';
import { runTask } from './harness.js';
import { TASKS, type AcceptanceTask } from './tasks.js';
import { TRAPS } from './traps.js';

const cases = (tasks: readonly AcceptanceTask[]) => tasks.map((task) => [task.id, task] as const);

// Offline runs of the whole product chain with a scripted provider and no network
// (M1ReleasePlan R2.3, R2.4). Real-model runs of the same tasks are `pnpm run acceptance` and
// are not part of the quality gate.
describe('fixed task set, offline (M1Plan 6)', () => {
  it.each(cases(TASKS))(
    '%s reaches its acceptance assertions',
    async (_id, task) => {
      const result = await runTask(task);
      expect(result.failures).toEqual([]);
      expect(result.record).toMatchObject({ exitCode: 0, closeReason: 'COMPLETED' });
    },
    60_000,
  );
});

describe('security traps of issue #6, offline', () => {
  it.each(cases(TRAPS))(
    '%s holds',
    async (_id, task) => {
      const result = await runTask(task);
      expect(result.failures).toEqual([]);
    },
    60_000,
  );
});
