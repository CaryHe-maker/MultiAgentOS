import { describe, expect, it } from 'vitest';
import { DEFAULT_EVAL_FIXTURES_DIRECTORY, loadEvalFixtures } from './load-eval-fixtures.js';

/** 仓库里提交的题目必须一直通过离线校验；这条测试让 `pnpm run check` 守住题库。 */
describe('shipped eval fixtures', () => {
  it('have no offline validation errors', async () => {
    const { issues } = await loadEvalFixtures(DEFAULT_EVAL_FIXTURES_DIRECTORY);
    expect(issues.filter((issue) => issue.severity === 'ERROR')).toEqual([]);
  });
});
