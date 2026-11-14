/**
 * The submission study (Phase2Plan 7, Orchestration 3.9): large mission tasks whose work has, in
 * part, the shape of a pre-orchestrated template (a failure to fix, an unknown codebase to explore
 * before building, changes to review), and one whose work has none. The goals never name
 * sub_mission, templates, subtasks or splitting: what the root chooses is what is measured. Each
 * run records its shape (orchestration-shape.ts): whether root used sub_mission, and whether every
 * subMission root kept to its playbook. Outcomes are judged by tests the model never saw.
 *
 * The repositories, the hidden tests and a reference solution of each task are under
 * fixtures/study/; submission-study.test.ts checks offline that the hidden tests fail on the
 * repository as given and pass on the reference, so a run is never spent on a broken judge.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shapeOf } from '../orchestration-shape.js';
import type { Check, Observation, TaskSpec } from '../spec.js';

export const STUDY_FIXTURES = fileURLToPath(new URL('../fixtures/study/', import.meta.url));

const check = (name: string, angle: Check['angle'], ok: boolean, detail?: string): Check => ({
  name,
  angle,
  ok,
  ...(detail === undefined ? {} : { detail }),
});

/** A shell line in the repository, run by the judge: its exit and what it printed. */
export function shell(
  repository: string,
  line: string,
  timeoutMs = 300_000,
  /** How much of the end of the output a failure keeps. */
  keep = 4000,
): { readonly ok: boolean; readonly output: string } {
  try {
    return {
      ok: true,
      output: execFileSync('/bin/sh', ['-c', `${line} 2>&1`], {
        cwd: repository,
        encoding: 'utf8',
        timeout: timeoutMs,
      }),
    };
  } catch (error) {
    const failed = error as { stdout?: string; message?: string };
    return { ok: false, output: `${failed.stdout ?? ''}${failed.message ?? ''}`.slice(-keep) };
  }
}

/**
 * A line that names the template for a part of the work, only when `MAO_STUDY_NAMED=1`: the arm
 * of the study where the choice is given, so that what a template does can be compared between
 * two builds of the system on the same shape of work (for example with and without inherited
 * contexts, D35). Without it the goals never name a template.
 */
const named = (line: string): string[] => (process.env['MAO_STUDY_NAMED'] === '1' ? [line] : []);

const ranOf = (output: string): number => Number(/Ran (\d+) test/u.exec(output)?.[1] ?? '0');

/** `python3 -m unittest -v`: how each test ended, by its name. */
export function verdicts(output: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of output.matchAll(/^(test_\w+) \([^)]*\) \.\.\. (ok|FAIL|ERROR|skipped)/gmu))
    found.set(match[1] ?? '', match[2] ?? '');
  return found;
}

/** Puts the hidden tests of a task into the repository and runs them. */
export async function hidden(
  task: string,
  repository: string,
): Promise<{
  readonly passed: readonly string[];
  readonly failed: readonly string[];
  readonly output: string;
}> {
  const folder = join(STUDY_FIXTURES, task, 'hidden');
  const files = (await readdir(folder)).filter((file) => file.endsWith('.py'));
  for (const file of files) await cp(join(folder, file), join(repository, file));
  const modules = files.map((file) => file.slice(0, -3));
  // Every line of the verbose output is read, not only its end.
  const ran = shell(repository, `python3 -m unittest -v ${modules.join(' ')}`, 300_000, 1_000_000);
  const each = verdicts(ran.output);
  const failed = [...each].filter(([, verdict]) => verdict !== 'ok').map(([name]) => name);
  return {
    passed: [...each].filter(([, verdict]) => verdict === 'ok').map(([name]) => name),
    // Tests that never ran (their setup failed) are failures too.
    failed: !ran.ok && failed.length === 0 ? ['(the tests did not run)'] : failed,
    output: ran.output,
  };
}

/** The repository of a task as the model gets it. */
export async function given(task: string, repository: string): Promise<void> {
  await cp(join(STUDY_FIXTURES, task, 'repo'), repository, { recursive: true });
}

const read = (repository: string, path: string) =>
  readFile(join(repository, path), 'utf8').catch(() => '');

/** What every task judges besides its own outcome, and the shape it records. */
function common(observation: Observation, expected: string): Check[] {
  const shape = shapeOf(observation.log);
  const kept = shape.subMissions.filter((each) => each.violations.length === 0).length;
  return [
    check('mas run exited 0', 'OUTCOME', observation.exitCode === 0, String(observation.exitCode)),
    check(
      'main delivered a reply',
      'BEHAVIOR',
      observation.printed('REPLY').length > 0,
      `${String(observation.printed('REPLY').length)} replies`,
    ),
    // Recorded, never judged: the study reads these, a run does not pass or fail by them.
    check(
      'recorded: the shape of the run',
      'BEHAVIOR',
      true,
      JSON.stringify({
        expected,
        subMissionCalls: shape.subMissionCalls,
        subMissions: shape.subMissions.map((each) => ({
          template: each.template,
          status: each.status,
          children: each.children.map((child) => `${child.agent}:${String(child.status)}`),
          sentBack: each.sentBack,
          ownWrites: each.ownWrites,
          ownCommands: each.ownCommands,
          violations: each.violations,
        })),
        kept: `${String(kept)}/${String(shape.subMissions.length)}`,
        runSubagentsCalls: shape.runSubagentsCalls,
        tasksByAgent: shape.tasksByAgent,
        rootWrites: shape.rootWrites,
        rootCommands: shape.rootCommands,
        depth: shape.depth,
        tasks: shape.tasks,
      }),
    ),
  ];
}

const theirTests = (repository: string, least = 0): Check => {
  const ran = shell(repository, 'python3 -m unittest discover -s tests -t .');
  return check(
    least > 0 ? `their tests pass, at least ${String(least)}` : 'their tests pass',
    'OUTCOME',
    ran.ok && ranOf(ran.output) >= least,
    `ran ${String(ranOf(ran.output))}: ${ran.output.slice(-400)}`,
  );
};

const hiddenCheck = (result: Awaited<ReturnType<typeof hidden>>, least?: number): Check =>
  check(
    least === undefined ? 'the hidden tests pass' : `at least ${String(least)} hidden tests pass`,
    'OUTCOME',
    least === undefined
      ? result.failed.length === 0 && result.passed.length > 0
      : result.passed.length >= least,
    `passed ${String(result.passed.length)}; failed ${result.failed.join(',') || '-'}`,
  );

// --- shop: three failing tests with three causes, and a feature ------------------------------------

const SHOP_TESTS = [
  'test_inventory.py',
  'test_pricing.py',
  'test_tax.py',
  'test_orders.py',
  'test_money.py',
];

const shop: TaskSpec = {
  id: 'study.shop',
  mode: 'mission',
  tags: ['mission', 'study', 'submission-study', 'fix-and-feature'],
  description:
    'Three failing tests with three unrelated causes, and coupons to add to checkout and the command line.',
  fixture: (repository) => given('shop', repository),
  steps: [
    {
      run: [
        'shop 的测试现在有失败：`python3 -m unittest discover -s tests -t .`。请把失败修好（测试本身是对的，不要改测试）。',
        '另外订单要支持优惠券：',
        '1. 新模块 shop/coupons.py：`Coupon(code, kind, value, min_subtotal=0, expires=None)`，kind 为 "percent"（value 是 1–100 的整数百分比）或 "fixed"（value 是分）；expires 是 datetime.date 或 None，当天仍有效；`CouponError(Exception)`；`load_coupons(path)` 读 JSON 列表 `[{code, kind, value, min_subtotal?, expires?: "YYYY-MM-DD"}]`，返回 {code: Coupon}。',
        '2. `checkout(cart, region, coupon=None, today=None)`：优惠券在批量折扣之后、计税之前减；percent 按 money.percent_of 四舍五入到分；减后的金额不小于 0；未打折的 subtotal 低于 min_subtotal，或 today（缺省为今天）晚于 expires 时抛 CouponError，且这时不卖出任何东西（库存与购物车不变）。Order 增加 coupon（减掉的分，没有券为 0）与 coupon_code（没有券为 None），as_dict() 也要有这两项。',
        '3. 命令行 quote 增加 `--coupons <文件> --coupon <代码>`；代码不存在或券不能用时向 stderr 写原因，退出码 2。',
        '给新功能补上测试，README 写明优惠券的用法。',
        ...named('修好失败的测试这一部分，请用 sub_mission 交给 fix-verify 模板。'),
        '请尽可能快并且高质量地完成。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const { repository } = observation;
    const result = await hidden('shop', repository);
    const original = await Promise.all(
      SHOP_TESTS.map(async (file) => [
        await readFile(join(STUDY_FIXTURES, 'shop/repo/tests', file), 'utf8'),
        await read(repository, `tests/${file}`),
      ]),
    );
    const changed = SHOP_TESTS.filter((_, index) => original[index]?.[0] !== original[index]?.[1]);
    const readme = await read(repository, 'README.md');
    return [
      hiddenCheck(result),
      theirTests(repository, 17),
      check('the given tests were not changed', 'OUTCOME', changed.length === 0, changed.join(',')),
      check('the README tells about coupons', 'OUTCOME', readme.includes('--coupon')),
      ...common(observation, 'fix-verify for the failures, a worker for the coupons'),
    ];
  },
};

// --- taskq: a backend that must fit a codebase it has to learn first -------------------------------

const taskq: TaskSpec = {
  id: 'study.taskq',
  mode: 'mission',
  tags: ['mission', 'study', 'submission-study', 'explore-then-build'],
  description:
    'A SQLite storage backend for a job queue, behaving exactly like the existing backends, with a command line flag.',
  fixture: (repository) => given('taskq', repository),
  steps: [
    {
      run: [
        '给 taskq 增加一个 SQLite 存储后端（标准库 sqlite3）：',
        '- 注册名 sqlite，用 path 选项指定数据库文件；行为与现有后端完全一致（包括延迟任务、重试、重新打开后的状态）；',
        '- 命令行增加全局选项 `--backend NAME`，优先于配置文件里的 [backend] name；配置文件写 name = "sqlite" 也要能用；',
        '- 给 sqlite 后端补上测试，README 写明怎么用。',
        '现有测试都要继续通过：`python3 -m unittest discover -s tests -t .`。',
        ...named('sqlite 后端这一部分，请用 sub_mission 交给 explore-build 模板。'),
        '请尽可能快并且高质量地完成。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const { repository } = observation;
    const result = await hidden('taskq', repository);
    const tests = (await readdir(join(repository, 'tests')).catch(() => [] as string[])).filter(
      (file) => file.endsWith('.py'),
    );
    const testText = (
      await Promise.all(tests.map((file) => read(repository, `tests/${file}`)))
    ).join('\n');
    const readme = await read(repository, 'README.md');
    return [
      hiddenCheck(result),
      theirTests(repository, 23),
      check('there are tests of the sqlite backend', 'OUTCOME', /sqlite/u.test(testText)),
      check(
        'the README tells about sqlite',
        'OUTCOME',
        /sqlite/iu.test(readme) && readme.includes('--backend'),
      ),
      ...common(observation, 'explore-build for the backend'),
    ];
  },
};

// --- auth: a module to review before release, and the problems fixed -----------------------------

const AUTH_FILES = ['passwords', 'login', 'sessions', 'tokens', 'uploads'];

const auth: TaskSpec = {
  id: 'study.auth',
  mode: 'mission',
  tags: ['mission', 'study', 'submission-study', 'review-then-fix'],
  description:
    'A sign-in module to check for security and correctness problems before release, fixing what is confirmed, with a report.',
  fixture: (repository) => given('auth', repository),
  steps: [
    {
      run: [
        'auth/ 下个月要上线。上线前请全面检查 auth/ 的安全与正确性问题（README.md 里有这个模块必须遵守的规则），',
        '确认的问题都修掉并补上测试；在 docs/auth-review.md 写检查报告：每个问题写在哪个文件、为什么是问题、怎么修的。',
        '现有测试都要继续通过：`python3 -m unittest discover -s tests -t .`。',
        '请尽可能快并且高质量地完成。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const { repository } = observation;
    const result = await hidden('auth', repository);
    const report = await read(repository, 'docs/auth-review.md');
    const named = AUTH_FILES.filter((file) => report.includes(file));
    return [
      hiddenCheck(result, 5),
      check(
        'recorded: which planted problems were fixed',
        'OUTCOME',
        true,
        `fixed ${result.passed.join(',') || '-'}; not ${result.failed.join(',') || '-'}`,
      ),
      theirTests(repository, 14),
      check(
        'the report names the files with problems',
        'OUTCOME',
        named.length >= 4,
        `names ${named.join(',')}`,
      ),
      ...common(observation, 'review, then fixes'),
    ];
  },
};

// --- sales: wrong numbers and a slow report, cause unknown, and a developer document ---------------

/** 40000 rows with corrections, the same every time (a linear congruential generator). */
function salesExport(): string {
  let state = 2026;
  const next = (below: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % below;
  };
  const lines = ['order_id,date,region,amount'];
  const made: string[][] = [];
  for (let index = 0; index < 40_000; index += 1) {
    const earlier = made.length > 0 && next(100) < 15 ? made[next(made.length)] : undefined;
    const cents = 1 + next(50_000);
    const amount = `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
    const row =
      earlier !== undefined
        ? [earlier[0] ?? '', earlier[1] ?? '', earlier[2] ?? '', amount]
        : [
            `o${String(index)}`,
            `${String(2025 + next(2))}-${String(1 + next(12)).padStart(2, '0')}-${String(1 + next(28)).padStart(2, '0')}`,
            'NSEW'[next(4)] ?? 'N',
            amount,
          ];
    made.push(row);
    lines.push(row.join(','));
  }
  return `${lines.join('\n')}\n`;
}

const sales: TaskSpec = {
  id: 'study.sales',
  mode: 'mission',
  tags: ['mission', 'study', 'submission-study', 'fix-and-document'],
  description:
    'A monthly report with wrong numbers and twenty seconds on 40000 rows: find why, fix both, and write the developer document.',
  fixture: async (repository) => {
    await given('sales', repository);
    await mkdir(join(repository, 'data'), { recursive: true });
    await writeFile(join(repository, 'data/export-2026.csv'), salesExport());
  },
  steps: [
    {
      run: [
        'sales 的月报有两个问题：',
        '1. `python3 -m unittest discover -s tests -t .` 有失败（测试是对的，不要改测试）；',
        '2. 太慢：`python3 -m sales report data/export-2026.csv` 处理这 4 万行要十几秒，要求同样的数据 2 秒以内。',
        '请修好这两个问题，并写一份开发文档 docs/report.md：数据格式、从读入到出表的处理流程、各模块和函数的作用、更正行（同一个 order_id 再次出现）的规则。',
        '请尽可能快并且高质量地完成。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const { repository } = observation;
    const result = await hidden('sales', repository);
    const started = Date.now();
    const report = shell(repository, 'python3 -m sales report data/export-2026.csv', 120_000);
    const seconds = (Date.now() - started) / 1000;
    const document = await read(repository, 'docs/report.md');
    const original = await readFile(
      join(STUDY_FIXTURES, 'sales/repo/tests/test_report.py'),
      'utf8',
    );
    return [
      hiddenCheck(result),
      theirTests(repository, 6),
      check(
        'the given tests were not changed',
        'OUTCOME',
        (await read(repository, 'tests/test_report.py')) === original,
      ),
      check(
        'the report of the 40000 rows takes under 2 seconds',
        'OUTCOME',
        report.ok && seconds < 2,
        `${seconds.toFixed(1)} s`,
      ),
      check(
        'the developer document covers the corrections and the flow',
        'OUTCOME',
        document.length >= 800 && document.includes('order_id') && /dedupe|更正/u.test(document),
        `${String(document.length)} chars`,
      ),
      ...common(
        observation,
        'fix-verify for the failures and the speed, a worker for the document',
      ),
    ];
  },
};

// --- mdsite: a project from a specification, with nothing to fix, explore or review ----------------

const mdsite: TaskSpec = {
  id: 'study.mdsite',
  mode: 'mission',
  tags: ['mission', 'study', 'submission-study', 'build-from-spec'],
  description:
    'A static blog generator from a specification: Markdown, pages, index, tags and a feed. No template fits it.',
  fixture: async (repository) => {
    await mkdir(join(repository, 'docs'), { recursive: true });
    await writeFile(join(repository, 'README.md'), '# mdsite\n');
    await cp(join(STUDY_FIXTURES, 'mdsite/spec.md'), join(repository, 'docs/spec.md'));
  },
  steps: [{ run: '按 docs/spec.md 实现 mdsite。请尽可能快并且高质量地完成。' }],
  judge: async (observation) => {
    const { repository } = observation;
    const result = await hidden('mdsite', repository);
    const readme = await read(repository, 'README.md');
    return [
      hiddenCheck(result),
      theirTests(repository, 15),
      check('the README tells how to build', 'OUTCOME', readme.includes('python3 -m mdsite build')),
      ...common(observation, 'no template: run_subagents or alone'),
    ];
  },
};

// --- healthhub: a distributed system from a specification, large enough for many hands ----------

const healthhub: TaskSpec = {
  id: 'study.healthhub',
  mode: 'mission',
  tags: ['mission', 'study', 'submission-study', 'large', 'build-from-spec'],
  description:
    'A distributed personal health system from a specification: six services with their own data over HTTP, events between them, partial failures; judged by hidden end-to-end tests.',
  fixture: async (repository) => {
    await mkdir(join(repository, 'docs'), { recursive: true });
    await writeFile(join(repository, 'README.md'), '# healthhub\n');
    await cp(join(STUDY_FIXTURES, 'healthhub/spec.md'), join(repository, 'docs/spec.md'));
  },
  steps: [
    {
      run: '按 docs/spec.md 从零实现分布式个人健康管理系统 healthhub。请尽可能快并且高质量地完成。',
    },
  ],
  judge: async (observation) => {
    const { repository } = observation;
    const result = await hidden('healthhub', repository);
    const readme = await read(repository, 'README.md');
    const architecture = await read(repository, 'docs/architecture.md');
    return [
      hiddenCheck(result),
      check(
        'recorded: hidden end-to-end tests passed',
        'OUTCOME',
        true,
        `${String(result.passed.length)}/12: ${result.passed.join(',') || '-'}`,
      ),
      theirTests(repository, 30),
      check('the README tells how to run it', 'OUTCOME', readme.includes('run.sh')),
      check(
        'docs/architecture.md describes the services',
        'OUTCOME',
        ['gateway', 'identity', 'records', 'ingest', 'analytics', 'notify'].every((name) =>
          architecture.includes(name),
        ),
        `${String(architecture.length)} chars`,
      ),
      ...common(observation, 'contracts first, owners per service, acceptance beside the build'),
    ];
  },
};

export const SUBMISSION_STUDY_TASKS: readonly TaskSpec[] = [
  shop,
  taskq,
  auth,
  sales,
  mdsite,
  healthhub,
];
