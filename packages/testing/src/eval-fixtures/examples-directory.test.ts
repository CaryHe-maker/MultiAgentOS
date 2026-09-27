import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEvalFixtures } from './load-eval-fixtures.js';

const EXAMPLES_DIRECTORY = fileURLToPath(new URL('../../fixtures/eval/examples', import.meta.url));

/** 格式示例也要一直合法，否则文档会悄悄过时。 */
describe('eval fixture examples', () => {
  it('load the WEB example with its recorded snapshot and no errors', async () => {
    const { tasks, snapshots, issues } = await loadEvalFixtures(EXAMPLES_DIRECTORY);
    expect(issues.filter((issue) => issue.severity === 'ERROR')).toEqual([]);
    expect(issues.map((issue) => issue.code)).toContain('NOT_RUNNABLE_IN_M1');
    expect(tasks.map(({ task }) => task.id)).toEqual(['WEB-001']);
    expect([...snapshots.keys()]).toEqual(['WEB-001']);
  });
});
