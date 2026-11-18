/**
 * Harder tasks for the orchestration features (Orchestration 3.6, 5.1, 5.2, 6, 8.2, 10.1): a project
 * the root should split among subtasks, judged by tests the model never saw; a survey written in
 * chapters by parallel subtasks; stopping a subtask once another has answered; interrupting a
 * subtask to change its direction; a background command inside a subtask. Judges look only at the
 * files, at commands the model never saw and at the Session log.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Check, Observation, TaskSpec } from '../spec.js';

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
const han = (text: string): number => (text.match(/\p{Script=Han}/gu) ?? []).length;

/** A shell line in the repository, run by the judge: its exit and what it printed. */
function shell(
  repository: string,
  line: string,
): { readonly ok: boolean; readonly output: string } {
  try {
    return {
      ok: true,
      output: execFileSync('/bin/sh', ['-c', `${line} 2>&1`], {
        cwd: repository,
        encoding: 'utf8',
        timeout: 120_000,
      }),
    };
  } catch (error) {
    const failed = error as { stdout?: string; message?: string };
    return { ok: false, output: `${failed.stdout ?? ''}${failed.message ?? ''}`.slice(-2000) };
  }
}

const ranOf = (output: string): number => Number(/Ran (\d+) test/u.exec(output)?.[1] ?? '0');

/** Every task the run spawned, with its Agent, write scope, depth in the tree and how it ended. */
function tasksOf(observation: Observation): {
  readonly name: string;
  readonly agent: string;
  readonly missionId: string;
  readonly parentId?: string;
  readonly writeScope: readonly string[];
  readonly status?: string;
}[] {
  // A task that slept has several segments: it ended how its last one did.
  const missionOf = new Map<string, string>();
  for (const record of records(observation, 'GRAPH_EXTENDED'))
    for (const node of (record['nodes'] as Row[]) ?? []) {
      const owner = node['mission'] as { id?: string } | undefined;
      if (owner?.id !== undefined) missionOf.set(String(node['nodeId']), owner.id);
    }
  const ended = new Map<string, string>();
  for (const record of records(observation, 'NODE_ENDED')) {
    const result = record['result'] as { status?: string } | undefined;
    const owner = missionOf.get(String(record['nodeId']));
    if (owner !== undefined) ended.set(owner, result?.status ?? String(record['status']));
  }
  return records(observation, 'GRAPH_EXTENDED')
    .filter((record) => record['source'] === 'SPAWN')
    .flatMap((record) => (record['nodes'] as Row[]) ?? [])
    .map((node) => {
      const mission = (node['mission'] as { id: string; parentId?: string } | undefined) ?? {
        id: '',
      };
      const status = ended.get(mission.id);
      return {
        name: String(node['name']),
        agent: String((node['agentRef'] as { id?: string } | undefined)?.id),
        missionId: mission.id,
        ...(mission.parentId === undefined ? {} : { parentId: mission.parentId }),
        writeScope: (
          (node['spawn'] as { writeScope?: string[] } | undefined)?.writeScope ?? []
        ).map(String),
        ...(status === undefined ? {} : { status }),
      };
    });
}

const missionEnds = (observation: Observation): Map<string, string> =>
  new Map(
    records(observation, 'MISSION_ENDED').map((record) => [
      String(record['missionId']),
      String(record['status']),
    ]),
  );

const feedbackCodes = (observation: Observation): Record<string, number> => {
  const codes: Record<string, number> = {};
  for (const record of records(observation, 'FEEDBACK')) {
    const code = String(record['code']);
    codes[code] = (codes[code] ?? 0) + 1;
  }
  return codes;
};

// --- A project split among subtasks ----------------------------------------------------------------

/** What the judge checks after the run, against the interface the goal gave. */
const KV_HIDDEN_TEST = [
  'import os, subprocess, sys, tempfile, unittest',
  'from kvstore.store import Store',
  '',
  'class Clock:',
  '    def __init__(self): self.now = 1000.0',
  '    def __call__(self): return self.now',
  '',
  'class HiddenStoreTest(unittest.TestCase):',
  '    def setUp(self):',
  '        self.dir = tempfile.mkdtemp()',
  '        self.path = os.path.join(self.dir, "db.log")',
  '    def test_set_get_delete(self):',
  '        s = Store(self.path)',
  '        s.set("a", "1"); s.set("b", "2"); s.set("a", "3")',
  '        self.assertEqual(s.get("a"), "3")',
  '        s.delete("b")',
  '        self.assertIsNone(s.get("b"))',
  '        self.assertEqual(s.keys(), ["a"])',
  '    def test_reopen(self):',
  '        s = Store(self.path); s.set("x", "y"); s.set("z", "w"); s.delete("z")',
  '        t = Store(self.path)',
  '        self.assertEqual(t.get("x"), "y")',
  '        self.assertIsNone(t.get("z"))',
  '    def test_ttl(self):',
  '        clock = Clock()',
  '        s = Store(self.path, clock=clock)',
  '        s.set("t", "v", ttl=10)',
  '        clock.now += 9',
  '        self.assertEqual(s.get("t"), "v")',
  '        clock.now += 2',
  '        self.assertIsNone(s.get("t"))',
  '        self.assertNotIn("t", s.keys())',
  '    def test_compact(self):',
  '        s = Store(self.path)',
  '        for i in range(50): s.set("k", str(i))',
  '        s.set("keep", "yes")',
  '        before = os.path.getsize(self.path)',
  '        s.compact()',
  '        self.assertLess(os.path.getsize(self.path), before)',
  '        t = Store(self.path)',
  '        self.assertEqual(t.get("k"), "49")',
  '        self.assertEqual(t.get("keep"), "yes")',
  '    def cli(self, *args):',
  '        return subprocess.run([sys.executable, "-m", "kvstore", "--db", self.path, *args], capture_output=True, text=True)',
  '    def test_cli(self):',
  '        self.assertEqual(self.cli("set", "b", "2").returncode, 0)',
  '        self.assertEqual(self.cli("set", "a", "1").returncode, 0)',
  '        got = self.cli("get", "a")',
  '        self.assertEqual(got.returncode, 0)',
  '        self.assertEqual(got.stdout.strip(), "1")',
  '        self.assertEqual(self.cli("keys").stdout.split(), ["a", "b"])',
  '        self.assertEqual(self.cli("get", "missing").returncode, 1)',
  '        self.assertEqual(self.cli("delete", "a").returncode, 0)',
  '        self.assertEqual(self.cli("keys").stdout.split(), ["b"])',
  '        self.assertEqual(self.cli("compact").returncode, 0)',
  '',
  'if __name__ == "__main__":',
  '    unittest.main()',
].join('\n');

const kvstore: TaskSpec = {
  id: 'mission.kvstore',
  mode: 'mission',
  tags: ['mission', 'project', 'orchestration', 'hard'],
  description:
    'A key-value store with persistence, expiry, compaction and a command line, split among subtasks; judged by tests the model never saw.',
  fixture: (repository) => put(repository, { 'README.md': '# kvstore\n' }),
  steps: [
    {
      run: [
        '用 Python 3 标准库实现一个小型键值存储 kvstore 包：',
        '1. kvstore/store.py 的 class Store(path, clock=time.monotonic)：get(key) 不存在返回 None；set(key, value, ttl=None)，ttl 为秒，过期按 clock() 判断；delete(key)；keys() 返回未过期键的排序列表；',
        '   持久化用追加写的日志文件（path），重新打开 Store(path) 时恢复状态；compact() 只保留当前有效的键并重写文件，使文件变小。',
        '2. 命令行：python3 -m kvstore --db <路径> set <键> <值> [--ttl 秒] | get <键>（打印值；不存在时退出码 1）| delete <键> | keys（每行一个，排序）| compact。',
        '3. tests/ 下至少 15 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过；README.md 写清用法与文件格式。',
        '这是几块相对独立的工作（存储引擎、命令行、测试与文档），请拆给多个子任务并行完成，最后由你集成并验证。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const { repository } = observation;
    const theirs = shell(repository, 'python3 -m unittest discover -s tests -t .');
    await writeFile(join(repository, 'hidden_kv_test.py'), KV_HIDDEN_TEST);
    const hidden = shell(repository, 'python3 -m unittest hidden_kv_test');
    const tasks = tasksOf(observation);
    const scopes = tasks
      .filter((task) => task.writeScope.length > 0)
      .map((task) => task.writeScope.join(','));
    const readme = await readFile(join(repository, 'README.md'), 'utf8').catch(() => '');
    return [
      check(
        'the hidden tests pass',
        'OUTCOME',
        hidden.ok && ranOf(hidden.output) === 5,
        hidden.output.slice(-600),
      ),
      check(
        'their tests pass, at least 15',
        'OUTCOME',
        theirs.ok && ranOf(theirs.output) >= 15,
        `ran ${String(ranOf(theirs.output))}`,
      ),
      check(
        'the README tells the commands',
        'OUTCOME',
        ['set', 'get', 'delete', 'keys', 'compact'].every((word) => readme.includes(word)),
      ),
      check(
        'the work was split among at least two subtasks with scopes of their own',
        'BEHAVIOR',
        tasks.length >= 2 && new Set(scopes).size === scopes.length,
        tasks
          .map(
            (task) =>
              `${task.name}(${task.agent}):${task.writeScope.join(',')}:${String(task.status)}`,
          )
          .join(' | '),
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
    ];
  },
};

// --- A survey written in chapters ----------------------------------------------------------------

const CHAPTERS = [
  ['01-introduction.md', 600],
  ['02-decomposition.md', 1200],
  ['03-coordination.md', 1200],
  ['04-failure-recovery.md', 1200],
  ['05-conclusion.md', 600],
] as const;

const paper: TaskSpec = {
  id: 'mission.paper',
  mode: 'mission',
  tags: ['mission', 'writing', 'orchestration', 'hard'],
  description:
    'A survey in five chapters written by parallel subtasks, with references the chapters cite and one term used throughout.',
  fixture: (repository) => put(repository, { 'README.md': '# survey\n' }),
  steps: [
    {
      run: [
        '写一篇中文综述《多智能体系统中的任务分解与协调》，全部放在 docs/paper/ 下：',
        `- 五章：${CHAPTERS.map(([file, length]) => `${file}（不少于 ${String(length)} 个汉字）`).join('、')}；`,
        '- docs/paper/references.md 列出至少 8 条参考文献，每条以 [n] 开头编号；各章正文用 [n] 的形式引用，全文至少引用 6 个不同的编号，且引用的编号都必须在 references.md 中存在；',
        '- docs/paper/README.md 是目录，用 Markdown 链接指向五章的文件；',
        '- 术语统一：全文一律用"任务分解"，不要出现"任务拆分"。',
        '请把各章分给不同的子任务并行撰写，最后由你统一审校、补齐引用与目录。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const base = join(observation.repository, 'docs/paper');
    const read = (file: string) => readFile(join(base, file), 'utf8').catch(() => '');
    const lengths = await Promise.all(CHAPTERS.map(async ([file]) => han(await read(file))));
    const short = CHAPTERS.filter(([, least], index) => (lengths[index] ?? 0) < least).map(
      ([file]) => file,
    );
    const references = await read('references.md');
    const listed = new Set(
      [...references.matchAll(/^\s*(?:[-*]\s*)?\[(\d+)\]/gmu)].map((match) => match[1]),
    );
    const body = (await Promise.all(CHAPTERS.map(([file]) => read(file)))).join('\n');
    const cited = new Set([...body.matchAll(/\[(\d+)\]/gu)].map((match) => match[1]));
    const missing = [...cited].filter((number) => !listed.has(number));
    const index = await read('README.md');
    const linked = CHAPTERS.filter(
      ([file]) => index.includes(`](${file})`) || index.includes(`](./${file})`),
    );
    const files = await readdir(base).catch(() => [] as string[]);
    const all = (await Promise.all(files.map((file) => read(file)))).join('\n');
    const tasks = tasksOf(observation);
    const writers = tasks.filter((task) => task.writeScope.length > 0);
    return [
      check(
        'every chapter is long enough',
        'OUTCOME',
        short.length === 0,
        `Han: ${lengths.join(',')}; short: ${short.join(',')}`,
      ),
      check('at least 8 references', 'OUTCOME', listed.size >= 8, `${String(listed.size)} listed`),
      check(
        'at least 6 references cited, every one listed',
        'OUTCOME',
        cited.size >= 6 && missing.length === 0,
        `cited ${[...cited].join(',')}; not listed ${missing.join(',')}`,
      ),
      check(
        'the index links every chapter',
        'OUTCOME',
        linked.length === CHAPTERS.length,
        `${String(linked.length)} linked`,
      ),
      check(
        'one term throughout',
        'OUTCOME',
        !all.includes('任务拆分') && all.includes('任务分解'),
        `任务拆分 ${String(all.split('任务拆分').length - 1)}, 任务分解 ${String(all.split('任务分解').length - 1)}`,
      ),
      check(
        'the chapters were written by at least two subtasks',
        'BEHAVIOR',
        writers.length >= 2,
        tasks.map((task) => `${task.name}(${task.agent}):${task.writeScope.join(',')}`).join(' | '),
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
    ];
  },
};

// --- Stopping and interrupting subtasks ------------------------------------------------------------

const stop: TaskSpec = {
  id: 'subagents.stop',
  mode: 'chat',
  tags: ['chat', 'subagents', 'orchestration', 'hard'],
  description:
    'Two subtasks look for the same answer; once the quick one has it, main stops the slow one instead of waiting minutes.',
  fixture: (repository) =>
    put(repository, {
      'docs/release.md': '# Release\nThe code name of the next release is AURORA-19.\n',
      'scan/.keep': '',
      'scripts/deep-scan.sh': [
        '#!/bin/sh',
        'echo "deep scan: indexing every file, this takes about five minutes"',
        'sleep 300',
        'echo "deep scan: nothing found"',
      ].join('\n'),
    }),
  steps: [
    {
      say: [
        '我要知道下一个版本的代号。请用一次 run_subagents 同时派两个子任务：',
        '- quick（explorer）：在 docs/ 里找发布代号；',
        '- deep（worker，写入范围 scan/）：运行 scripts/deep-scan.sh 做全量扫描（很慢，约五分钟），把结果写进 scan/result.txt。',
        '你休眠等待；quick 一给出代号，就用 stop_subagents 停掉 deep，不要等它跑完。然后告诉我代号。',
      ].join('\n'),
    },
  ],
  judge: (observation) => {
    const codes = feedbackCodes(observation);
    const tasks = tasksOf(observation);
    const deep = tasks.find((task) => task.name.includes('deep'));
    const ends = missionEnds(observation);
    const at = (record: Row | undefined) =>
      typeof record?.['at'] === 'string' ? Date.parse(record['at']) : Number.NaN;
    const first = at(observation.log[0]);
    const last = at(observation.log.at(-1));
    const minutes = (last - first) / 60_000;
    return [
      check('the answer has the code name', 'OUTCOME', replies(observation).includes('AURORA-19')),
      check(
        'main stopped the slow subtask',
        'BEHAVIOR',
        (codes['STOPPING'] ?? 0) >= 1,
        JSON.stringify(codes),
      ),
      check(
        'the slow subtask did not finish its scan',
        'BEHAVIOR',
        deep !== undefined && ends.get(deep.missionId) !== 'SUCCEEDED',
        `${String(deep?.name)}: ${String(deep === undefined ? undefined : ends.get(deep.missionId))}`,
      ),
      check('it took less than four minutes', 'BEHAVIOR', minutes < 4, `${minutes.toFixed(1)} min`),
    ];
  },
};

const interrupt: TaskSpec = {
  id: 'subagents.interrupt',
  mode: 'chat',
  tags: ['chat', 'subagents', 'messages', 'orchestration', 'hard'],
  description:
    'main starts a subtask, then interrupts it with a change of requirement; the result follows the new requirement.',
  fixture: (repository) =>
    put(repository, {
      'docs/a.md': '# Alpha\nAlpha stores orders. It keeps 30 days of history.\n',
      'docs/b.md': '# Beta\nBeta sends invoices every Monday at 06:00.\n',
      'docs/c.md': '# Gamma\nGamma checks stock levels every 15 minutes.\n',
      'notes/.keep': '',
    }),
  steps: [
    {
      say: [
        '请派一个 worker（写入范围 notes/）：把 docs/ 下每个文件各总结成一行英文，写进 notes/summary.md。',
        '派出之后，你立刻用 send_message 发一条 interrupt 消息给它，改变要求：改成用中文总结，并且文件第一行必须是"版本: 2"。',
        '然后休眠等它完成，读一下 notes/summary.md 确认符合新要求，再回复我。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const summary = await readFile(join(observation.repository, 'notes/summary.md'), 'utf8').catch(
      () => '',
    );
    const interrupts = records(observation, 'MISSION_MESSAGE').filter(
      (record) => record['interrupt'] === true,
    );
    const woken = records(observation, 'MISSION_WOKEN').filter((record) =>
      ((record['causes'] as { kind: string }[]) ?? []).some(
        (cause) => cause.kind === 'INTERRUPTED',
      ),
    );
    const firstLine = summary.split('\n')[0]?.trim() ?? '';
    return [
      check('main sent an interrupt', 'BEHAVIOR', interrupts.length >= 1),
      check(
        'the subtask took the interrupt',
        'BEHAVIOR',
        woken.length >= 1 ||
          observation.requests.some((request) =>
            request.messages.some((text) => text.includes('⚠ INTERRUPT')),
          ),
        `${String(woken.length)} woken by it`,
      ),
      check(
        'the first line is the new version',
        'OUTCOME',
        /^版本[:：]\s*2$/u.test(firstLine),
        firstLine,
      ),
      check(
        'the summary is in Chinese and covers the three files',
        'OUTCOME',
        han(summary) >= 15 && ['30', '06:00', '15'].every((fact) => summary.includes(fact)),
        summary.slice(0, 300),
      ),
    ];
  },
};

const subtaskJob: TaskSpec = {
  id: 'jobs.subtask',
  mode: 'chat',
  tags: ['chat', 'jobs', 'subagents', 'orchestration', 'hard'],
  description:
    'A worker runs a slow check in the background, edits a file meanwhile, and reports the check once it has ended.',
  fixture: (repository) =>
    put(repository, {
      VERSION: '1.4.2\n',
      'scripts/slow_check.sh': [
        '#!/bin/sh',
        'echo "slow check: running"',
        'sleep 20',
        'echo "SLOW CHECK OK: 128 assertions"',
      ].join('\n'),
    }),
  steps: [
    {
      say: [
        '请派一个 worker（写入范围只给 VERSION 这个文件）：',
        '它先在后台运行 scripts/slow_check.sh（约 20 秒，不要前台干等），在检查运行的同时把 VERSION 改成 2.0.0，',
        '然后等后台检查结束，在 finish_subagent 的报告里写出检查的最后一行。你等它结束后把检查结果告诉我。',
      ].join('\n'),
    },
  ],
  judge: async (observation) => {
    const version = (
      await readFile(join(observation.repository, 'VERSION'), 'utf8').catch(() => '')
    ).trim();
    const root = records(observation, 'AGENT_RUN_REGISTERED')[0]?.['missionId'];
    const jobs = records(observation, 'JOB_STARTED');
    const inSubtask = jobs.filter(
      (job) => job['missionId'] !== root && String(job['command']).includes('slow_check'),
    );
    return [
      check(
        'the worker ran the check in the background',
        'BEHAVIOR',
        inSubtask.length >= 1,
        jobs.map((job) => `${String(job['missionId'])}:${String(job['command'])}`).join(' | '),
      ),
      check('VERSION was changed', 'OUTCOME', version === '2.0.0', version),
      check(
        'the answer has the result of the check',
        'OUTCOME',
        replies(observation).includes('128'),
      ),
    ];
  },
};

export const ORCHESTRATION_HARD_TASKS: readonly TaskSpec[] = [
  subtaskJob,
  stop,
  interrupt,
  kvstore,
  paper,
];
