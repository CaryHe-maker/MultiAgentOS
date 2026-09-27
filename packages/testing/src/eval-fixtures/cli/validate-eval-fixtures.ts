import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GitCliRepositoryReader, checkRepositoryEvidence } from '../check-repository-evidence.js';
import { summarizeIssues } from '../format-issues.js';
import { DEFAULT_EVAL_FIXTURES_DIRECTORY, loadEvalFixtures } from '../load-eval-fixtures.js';

/**
 * `pnpm run eval:fixtures [--repos] [--root <dir>] [--cache <dir>]`
 *
 * 默认只做离线检查（与 `pnpm run check` 中的测试相同）。加 `--repos` 时克隆被测仓库，
 * 在固定 commit 下核对证据路径和行号；这一步需要网络，因此不属于质量门。
 * 存在 ERROR 时退出码为 1。
 */
// pnpm 可能把 `--` 原样转发过来（`pnpm run eval:fixtures -- --repos`），忽略它。
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    repos: { type: 'boolean', default: false },
    root: { type: 'string' },
    cache: { type: 'string' },
  },
});

const root = resolve(values.root ?? DEFAULT_EVAL_FIXTURES_DIRECTORY);
const fixtureSet = await loadEvalFixtures(root);
const issues = [...fixtureSet.issues];

if (values.repos) {
  const cacheDirectory = resolve(values.cache ?? join(process.cwd(), '.multiagent', 'eval-cache'));
  const reader = new GitCliRepositoryReader({ cacheDirectory });
  issues.push(...(await checkRepositoryEvidence(fixtureSet.tasks, reader)));
}

const summary = summarizeIssues(issues);
for (const line of summary.lines) console.log(line);
const splits = ['dev', 'holdout'].map(
  (split) => `${split}=${fixtureSet.tasks.filter((task) => task.split === split).length}`,
);
console.log(
  `${fixtureSet.tasks.length} task(s) (${splits.join(', ')}), ${summary.errors} error(s), ` +
    `${summary.warnings} warning(s)${values.repos ? '' : '; repository checks skipped (use --repos)'}`,
);
if (summary.errors > 0) process.exitCode = 1;
