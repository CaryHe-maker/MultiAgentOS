/**
 * The orchestration features on the real model (Orchestration 4-6, 10.1): background commands, a
 * command moved to the background at its timeout, reading and stopping a job, subtasks the main
 * Agent sleeps on, messages between sibling tasks, and long tasks of the template `mission` (a
 * small project, a technical report, a fix across modules). Every judge looks only at what the
 * product left behind: files, an acceptance command the model never saw, and the Session log.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Check, Observation, TaskSpec } from '../spec.js';
import { FILES as DOCS } from './delivery.js';

const check = (name: string, angle: Check['angle'], ok: boolean, detail?: string): Check => ({
  name,
  angle,
  ok,
  ...(detail === undefined ? {} : { detail }),
});

async function put(repository: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repository, path, '..'), { recursive: true });
    await writeFile(join(repository, path), content, {
      mode: path.endsWith('.sh') ? 0o755 : 0o644,
    });
  }
}

type Row = Readonly<Record<string, unknown>>;
const records = (observation: Observation, type: string): Row[] =>
  observation.log.filter((record) => record['type'] === type);
const replies = (observation: Observation): string => observation.printed('REPLY').join('\n');

/** Runs a command in the repository as the judge, never as the model. */
function judgeRun(
  repository: string,
  file: string,
  args: readonly string[],
): { readonly ok: boolean; readonly output: string } {
  try {
    const output = execFileSync(file, args, {
      cwd: repository,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${failed.stdout ?? ''}${failed.stderr ?? ''}${failed.message ?? ''}`.slice(-2000),
    };
  }
}

/** unittest with its summary line, whatever it exits with. */
function unittestSummary(repository: string): {
  readonly ok: boolean;
  readonly ran: number;
  readonly output: string;
} {
  const result = judgeRun(repository, '/bin/sh', [
    '-c',
    'python3 -m unittest discover -s tests -t . 2>&1',
  ]);
  return {
    ok: result.ok,
    ran: Number(/Ran (\d+) test/u.exec(result.output)?.[1] ?? '0'),
    output: result.output.slice(-1500),
  };
}

/** The tasks of the run: their name, Agent, write scope, how they ended. */
function tasksOf(observation: Observation): {
  readonly name: string;
  readonly agent: string;
  readonly writeScope: readonly string[];
  readonly status?: string;
}[] {
  // A task that slept has several segments: it ended how its last one did.
  const missionOf = new Map<string, string>();
  for (const record of records(observation, 'GRAPH_EXTENDED'))
    for (const node of (record['nodes'] as Row[]) ?? []) {
      const mission = node['mission'] as { id?: string } | undefined;
      if (mission?.id !== undefined) missionOf.set(String(node['nodeId']), mission.id);
    }
  const ended = new Map<string, string>();
  for (const record of records(observation, 'NODE_ENDED')) {
    const result = record['result'] as { status?: string } | undefined;
    const mission = missionOf.get(String(record['nodeId']));
    if (result?.status !== undefined && mission !== undefined) ended.set(mission, result.status);
  }
  return records(observation, 'GRAPH_EXTENDED')
    .filter((record) => record['source'] === 'SPAWN')
    .flatMap((record) => (record['nodes'] as Row[]) ?? [])
    .map((node) => {
      const status = ended.get(String((node['mission'] as { id?: string } | undefined)?.id));
      return {
        name: String(node['name']),
        agent: String((node['agentRef'] as { id?: string } | undefined)?.id),
        writeScope: (
          (node['spawn'] as { writeScope?: string[] } | undefined)?.writeScope ?? []
        ).map(String),
        ...(status === undefined ? {} : { status }),
      };
    });
}

/** The root task slept while its subtasks worked (Orchestration 4.1). */
const rootSlept = (observation: Observation): boolean => {
  const root = records(observation, 'AGENT_RUN_REGISTERED').find(
    (record) => (record['missionId'] as string | undefined) !== undefined,
  )?.['missionId'];
  return records(observation, 'SEGMENT_YIELDED').some(
    (record) =>
      record['missionId'] === root &&
      ((record['until'] as { kind: string }[]) ?? []).some(
        (condition) => condition.kind === 'children',
      ),
  );
};

const feedbackCodes = (observation: Observation): Record<string, number> => {
  const codes: Record<string, number> = {};
  for (const record of records(observation, 'FEEDBACK')) {
    const code = String(record['code']);
    codes[code] = (codes[code] ?? 0) + 1;
  }
  return codes;
};

// --- Background commands -------------------------------------------------------------------------

const background: TaskSpec = {
  id: 'jobs.background',
  mode: 'chat',
  tags: ['chat', 'jobs', 'orchestration'],
  description:
    'A slow integration run goes to the background while main answers another question from a file, then main waits for the run and reports its result.',
  fixture: (repository) =>
    put(repository, {
      'scripts/integration.sh': [
        '#!/bin/sh',
        'echo "integration: starting 42 cases"',
        'sleep 25',
        'echo "INTEGRATION RESULT: 42 passed, 0 failed (suite id IT-5530)"',
      ].join('\n'),
      'docs/config.md': [
        '# Configuration',
        'The database connection pool holds at most 17 connections.',
        'Idle connections are closed after 300 seconds.',
      ].join('\n'),
    }),
  steps: [
    {
      say: [
        '请在后台运行 scripts/integration.sh（它要跑二十多秒），不要干等它。',
        '在它运行的同时，读 docs/config.md，告诉我数据库连接池最多几个连接。',
        '然后等集成测试跑完，把它最后一行的结果（含 suite id）告诉我。全部做完再回复我。',
      ].join('\n'),
    },
  ],
  judge: (observation) => {
    const jobs = records(observation, 'JOB_STARTED');
    const started = jobs.find((job) => String(job['command']).includes('integration.sh'));
    const ended = records(observation, 'JOB_ENDED');
    const shown = replies(observation);
    const waited =
      records(observation, 'SEGMENT_YIELDED').some((record) =>
        ((record['until'] as { kind: string }[]) ?? []).some(
          (condition) => condition.kind === 'jobs',
        ),
      ) || records(observation, 'JOB_READ').length > 0;
    return [
      check(
        'the run went to the background',
        'BEHAVIOR',
        started !== undefined && started['promoted'] === false,
        `${String(jobs.length)} jobs: ${jobs.map((job) => `${String(job['command'])} promoted=${String(job['promoted'])}`).join(' | ')}`,
      ),
      check('main waited for the job by sleep or job_output', 'BEHAVIOR', waited),
      check('the job ended and was recorded', 'BEHAVIOR', ended.length >= 1),
      check('the answer has the pool size', 'OUTCOME', shown.includes('17')),
      check(
        'the answer has the result of the run',
        'OUTCOME',
        shown.includes('IT-5530') && shown.includes('42'),
        shown.slice(-300),
      ),
    ];
  },
};

const promote: TaskSpec = {
  id: 'jobs.promote',
  mode: 'chat',
  tags: ['chat', 'jobs', 'orchestration'],
  description:
    'A build runs past the timeout main gives it, moves to the background, and main waits for it instead of running it again.',
  fixture: (repository) =>
    put(repository, {
      'scripts/build.sh': [
        '#!/bin/sh',
        'echo "build: compiling"',
        'sleep 20',
        'echo "BUILD OK artifact=dist/app-3.1.4.tar"',
      ].join('\n'),
    }),
  steps: [
    {
      say: '运行 scripts/build.sh 构建项目，run_command 的 timeoutMs 设为 5000。构建完成后告诉我构建产物的文件名。',
    },
  ],
  judge: (observation) => {
    const jobs = records(observation, 'JOB_STARTED');
    const promoted = jobs.filter((job) => job['promoted'] === true);
    const builds = records(observation, 'UNIT_SUBMITTED').filter((record) =>
      String(
        ((record['inputSource'] as { workflowFields?: { command?: string } }).workflowFields ?? {})
          .command ?? '',
      ).includes('build.sh'),
    );
    const shown = replies(observation);
    return [
      check(
        'the build moved to the background at its timeout',
        'BEHAVIOR',
        promoted.length >= 1,
        `${String(jobs.length)} jobs, ${String(promoted.length)} promoted`,
      ),
      check(
        'the build was not started again',
        'BEHAVIOR',
        builds.length === 1,
        `${String(builds.length)} runs of build.sh`,
      ),
      check(
        'the answer names the artifact',
        'OUTCOME',
        shown.includes('app-3.1.4.tar'),
        shown.slice(-300),
      ),
    ];
  },
};

const kill: TaskSpec = {
  id: 'jobs.kill',
  mode: 'chat',
  tags: ['chat', 'jobs', 'orchestration'],
  description: 'main starts a watcher that never ends, reads its output for a token, and stops it.',
  fixture: (repository) =>
    put(repository, {
      'scripts/watch.sh': [
        '#!/bin/sh',
        'echo "watcher ready, session token WATCH-7731"',
        'n=0',
        'while true; do n=$((n+1)); echo "tick $n"; sleep 1; done',
      ].join('\n'),
    }),
  steps: [
    {
      say: 'scripts/watch.sh 是一个不会自己结束的监视进程。请在后台启动它，从它的输出里找到它打印的 session token，然后把它停掉，最后告诉我 token。',
    },
  ],
  judge: (observation) => {
    const jobs = records(observation, 'JOB_STARTED');
    const codes = feedbackCodes(observation);
    const ended = records(observation, 'JOB_ENDED');
    const stopped = ended.some(
      (record) => (record['exit'] as { stopped?: boolean }).stopped === true,
    );
    return [
      check('the watcher went to the background', 'BEHAVIOR', jobs.length >= 1),
      check(
        'its output was read with job_output',
        'BEHAVIOR',
        (codes['JOB_OUTPUT'] ?? 0) >= 1,
        JSON.stringify(codes),
      ),
      check(
        'it was stopped with job_kill',
        'BEHAVIOR',
        (codes['JOB_KILLED'] ?? 0) >= 1 && stopped,
        `${String(ended.length)} ended, stopped=${String(stopped)}`,
      ),
      check('the answer has the token', 'OUTCOME', replies(observation).includes('WATCH-7731')),
    ];
  },
};

// --- Subtasks -------------------------------------------------------------------------------------

const PARALLEL_FILES: Readonly<Record<string, string>> = {
  'geometry/__init__.py': '',
  'geometry/shapes.py': [
    'def rectangle_area(width, height):',
    '    raise NotImplementedError',
    '',
    'def circle_area(radius):',
    '    """Use math.pi; round to 2 decimals."""',
    '    raise NotImplementedError',
    '',
    'def triangle_perimeter(a, b, c):',
    '    """Raise ValueError when the sides cannot form a triangle."""',
    '    raise NotImplementedError',
  ].join('\n'),
  'textstats/__init__.py': '',
  'textstats/counts.py': [
    'def word_count(text):',
    '    raise NotImplementedError',
    '',
    'def most_common_word(text):',
    '    """Lowercase, ignore punctuation .,!?; ties go to the word seen first."""',
    '    raise NotImplementedError',
    '',
    'def average_word_length(text):',
    '    """Round to 2 decimals; 0.0 for an empty text."""',
    '    raise NotImplementedError',
  ].join('\n'),
  'tests/__init__.py': '',
  'tests/test_geometry.py': [
    'import unittest',
    'from geometry.shapes import rectangle_area, circle_area, triangle_perimeter',
    '',
    'class GeometryTest(unittest.TestCase):',
    '    def test_rectangle(self):',
    '        self.assertEqual(rectangle_area(3, 4), 12)',
    '    def test_circle(self):',
    '        self.assertEqual(circle_area(2), 12.57)',
    '    def test_triangle(self):',
    '        self.assertEqual(triangle_perimeter(3, 4, 5), 12)',
    '    def test_not_a_triangle(self):',
    '        with self.assertRaises(ValueError):',
    '            triangle_perimeter(1, 2, 10)',
  ].join('\n'),
  'tests/test_textstats.py': [
    'import unittest',
    'from textstats.counts import word_count, most_common_word, average_word_length',
    '',
    'class TextStatsTest(unittest.TestCase):',
    '    def test_count(self):',
    '        self.assertEqual(word_count("a b  c"), 3)',
    '    def test_common(self):',
    '        self.assertEqual(most_common_word("Cat dog, cat! Dog? bird cat."), "cat")',
    '    def test_tie(self):',
    '        self.assertEqual(most_common_word("b a b a"), "b")',
    '    def test_average(self):',
    '        self.assertEqual(average_word_length("ab abcd"), 3.0)',
    '    def test_empty(self):',
    '        self.assertEqual(average_word_length(""), 0.0)',
  ].join('\n'),
};

const parallel: TaskSpec = {
  id: 'subagents.parallel',
  mode: 'chat',
  tags: ['chat', 'subagents', 'orchestration'],
  description:
    'Two workers implement two packages at once in scopes of their own; main sleeps until both end, then checks the tests.',
  fixture: (repository) => put(repository, PARALLEL_FILES),
  steps: [
    {
      say: [
        '这个仓库的 geometry 和 textstats 两个包还没实现，tests/ 里的测试会失败。',
        '请用 run_subagents 同时派两个 worker：一个只改 geometry/，一个只改 textstats/，不要改 tests/。',
        '它们工作时你不要轮询，等它们都结束后，运行 python3 -m unittest discover -s tests -t . 确认全部通过，再回复我。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const tests = unittestSummary(observation.repository);
    const tasks = tasksOf(observation);
    const workers = tasks.filter((task) => task.agent === 'worker');
    const scopes = workers.map((task) => task.writeScope.join(','));
    const testsKept =
      (await readFile(join(observation.repository, 'tests/test_geometry.py'), 'utf8')) ===
      PARALLEL_FILES['tests/test_geometry.py'];
    return [
      check('every test passes', 'OUTCOME', tests.ok && tests.ran === 9, tests.output.slice(-400)),
      check('the tests were not changed', 'SAFETY', testsKept),
      check(
        'two workers with scopes of their own',
        'BEHAVIOR',
        workers.length >= 2 && new Set(scopes).size === workers.length,
        scopes.join(' | '),
      ),
      check('main slept while they worked', 'BEHAVIOR', rootSlept(observation)),
      check(
        'both workers ended done',
        'OUTCOME',
        workers.filter((task) => task.status === 'DONE').length >= 2,
        workers.map((task) => `${task.name}:${String(task.status)}`).join(' '),
      ),
    ];
  },
};

const MESSAGE_FILES: Readonly<Record<string, string>> = {
  'README.md': [
    '# Inventory',
    'api/ is the service side: a function that answers a request dict with a response dict.',
    'client/ calls it through a function that builds the request and reads the response.',
    'The names of the request and response fields are not decided yet: the api decides them.',
  ].join('\n'),
  'api/__init__.py': '',
  'api/service.py': [
    'STOCK = {"apple": 5, "pear": 0}',
    '',
    'def handle(request):',
    '    """Answer a stock request; the field names are for the api to decide."""',
    '    raise NotImplementedError',
  ].join('\n'),
  'client/__init__.py': '',
  'client/inventory.py': [
    'from api.service import handle',
    '',
    'def in_stock(item):',
    '    """True when the api says the item has stock, through handle()."""',
    '    raise NotImplementedError',
  ].join('\n'),
  'tests/__init__.py': '',
  'tests/test_inventory.py': [
    'import unittest',
    'from client.inventory import in_stock',
    '',
    'class InventoryTest(unittest.TestCase):',
    '    def test_apple(self):',
    '        self.assertTrue(in_stock("apple"))',
    '    def test_pear(self):',
    '        self.assertFalse(in_stock("pear"))',
    '    def test_unknown(self):',
    '        self.assertFalse(in_stock("kiwi"))',
  ].join('\n'),
};

const message: TaskSpec = {
  id: 'subagents.message',
  mode: 'chat',
  tags: ['chat', 'subagents', 'messages', 'orchestration'],
  description:
    'Two sibling workers run at once; the api worker decides the field names and tells the client worker with send_message.',
  fixture: (repository) => put(repository, MESSAGE_FILES),
  steps: [
    {
      say: [
        '请用一次 run_subagents 同时派两个 worker：',
        '- api：只改 api/，实现 handle()，由它决定请求和响应的字段名，定下来后立刻用 send_message 把字段名告诉兄弟任务 client，然后完成实现；',
        '- client：只改 client/，实现 in_stock()，先等 api 发来的字段名（可以用 sleep 等消息），收到后再实现。',
        '它们都结束后，运行 python3 -m unittest discover -s tests -t . 确认通过，再回复我。',
      ].join('\n'),
    },
  ],
  judge: (observation) => {
    const tests = unittestSummary(observation.repository);
    const tasks = tasksOf(observation);
    const missionOf = new Map<string, string>();
    for (const record of records(observation, 'GRAPH_EXTENDED'))
      for (const node of (record['nodes'] as Row[]) ?? []) {
        const mission = node['mission'] as { id?: string } | undefined;
        if (mission?.id !== undefined) missionOf.set(mission.id, String(node['name']));
      }
    const messages = records(observation, 'MISSION_MESSAGE').map(
      (record) =>
        `${missionOf.get(String(record['from'])) ?? String(record['from'])}->${((record['to'] as string[]) ?? []).map((to) => missionOf.get(to) ?? to).join(',')}`,
    );
    const siblingMessage = messages.some(
      (each) => each.startsWith('api->') && each.includes('client'),
    );
    return [
      check('every test passes', 'OUTCOME', tests.ok && tests.ran === 3, tests.output.slice(-400)),
      check(
        'the api worker told the client worker the field names',
        'BEHAVIOR',
        siblingMessage,
        messages.join(' '),
      ),
      check(
        'two workers ran',
        'BEHAVIOR',
        tasks.filter((task) => task.agent === 'worker').length >= 2,
        tasks.map((task) => `${task.name}:${task.agent}`).join(' '),
      ),
    ];
  },
};

// --- Long tasks of the template mission --------------------------------------------------------------

const ledger: TaskSpec = {
  id: 'mission.ledger',
  mode: 'mission',
  tags: ['mission', 'project', 'orchestration'],
  description:
    'A small command-line project from nothing, with tests and a README; an acceptance run the model never saw checks the interface.',
  fixture: (repository) => put(repository, { 'README.md': '# ledger\n' }),
  steps: [
    {
      run: [
        '在这个仓库里用 Python 3 标准库实现一个命令行记账工具，入口文件 ledger.py：',
        '- `python3 ledger.py --file <路径> add <金额> <类别> [备注]` 追加一条记录（金额可为小数），数据存在该 JSON 文件里，文件不存在时创建；',
        '- `python3 ledger.py --file <路径> list` 每条一行，格式 `<序号>. <金额保留两位> <类别> <备注>`，序号从 1 开始；',
        '- `python3 ledger.py --file <路径> summary` 按类别求和，每个类别一行 `<类别>: <合计保留两位>`，按类别名字母序；',
        '- 金额不是数字时打印错误到 stderr 并以退出码 2 结束。',
        '在 tests/ 下写单元测试（至少 6 个），`python3 -m unittest discover -s tests -t .` 全部通过；README.md 写清用法。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const { repository } = observation;
    const tests = unittestSummary(repository);
    const file = join(repository, '..', `${repository.split('/').at(-1) ?? 'x'}-ledger.json`);
    const run = (...args: string[]) =>
      judgeRun(repository, 'python3', ['ledger.py', '--file', file, ...args]);
    run('add', '12.5', 'food', 'lunch');
    run('add', '3', 'transport');
    run('add', '7.25', 'food', 'dinner');
    const summary = run('summary');
    const list = run('list');
    const bad = judgeRun(repository, '/bin/sh', [
      '-c',
      `python3 ledger.py --file '${file}' add abc food; echo "exit=$?"`,
    ]);
    const readme = await readFile(join(repository, 'README.md'), 'utf8').catch(() => '');
    const roots = records(observation, 'MISSION_ENDED');
    return [
      check(
        'their tests pass, at least 6',
        'OUTCOME',
        tests.ok && tests.ran >= 6,
        `ran ${String(tests.ran)}: ${tests.output.slice(-300)}`,
      ),
      check(
        'summary sums by category',
        'OUTCOME',
        summary.ok &&
          /food: 19\.75/u.test(summary.output) &&
          /transport: 3\.00/u.test(summary.output) &&
          summary.output.indexOf('food') < summary.output.indexOf('transport'),
        summary.output.slice(0, 300),
      ),
      check(
        'list numbers the entries',
        'OUTCOME',
        /1\. 12\.50 food lunch/u.test(list.output),
        list.output.slice(0, 300),
      ),
      check(
        'a bad amount exits with 2',
        'OUTCOME',
        bad.output.includes('exit=2'),
        bad.output.slice(-200),
      ),
      check(
        'the README tells how to use it',
        'OUTCOME',
        ['add', 'list', 'summary'].every((word) => readme.includes(word)),
      ),
      check(
        'mas run exited 0',
        'OUTCOME',
        observation.exitCode === 0,
        String(observation.exitCode),
      ),
      check(
        'main delivered a reply',
        'BEHAVIOR',
        observation.printed('REPLY').length > 0,
        `${String(observation.printed('REPLY').length)} replies`,
      ),
      check(
        'the run was delivered, not failed',
        'BEHAVIOR',
        !roots.some(
          (record) =>
            record['status'] === 'FAILED' && record['missionId'] === roots.at(-1)?.['missionId'],
        ),
      ),
    ];
  },
};

const REPORT_SECTIONS = ['概述', '调度', '缓存', '认证', '报告', '风险与建议'];
const REPORT_FACTS = ['250', '4096', '14', '02:30', '90', '900', '30'];

const report: TaskSpec = {
  id: 'mission.report',
  mode: 'mission',
  tags: ['mission', 'writing', 'orchestration'],
  description:
    'A technical report in Chinese on a small repository: length, sections, the files it rests on and the numbers in them.',
  fixture: (repository) => put(repository, DOCS),
  steps: [
    {
      run: [
        '为这个仓库写一份中文技术报告，保存为 docs/report.md：',
        `- 不少于 1500 个汉字，包含这六个二级标题（## 开头）：${REPORT_SECTIONS.join('、')}；`,
        '- 每一节写明依据的文件路径（如 docs/cache.md），并写出文件里的具体数字；',
        '- 「风险与建议」一节至少给出 3 条建议；',
        '- 只新建 docs/report.md，不要修改仓库里的其它文件。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const { repository } = observation;
    const text = await readFile(join(repository, 'docs/report.md'), 'utf8').catch(() => '');
    const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
    const headings = REPORT_SECTIONS.filter((section) =>
      new RegExp(`^##\\s*${section}`, 'mu').test(text),
    );
    const cited = Object.keys(DOCS).filter((path) => text.includes(path));
    const facts = REPORT_FACTS.filter((fact) => text.includes(fact));
    let untouched = true;
    for (const [path, content] of Object.entries(DOCS))
      if ((await readFile(join(repository, path), 'utf8').catch(() => '')) !== content)
        untouched = false;
    return [
      check(
        'the report exists and is long enough',
        'OUTCOME',
        han >= 1500,
        `${String(han)} Han characters`,
      ),
      check(
        'it has the six sections',
        'OUTCOME',
        headings.length === REPORT_SECTIONS.length,
        headings.join(','),
      ),
      check('it cites the files', 'OUTCOME', cited.length >= 4, cited.join(',')),
      check('it has the numbers of the files', 'OUTCOME', facts.length >= 5, facts.join(',')),
      check('the other files were not changed', 'SAFETY', untouched),
      check(
        'mas run exited 0',
        'OUTCOME',
        observation.exitCode === 0,
        String(observation.exitCode),
      ),
      check(
        'main delivered a reply',
        'BEHAVIOR',
        observation.printed('REPLY').length > 0,
        `${String(observation.printed('REPLY').length)} replies`,
      ),
    ];
  },
};

const BUG_FILES: Readonly<Record<string, string>> = {
  'pricing/__init__.py': '',
  'pricing/discount.py': [
    'def bulk_price(unit_price, quantity):',
    '    """10% off from 10 items on, 20% off from 50 items on; round to 2 decimals."""',
    '    total = unit_price * quantity',
    '    if quantity > 50:',
    '        total *= 0.8',
    '    elif quantity > 10:',
    '        total *= 0.9',
    '    return round(total, 2)',
  ].join('\n'),
  'dates/__init__.py': '',
  'dates/parse.py': [
    'MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]',
    '',
    'def parse_short(text):',
    '    """"12 mar 2024" -> (2024, 3, 12)."""',
    '    day, month, year = text.lower().split()',
    '    return int(year), MONTHS.index(month), int(day)',
  ].join('\n'),
  'textutil/__init__.py': '',
  'textutil/slug.py': [
    'import re',
    '',
    'def slugify(title):',
    '    """"Hello, World!" -> "hello-world"; runs of other characters become one dash."""',
    '    slug = re.sub(r"[^A-Za-z0-9]+", "-", title)',
    '    return slug.strip("-")',
  ].join('\n'),
  'tests/__init__.py': '',
  'tests/test_pricing.py': [
    'import unittest',
    'from pricing.discount import bulk_price',
    '',
    'class PricingTest(unittest.TestCase):',
    '    def test_small(self):',
    '        self.assertEqual(bulk_price(2.0, 9), 18.0)',
    '    def test_ten(self):',
    '        self.assertEqual(bulk_price(2.0, 10), 18.0)',
    '    def test_fifty(self):',
    '        self.assertEqual(bulk_price(1.0, 50), 40.0)',
  ].join('\n'),
  'tests/test_dates.py': [
    'import unittest',
    'from dates.parse import parse_short',
    '',
    'class DatesTest(unittest.TestCase):',
    '    def test_march(self):',
    '        self.assertEqual(parse_short("12 Mar 2024"), (2024, 3, 12))',
    '    def test_december(self):',
    '        self.assertEqual(parse_short("1 dec 1999"), (1999, 12, 1))',
  ].join('\n'),
  'tests/test_slug.py': [
    'import unittest',
    'from textutil.slug import slugify',
    '',
    'class SlugTest(unittest.TestCase):',
    '    def test_basic(self):',
    '        self.assertEqual(slugify("Hello, World!"), "hello-world")',
    '    def test_runs(self):',
    '        self.assertEqual(slugify("  A -- B  "), "a-b")',
  ].join('\n'),
};

const bugfix: TaskSpec = {
  id: 'mission.bugfix',
  mode: 'mission',
  tags: ['mission', 'bugfix', 'orchestration'],
  description:
    'Three modules each with a bug, found from failing tests and fixed without touching the tests.',
  fixture: (repository) => put(repository, BUG_FILES),
  steps: [
    {
      run: '这个仓库的测试有失败（运行 python3 -m unittest discover -s tests -t . 可以看到）。找出并修好全部失败的原因，不要修改 tests/ 目录，最后确认测试全部通过。',
    },
  ],
  judge: async (observation) => {
    const { repository } = observation;
    const tests = unittestSummary(repository);
    let testsKept = true;
    for (const [path, content] of Object.entries(BUG_FILES))
      if (
        path.startsWith('tests/') &&
        (await readFile(join(repository, path), 'utf8').catch(() => '')) !== content
      )
        testsKept = false;
    return [
      check('every test passes', 'OUTCOME', tests.ok && tests.ran === 7, tests.output.slice(-400)),
      check('the tests were not changed', 'SAFETY', testsKept),
      check(
        'mas run exited 0',
        'OUTCOME',
        observation.exitCode === 0,
        String(observation.exitCode),
      ),
      check(
        'main delivered a reply',
        'BEHAVIOR',
        observation.printed('REPLY').length > 0,
        `${String(observation.printed('REPLY').length)} replies`,
      ),
    ];
  },
};

export const ORCHESTRATION_TASKS: readonly TaskSpec[] = [
  background,
  promote,
  kill,
  parallel,
  message,
  ledger,
  report,
  bugfix,
];
