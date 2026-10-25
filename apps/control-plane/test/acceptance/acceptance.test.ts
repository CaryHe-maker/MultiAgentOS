import { describe, expect, it } from 'vitest';
import { runTask, uncitedSources } from './harness.js';
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

describe('expected sources', () => {
  const at = (path: string, startLine: number, endLine: number) => ({ path, startLine, endLine });
  const f5 = TASKS.find((task) => task.id === 'F5')?.expectedSources ?? [];

  it('accept either alternative of a list and require every plain range', () => {
    const queue = at('src/holds/hold-queue.ts', 30, 42);
    expect(uncitedSources([queue, at('src/events/event-bus.ts', 1, 16)], f5)).toEqual([]);
    // The answer of the R3.6 baseline: it cites the publishing call, not the bus.
    expect(uncitedSources([queue, at('src/loans/loan-service.ts', 39, 50)], f5)).toEqual([]);
    expect(uncitedSources([queue, at('src/loans/loan-service.ts', 39, 47)], f5)).toEqual([
      'src/events/event-bus.ts:13-15 or src/loans/loan-service.ts:48-48',
    ]);
    expect(uncitedSources([at('src/events/event-bus.ts', 13, 15)], f5)).toEqual([
      'src/holds/hold-queue.ts:36-42',
    ]);
  });
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
