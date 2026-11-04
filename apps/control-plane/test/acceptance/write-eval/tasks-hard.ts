/**
 * The harder half of the write evaluation: algorithms written from a specification, causes far
 * from their symptoms, changes across dozens of files, and a long conversation with review
 * comments. The easy half shows that the tools work; this half shows how far an agent gets.
 */
import type { Judged, WriteTask } from './tasks.js';

const say = (text: string) => ({ say: text });
const nodeTest = ['node', '--test', 'hidden.test.ts'];
const pyTest = ['python3', '-m', 'unittest', 'hidden_test'];
const lacks = (cond: boolean, message: string): readonly string[] => (cond ? [] : [message]);
const TS = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n";

/** Thirty modules, each calling the old logger in two places. */
const loggerRepo = (): Record<string, string> => {
  const files: Record<string, string> = {
    'src/logger.ts':
      'export const lines: string[] = [];\n\nexport function log(level: string, message: string): void {\n  lines.push(`${level}:${message}`);\n}\n',
  };
  const names: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    const name = `job${String(i)}`;
    names.push(name);
    files[`src/jobs/${name}.ts`] =
      `import { log } from '../logger.ts';\n\nexport function ${name}(input: number): number {\n  log('info', 'start ${name}');\n  const result = input + ${String(i)};\n  log(result > 100 ? 'warn' : 'info', \`done ${name} \${String(result)}\`);\n  return result;\n}\n`;
  }
  files['src/jobs/index.ts'] = names.map((n) => `export { ${n} } from './${n}.ts';\n`).join('');
  return files;
};

/** A long Python module whose functions look alike. */
const longPython = (): string => {
  const parts = ['"""Conversion tables for the reporting pipeline."""\n'];
  for (let i = 0; i < 400; i += 1)
    parts.push(
      `def convert_${String(i)}(amount, rate=1.0):\n    """Conversion number ${String(i)}."""\n    scaled = amount * rate\n    return scaled + ${String(i)}\n`,
    );
  return parts.join('\n');
};

const vitest = (...files: readonly string[]) => ['npx', 'vitest', 'run', ...files];
const build = ['npx', 'tsc', '-b', '--pretty', 'false'];

/** Changes to MultiAgentOS itself: hundreds of files, real conventions, a real type checker. */
export const REAL_TASKS: readonly WriteTask[] = [
  {
    id: 'real-edit-dashes',
    category: 'real-repository',
    language: 'ts',
    realRepository: true,
    files: {},
    steps: [
      say(
        "edit_file's matching retries with typographic quotes normalised. Also treat the dash variants U+2010 to U+2015 and U+2212 as '-' in that same retry, the way quotes are handled. The exact match must still win. Add tests next to the existing ones.",
      ),
    ],
    hidden: {
      'packages/libraries/executor-set/src/fs/zz-hidden.test.ts': `import { expect, it } from 'vitest';
import { applyEdit } from './edit-match.js';
const edit = (c: string, o: string, n: string) => applyEdit(c, { oldString: o, newString: n, replaceAll: false });
it('dash in the file', () => expect(edit('a\u2014b c', 'a-b', 'x')).toMatchObject({ content: 'x c' }));
it('dash in the target', () => expect(edit('a-b c', 'a\u2013b', 'x')).toMatchObject({ content: 'x c' }));
it('minus', () => expect(edit('a\u2212b', 'a-b', 'x')).toMatchObject({ content: 'x' }));
it('exact wins', () => expect(edit('a-b a\u2014b', 'a-b', 'x')).toMatchObject({ content: 'x a\u2014b' }));
it('keeps quotes', () => expect(edit('\u201Chi\u201D', '"hi"', 'x')).toMatchObject({ content: 'x' }));
it('still unique', () => expect(edit('a\u2014b a\u2013b', 'a-b', 'x')).toMatchObject({ ok: false, reasonCode: 'EDIT_NOT_UNIQUE' }));
`,
    },
    runs: [build, vitest('packages/libraries/executor-set/src/fs/')],
  },
  {
    id: 'real-protect-ssh',
    category: 'real-repository',
    language: 'ts',
    realRepository: true,
    files: {},
    steps: [
      say(
        '写文件时，任何层级的 .ssh 或 .aws 目录下的路径都必须拒绝。读取不受影响，不要改读取的排除规则。加上测试。',
      ),
    ],
    hidden: {
      'packages/libraries/contracts/src/platform-common/zz-hidden.test.ts': `import { expect, it } from 'vitest';
import { DEFAULT_REPOSITORY_EXCLUSIONS, isExcluded } from './repository-exclusions.js';
import { isWritable } from './write-access.js';
const p = { writeRoots: ['.'], exclusions: [] };
it.each(['.ssh/config', 'a/.ssh/id', '.aws/credentials', 'x/y/.AWS/config', '.ssh'])('%s', (path) => expect(isWritable(p, path)).toEqual({ writable: false, reasonCode: 'PROTECTED_PATH' }));
it('others', () => { expect(isWritable(p, 'ssh/config').writable).toBe(true); expect(isWritable(p, 'a/.sshd').writable).toBe(true); });
it('reading is untouched', () => expect(isExcluded('.ssh/config', DEFAULT_REPOSITORY_EXCLUSIONS)).toBe(false));
`,
    },
    runs: [build, vitest('packages/libraries/contracts/src/platform-common/')],
  },
  {
    id: 'real-new-reason-code',
    category: 'real-repository',
    language: 'ts',
    realRepository: true,
    files: {},
    steps: [
      say(
        'Add a reason code FILE_TOO_LARGE. file-write and file-edit return it, instead of LIMIT_EXCEEDED, when the current file or the new content is over the size limit. Other Executors keep LIMIT_EXCEEDED. Do everything a new reason code needs across the packages: the model must get a useful hint, the console a message, and both Unit definitions must hand it back to the model.',
      ),
    ],
    hidden: {
      'packages/libraries/executor-set/src/fs/zz-hidden.test.ts': `import { readFileSync } from 'node:fs';
import { REASON_CODES, EXECUTOR_REJECTED_CODES } from '@multiagentos/contracts';
import { expect, it } from 'vitest';
import { emptyDirectory, environmentFor } from '../test-support/environments.js';
import { createFileWriteExecutor } from './file-write-executor.js';
import { PathLocks } from './guarded-write.js';
import { REJECTED_HINTS } from '../context-assemble/tool-hints.js';
it('known', () => { expect(REASON_CODES).toContain('FILE_TOO_LARGE'); expect(EXECUTOR_REJECTED_CODES).toContain('FILE_TOO_LARGE'); });
it('hint', () => expect((REJECTED_HINTS as Record<string, string>).FILE_TOO_LARGE?.length).toBeGreaterThan(10));
it('returned', async () => {
  const root = await emptyDirectory('hidden');
  const outcome = await createFileWriteExecutor(new PathLocks()).execute(
    { path: 'big.txt', content: 'x'.repeat(17 * 1024 * 1024), expectAbsent: true },
    environmentFor('FILE_WRITE', { kind: 'WORKSPACE', repositoryRoot: root, writableRoots: ['.'], exclusions: [] }),
  );
  expect(outcome).toMatchObject({ outcome: 'REJECTED', reasonCode: 'FILE_TOO_LARGE' });
});
it.each(['file-write', 'file-edit'])('%s policy', (unit) => {
  const text = readFileSync(new URL('../../../agent-tool-pool/definitions/units/' + unit + '/v0.1.0.yaml', import.meta.url), 'utf8');
  expect(text).toMatch(/FILE_TOO_LARGE: RETURN_TO_MODEL/);
});
`,
    },
    runs: [
      build,
      vitest(
        'packages/libraries/executor-set/src/fs/',
        'packages/libraries/agent-tool-pool/',
        'packages/modules/user-interaction/',
      ),
    ],
  },
  {
    id: 'real-output-read-context',
    category: 'real-repository',
    language: 'ts',
    realRepository: true,
    files: {},
    steps: [
      say(
        '给 read_output 加一个可选参数 context（0 到 5 的整数）：配合 pattern 使用时，每个匹配行前后各多带 context 行，相邻的范围合并，行号仍然是原文的行号。模型可见的参数、Unit 输入、Executor 输入都要改通，并加上测试。',
      ),
    ],
    hidden: {
      'packages/libraries/executor-set/src/output-read/zz-hidden.test.ts': `import { OutputReadArgsSchema, validate } from '@multiagentos/contracts';
import { expect, it } from 'vitest';
import { environmentFor } from '../test-support/environments.js';
import { createOutputReadExecutor } from './output-read-executor.js';
const run = async (input: object) => {
  const outcome = await createOutputReadExecutor().execute({ toolCallId: 'call_1', content: 'a\nb\nHIT\nd\ne\nf\ng\nHIT\ni\n', ...input } as never, environmentFor('OUTPUT_READ', { kind: 'NONE' }));
  if (outcome.outcome !== 'COMPLETED') throw new Error(outcome.outcome);
  return outcome.result.artifact.text;
};
it('args', () => { expect(validate(OutputReadArgsSchema, { toolCallId: 'call_1', pattern: 'x', context: 2 }).ok).toBe(true); expect(validate(OutputReadArgsSchema, { toolCallId: 'call_1', context: 6 }).ok).toBe(false); });
it('context lines', async () => { const t = await run({ pattern: 'HIT', context: 1 }); for (const l of ['2 | b','3 | HIT','4 | d','7 | g','8 | HIT','9 | i']) expect(t).toContain(l); expect(t).not.toContain('5 | e'); expect(t).not.toContain('1 | a'); });
it('merge', async () => { const t = await run({ pattern: 'HIT', context: 2 }); expect(t.match(/5 \| e/g)?.length).toBe(1); expect(t.match(/6 \| f/g)?.length).toBe(1); });
it('without context as before', async () => { const t = await run({ pattern: 'HIT' }); expect(t).toContain('3 | HIT'); expect(t).not.toContain('2 | b'); });
`,
    },
    runs: [build, vitest('packages/libraries/executor-set/src/output-read/')],
  },
];

export const HARD_TASKS: readonly WriteTask[] = [
  {
    id: 'hard-root-cause-elsewhere',
    category: 'hard-bugfix',
    language: 'ts',
    files: {
      'src/money.ts':
        'export const toCents = (amount: number): number => Math.floor(amount * 100);\n\nexport const fromCents = (cents: number): number => cents / 100;\n',
      'src/tax.ts':
        "import { toCents } from './money.ts';\n\nexport const taxCents = (amount: number, rate: number): number => toCents(amount) * rate;\n",
      'src/line.ts':
        "import { toCents } from './money.ts';\nimport { taxCents } from './tax.ts';\n\nexport interface Line {\n  price: number;\n  qty: number;\n}\n\nexport const lineCents = (line: Line, rate: number): number => {\n  const net = toCents(line.price) * line.qty;\n  return net + taxCents(line.price * line.qty, rate);\n};\n",
      'src/invoice.ts':
        "import { fromCents } from './money.ts';\nimport { lineCents, type Line } from './line.ts';\n\nexport const invoiceTotal = (lines: readonly Line[], rate: number): number =>\n  fromCents(lines.reduce((sum, line) => sum + lineCents(line, rate), 0));\n",
      'src/format.ts':
        'export const formatTotal = (total: number): string => `$${total.toFixed(2)}`;\n',
      'README.md':
        '# invoices\n\nMoney is kept in whole cents; amounts round to the nearest cent, tax included.\n',
    },
    steps: [
      say(
        "A customer's invoice is wrong: invoiceTotal([{ price: 19.99, qty: 3 }], 0.075) should be 64.47 but it returns something else, and sometimes a long fraction. Find the cause and fix it at the cause, not in invoiceTotal.",
      ),
    ],
    hidden: {
      'hidden.test.ts': `${TS}import { invoiceTotal } from './src/invoice.ts'; import { toCents } from './src/money.ts'; import { lineCents } from './src/line.ts';
test('the case', () => assert.equal(invoiceTotal([{price:19.99,qty:3}], 0.075), 64.47));
test('rounds to nearest', () => { assert.equal(toCents(19.99), 1999); assert.equal(toCents(1.005 + 0.001), 101); assert.equal(toCents(0.29), 29); });
test('whole cents', () => assert.ok(Number.isInteger(lineCents({price:0.1,qty:3}, 0.07))));
test('no tax', () => assert.equal(invoiceTotal([{price:1.1,qty:3}], 0), 3.3));
`,
    },
    run: nodeTest,
  },
  {
    id: 'hard-expression-evaluator',
    category: 'hard-algorithm',
    language: 'py',
    files: {
      'calc/__init__.py': 'from .evaluate import evaluate, EvalError\n',
      'calc/evaluate.py':
        'class EvalError(Exception):\n    """Raised for anything that is not a valid expression."""\n\n\ndef evaluate(text, variables=None):\n    raise NotImplementedError\n',
      'SPEC.md':
        '# Expressions\n\nNumbers (integers and decimals), variables (letters and underscores), `+ - * / %`, `^` for\npower (right associative, binds tighter than unary minus on its left: `-2^2` is -4), parentheses,\nunary minus, and functions `min(a, b, ...)`, `max(a, b, ...)`, `abs(x)`.\nWhitespace is free. Division by zero, unknown variables or functions, and any syntax error raise\nEvalError. `eval` and `exec` and `ast` must not be used.\n',
    },
    steps: [say('Implement calc/evaluate.py according to SPEC.md.')],
    hidden: {
      'hidden_test.py': `import unittest
from calc import evaluate, EvalError
class T(unittest.TestCase):
    def test_precedence(self):
        self.assertEqual(evaluate("1 + 2 * 3"), 7); self.assertEqual(evaluate("(1+2)*3"), 9); self.assertEqual(evaluate("7 % 4 + 1"), 4)
    def test_power(self):
        self.assertEqual(evaluate("2^3^2"), 512); self.assertEqual(evaluate("-2^2"), -4); self.assertEqual(evaluate("2^-1"), 0.5)
    def test_unary(self):
        self.assertEqual(evaluate("--3"), 3); self.assertEqual(evaluate("2*-3"), -6)
    def test_vars(self):
        self.assertEqual(evaluate("a_b + 1", {"a_b": 2}), 3)
    def test_functions(self):
        self.assertEqual(evaluate("max(1, 2+3, min(9, 4))"), 5); self.assertEqual(evaluate("abs(-2.5)"), 2.5)
    def test_decimals(self):
        self.assertAlmostEqual(evaluate(" 1.5 *\\t2 "), 3.0)
    def test_errors(self):
        for bad in ["1/0", "1 +", "(1", "1)", "x", "foo(1)", "", "1 2", "2 $ 3", "min()", "abs(1,2)", "1..2"]:
            with self.assertRaises(EvalError, msg=bad): evaluate(bad)
`,
    },
    run: pyTest,
    check: ({ files }) =>
      lacks(
        !/\b(eval|exec)\(|import ast/u.test(
          (files.get('calc/evaluate.py') ?? '')
            .replaceAll('def evaluate(', '')
            .replaceAll('evaluate(', ''),
        ),
        'used eval, exec or ast',
      ),
  },
  {
    id: 'hard-callback-to-async',
    category: 'hard-refactor',
    language: 'ts',
    files: {
      'src/types.ts':
        'export type Callback<T> = (error: Error | null, value?: T) => void;\n\nexport interface User {\n  id: string;\n  name: string;\n  teamId?: string;\n}\n',
      'src/db.ts':
        "import type { Callback, User } from './types.ts';\n\nconst USERS: Record<string, User> = {\n  a: { id: 'a', name: 'Ann', teamId: 't1' },\n  b: { id: 'b', name: 'Bob' },\n};\nconst TEAMS: Record<string, string> = { t1: 'Core' };\n\nexport function findUser(id: string, done: Callback<User>): void {\n  setTimeout(() => {\n    const user = USERS[id];\n    if (user === undefined) done(new Error(`no user ${id}`));\n    else done(null, user);\n  }, 1);\n}\n\nexport function findTeam(id: string, done: Callback<string>): void {\n  setTimeout(() => {\n    const team = TEAMS[id];\n    if (team === undefined) done(new Error(`no team ${id}`));\n    else done(null, team);\n  }, 1);\n}\n",
      'src/profile.ts':
        "import { findTeam, findUser } from './db.ts';\nimport type { Callback } from './types.ts';\n\nexport function profile(id: string, done: Callback<string>): void {\n  findUser(id, (error, user) => {\n    if (error || user === undefined) return done(error);\n    if (user.teamId === undefined) return done(null, `${user.name} (no team)`);\n    findTeam(user.teamId, (teamError, team) => {\n      if (teamError) return done(teamError);\n      done(null, `${user.name} (${team ?? ''})`);\n    });\n  });\n}\n",
      'src/batch.ts':
        "import { profile } from './profile.ts';\nimport type { Callback } from './types.ts';\n\n/** Results keep the order of the ids; the first error fails the batch. */\nexport function profiles(ids: readonly string[], done: Callback<string[]>): void {\n  const results: string[] = [];\n  let left = ids.length;\n  let failed = false;\n  if (left === 0) return done(null, []);\n  ids.forEach((id, index) => {\n    profile(id, (error, value) => {\n      if (failed) return;\n      if (error) {\n        failed = true;\n        return done(error);\n      }\n      results[index] = value ?? '';\n      left -= 1;\n      if (left === 0) done(null, results);\n    });\n  });\n}\n",
      'src/index.ts':
        "export { findTeam, findUser } from './db.ts';\nexport { profile } from './profile.ts';\nexport { profiles } from './batch.ts';\n",
    },
    steps: [
      say(
        '把这个项目从回调风格全部改成 async/await：db、profile、batch 的函数都改成返回 Promise，不再接受回调，Callback 类型删掉。batch 仍然并发执行、保持顺序，第一个错误让整批失败。错误信息不能变。',
      ),
    ],
    hidden: {
      'hidden.test.ts': `${TS}import { findUser, findTeam, profile, profiles } from './src/index.ts';
test('values', async () => { assert.equal((await findUser('a')).name, 'Ann'); assert.equal(await findTeam('t1'), 'Core'); });
test('profile', async () => { assert.equal(await profile('a'), 'Ann (Core)'); assert.equal(await profile('b'), 'Bob (no team)'); });
test('errors', async () => { await assert.rejects(findUser('z'), /no user z/); await assert.rejects(profile('z'), /no user z/); });
test('batch keeps order', async () => assert.deepEqual(await profiles(['b','a']), ['Bob (no team)','Ann (Core)']));
test('batch empty', async () => assert.deepEqual(await profiles([]), []));
test('batch fails', async () => assert.rejects(profiles(['a','z']), /no user z/));
test('batch is concurrent', async () => { const t = Date.now(); await profiles(Array.from({length:30},()=>'b')); assert.ok(Date.now() - t < 25 * 3, 'ran one after another'); });
`,
    },
    run: nodeTest,
    check: ({ files }) =>
      [...files].flatMap(([path, text]) =>
        path.startsWith('src/') && text.includes('Callback')
          ? [`${path} still mentions Callback`]
          : [],
      ),
  },
  {
    id: 'hard-topological-scheduler',
    category: 'hard-feature',
    language: 'ts',
    files: {
      'src/task.ts':
        'export interface Task {\n  name: string;\n  run: () => Promise<void>;\n  needs?: readonly string[];\n}\n',
      'src/runner.ts':
        "import type { Task } from './task.ts';\n\nexport async function runAll(tasks: readonly Task[]): Promise<readonly string[]> {\n  const order: string[] = [];\n  for (const task of tasks) {\n    await task.run();\n    order.push(task.name);\n  }\n  return order;\n}\n",
      'src/index.ts':
        "export { runAll } from './runner.ts';\nexport type { Task } from './task.ts';\n",
    },
    steps: [
      say(
        'runAll ignores `needs`. Change it: a task starts only after all its needs have finished, tasks that can run at the same time do run at the same time, and at most `concurrency` run at once (a new optional second argument, default 4). Return the names in the order they finished. Before running anything, throw CycleError (export it from src/index.ts) with a message naming the tasks on a cycle if there is one, and Error naming the task and the missing need if a need does not exist. If a task fails, start nothing new, wait for the ones running, and reject with that first error.',
      ),
    ],
    hidden: {
      'hidden.test.ts': `${TS}import { runAll, CycleError } from './src/index.ts';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const task = (name: string, needs: string[] = [], log: string[] = [], ms = 2) => ({ name, needs, run: async () => { log.push('s:'+name); await sleep(ms); log.push('e:'+name); } });
test('order', async () => { const l: string[] = []; await runAll([task('c',['b'],l), task('b',['a'],l), task('a',[],l)]); assert.deepEqual(l, ['s:a','e:a','s:b','e:b','s:c','e:c']); });
test('returns finish order', async () => assert.deepEqual(await runAll([task('slow',[],[],20), task('fast',[],[],1)]), ['fast','slow']));
test('parallel', async () => { const l: string[] = []; await runAll([task('a',[],l,10), task('b',[],l,10)]); assert.ok(l.indexOf('s:b') < l.indexOf('e:a')); });
test('limit', async () => { let now=0, peak=0; const t=(n:string)=>({name:n,run:async()=>{now++;peak=Math.max(peak,now);await sleep(3);now--;}}); await runAll(['a','b','c','d','e','f'].map(t),2); assert.equal(peak,2); });
test('cycle', async () => { let ran=false; await assert.rejects(runAll([{name:'x',needs:['y'],run:async()=>{ran=true;}},{name:'y',needs:['x'],run:async()=>{ran=true;}},{name:'z',run:async()=>{ran=true;}}]), (e: Error) => e instanceof CycleError && /x/.test(e.message) && /y/.test(e.message)); assert.equal(ran,false); });
test('missing', async () => assert.rejects(runAll([task('a',['ghost'])]), /a.*ghost|ghost.*a/));
test('failure stops', async () => { const l:string[]=[]; await assert.rejects(runAll([{name:'bad',run:async()=>{throw new Error('boom');}},task('after',['bad'],l),{name:'slow',run:async()=>{await sleep(10);l.push('slow');}}],2),/boom/); assert.ok(!l.includes('s:after')); assert.ok(l.includes('slow')); });
test('empty', async () => assert.deepEqual(await runAll([]), []));
`,
    },
    run: nodeTest,
  },
  {
    id: 'hard-template-method-refactor',
    category: 'hard-refactor',
    language: 'py',
    files: {
      'exporters/__init__.py': '',
      'exporters/csv_exporter.py':
        'class CsvExporter:\n    def export(self, rows):\n        if not rows:\n            raise ValueError("no rows")\n        clean = [{k: str(v).strip() for k, v in r.items()} for r in rows]\n        header = ",".join(clean[0].keys())\n        body = "\\n".join(",".join(r.values()) for r in clean)\n        return header + "\\n" + body\n',
      'exporters/json_exporter.py':
        'import json\n\n\nclass JsonExporter:\n    def export(self, rows):\n        if not rows:\n            raise ValueError("no rows")\n        clean = [{k: str(v).strip() for k, v in r.items()} for r in rows]\n        return json.dumps(clean, sort_keys=True)\n',
      'exporters/markdown_exporter.py':
        'class MarkdownExporter:\n    def export(self, rows):\n        if not rows:\n            raise ValueError("no rows")\n        clean = [{k: str(v).strip() for k, v in r.items()} for r in rows]\n        keys = list(clean[0].keys())\n        lines = ["| " + " | ".join(keys) + " |", "|" + "---|" * len(keys)]\n        lines += ["| " + " | ".join(r[k] for k in keys) + " |" for r in clean]\n        return "\\n".join(lines)\n',
      'exporters/factory.py':
        'from .csv_exporter import CsvExporter\nfrom .json_exporter import JsonExporter\nfrom .markdown_exporter import MarkdownExporter\n\n\ndef get(name):\n    if name == "csv":\n        return CsvExporter()\n    if name == "json":\n        return JsonExporter()\n    if name == "markdown":\n        return MarkdownExporter()\n    raise KeyError(name)\n',
    },
    steps: [
      say(
        'The three exporters repeat the same checks. Create exporters/base.py with an abstract base class Exporter whose export(rows) does the check and the cleaning once and calls an abstract _render(clean_rows). Each exporter only implements _render. Also replace the if chain in factory.py with a registry: a decorator register("csv") in base.py on each exporter class, and get(name) looks it up, still raising KeyError for an unknown name. Importing exporters.factory alone must make all three available.',
      ),
    ],
    hidden: {
      'hidden_test.py': `import json, unittest
from exporters.factory import get
from exporters.base import Exporter
R = [{"a": " 1 ", "b": 2}, {"a": "x", "b": " y"}]
class T(unittest.TestCase):
    def test_csv(self): self.assertEqual(get("csv").export(R), "a,b\\n1,2\\nx,y")
    def test_json(self): self.assertEqual(json.loads(get("json").export(R)), [{"a":"1","b":"2"},{"a":"x","b":"y"}])
    def test_md(self): self.assertEqual(get("markdown").export(R), "| a | b |\\n|---|---|\\n| 1 | 2 |\\n| x | y |")
    def test_empty(self):
        for n in ("csv","json","markdown"):
            with self.assertRaises(ValueError): get(n).export([])
    def test_unknown(self):
        with self.assertRaises(KeyError): get("xml")
    def test_abstract(self):
        with self.assertRaises(TypeError): Exporter()
    def test_subclass(self):
        for n in ("csv","json","markdown"): self.assertIsInstance(get(n), Exporter)
`,
    },
    run: pyTest,
    check: ({ files }) =>
      ['csv', 'json', 'markdown'].flatMap((name) => {
        const text = files.get(`exporters/${name}_exporter.py`) ?? '';
        return [
          ...lacks(!text.includes('no rows'), `${name} still checks for itself`),
          ...lacks(text.includes('_render'), `${name} has no _render`),
        ];
      }),
  },
  {
    id: 'hard-thirty-file-api-change',
    category: 'hard-refactor',
    language: 'ts',
    files: loggerRepo(),
    steps: [
      say(
        "Change the logger API: log(level, message) becomes log({ level, message }), one object argument, and the line it records stays `level:message`. Update every caller under src/jobs. Don't leave a compatibility wrapper for the old form.",
      ),
    ],
    hidden: {
      'hidden.test.ts': `${TS}import * as jobs from './src/jobs/index.ts'; import { log, lines } from './src/logger.ts';
test('new form', () => { lines.length = 0; log({level:'info',message:'x'}); assert.deepEqual(lines,['info:x']); });
test('all thirty', () => { for (let i = 0; i < 30; i++) { lines.length = 0; assert.equal((jobs as any)['job'+i](1), 1+i); assert.deepEqual(lines, ['info:start job'+i, 'info:done job'+i+' '+(1+i)]); } });
test('warn', () => { lines.length = 0; jobs.job5(200); assert.equal(lines[1], 'warn:done job5 205'); });
`,
    },
    run: nodeTest,
    check: ({ files }) =>
      [...files].flatMap(([path, text]) =>
        path.startsWith('src/jobs/job') && /log\('/u.test(text)
          ? [`${path} keeps the old call`]
          : [],
      ),
  },
  {
    id: 'hard-state-machine-from-spec',
    category: 'hard-feature',
    language: 'ts',
    files: {
      'docs/orders.md':
        '# Order lifecycle\n\nStates: draft, placed, paid, shipped, delivered, cancelled, refunded.\n\n- place: draft -> placed, needs at least one item.\n- pay(amount): placed -> paid, amount must equal the total exactly.\n- ship: paid -> shipped.\n- deliver: shipped -> delivered.\n- cancel: draft, placed or paid -> cancelled. Cancelling from paid also refunds: refundedCents = paid amount.\n- refund(amount): delivered -> refunded, only within 30 days of delivery, amount at most the paid amount.\n\nAny other transition throws TransitionError, whose `from` and `action` say what was refused. A failed\naction changes nothing. Every successful action appends { action, at } to `history`, where `at` comes\nfrom the clock given to the constructor (milliseconds).\n',
      'src/order.ts':
        "export type State = 'draft' | 'placed' | 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';\n\nexport class Order {\n  state: State = 'draft';\n  history: { action: string; at: number }[] = [];\n  refundedCents = 0;\n  private readonly now: () => number;\n  private readonly itemCents: number[];\n\n  constructor(itemCents: readonly number[], now: () => number = Date.now) {\n    this.itemCents = [...itemCents];\n    this.now = now;\n  }\n\n  get total(): number {\n    return this.itemCents.reduce((a, b) => a + b, 0);\n  }\n}\n",
    },
    steps: [
      say(
        'Implement the order lifecycle in src/order.ts as docs/orders.md describes. Export TransitionError from there too.',
      ),
    ],
    hidden: {
      'hidden.test.ts': `${TS}import { Order, TransitionError } from './src/order.ts';
const DAY = 86400000; const make = (items = [100,200]) => { let t = 1000; const o = new Order(items, () => t); return { o, go: (d: number) => { t += d; } }; };
const delivered = () => { const m = make(); m.o.place(); m.o.pay(300); m.o.ship(); m.o.deliver(); return m; };
test('happy path', () => { const {o} = delivered(); assert.equal(o.state,'delivered'); assert.deepEqual(o.history.map(h=>h.action),['place','pay','ship','deliver']); assert.equal(o.history[0]?.at,1000); });
test('empty cannot place', () => { const o = new Order([]); assert.throws(()=>o.place(),TransitionError); assert.equal(o.state,'draft'); assert.equal(o.history.length,0); });
test('exact payment', () => { const {o} = make(); o.place(); assert.throws(()=>o.pay(299),TransitionError); assert.equal(o.state,'placed'); o.pay(300); assert.equal(o.state,'paid'); });
test('error says what', () => { const {o} = make(); try { o.ship(); assert.fail(); } catch (e) { assert.ok(e instanceof TransitionError); assert.equal(e.from,'draft'); assert.equal(e.action,'ship'); } });
test('cancel from paid refunds', () => { const {o} = make(); o.place(); o.pay(300); o.cancel(); assert.equal(o.state,'cancelled'); assert.equal(o.refundedCents,300); });
test('cancel from placed', () => { const {o} = make(); o.place(); o.cancel(); assert.equal(o.refundedCents,0); });
test('no cancel after shipping', () => { const {o} = make(); o.place(); o.pay(300); o.ship(); assert.throws(()=>o.cancel(),TransitionError); });
test('refund window', () => { const a = delivered(); a.go(30*DAY); a.o.refund(100); assert.equal(a.o.state,'refunded'); assert.equal(a.o.refundedCents,100); const b = delivered(); b.go(30*DAY+1); assert.throws(()=>b.o.refund(100),TransitionError); assert.equal(b.o.state,'delivered'); });
test('refund limit', () => { const {o} = delivered(); assert.throws(()=>o.refund(301),TransitionError); assert.equal(o.refundedCents,0); });
test('terminal', () => { const {o} = delivered(); o.refund(1); assert.throws(()=>o.refund(1),TransitionError); });
`,
    },
    run: nodeTest,
  },
  {
    id: 'hard-cache-invalidation',
    category: 'hard-feature',
    language: 'py',
    files: {
      'catalog/__init__.py': '',
      'catalog/repo.py':
        'class Repo:\n    """Stands in for a database; calls counts every read."""\n\n    def __init__(self):\n        self.rows = {}\n        self.calls = 0\n\n    def get(self, key):\n        self.calls += 1\n        return self.rows.get(key)\n\n    def put(self, key, value):\n        self.rows[key] = value\n\n    def delete(self, key):\n        self.rows.pop(key, None)\n\n    def by_tag(self, tag):\n        self.calls += 1\n        return sorted(k for k, v in self.rows.items() if tag in v.get("tags", []))\n',
      'catalog/service.py':
        'class Service:\n    def __init__(self, repo):\n        self.repo = repo\n\n    def get(self, key):\n        return self.repo.get(key)\n\n    def put(self, key, value):\n        self.repo.put(key, value)\n\n    def delete(self, key):\n        self.repo.delete(key)\n\n    def by_tag(self, tag):\n        return self.repo.by_tag(tag)\n',
    },
    steps: [
      say(
        '给 Service 加缓存：get 和 by_tag 的结果都缓存，重复读取不再访问 repo（包括读到 None 的情况）。put 和 delete 之后缓存不能给出过期的数据：改动一个 key 时，它自己的缓存失效；by_tag 的缓存只让受影响的 tag 失效（新旧值里出现过的 tag），其他 tag 的缓存保留。返回给调用方的值被调用方修改后，不能污染缓存。不要改 repo.py。',
      ),
    ],
    hidden: {
      'hidden_test.py': `import unittest
from catalog.repo import Repo
from catalog.service import Service
def make():
    r = Repo(); s = Service(r)
    s.put("a", {"tags":["x"]}); s.put("b", {"tags":["y"]})
    return r, s
class T(unittest.TestCase):
    def test_get_cached(self):
        r, s = make(); r.calls = 0; s.get("a"); s.get("a"); self.assertEqual(r.calls, 1)
    def test_none_cached(self):
        r, s = make(); r.calls = 0; self.assertIsNone(s.get("z")); self.assertIsNone(s.get("z")); self.assertEqual(r.calls, 1)
    def test_put_invalidates(self):
        r, s = make(); s.get("a"); s.put("a", {"tags":[], "n":1}); self.assertEqual(s.get("a")["n"], 1)
    def test_delete_invalidates(self):
        r, s = make(); s.get("a"); s.delete("a"); self.assertIsNone(s.get("a"))
    def test_tag_cached(self):
        r, s = make(); r.calls = 0; s.by_tag("x"); s.by_tag("x"); self.assertEqual(r.calls, 1)
    def test_new_tag(self):
        r, s = make(); s.by_tag("y"); s.put("c", {"tags":["y"]}); self.assertEqual(s.by_tag("y"), ["b","c"])
    def test_old_tag(self):
        r, s = make(); s.by_tag("x"); s.put("a", {"tags":["y"]}); self.assertEqual(s.by_tag("x"), [])
    def test_delete_tag(self):
        r, s = make(); s.by_tag("x"); s.delete("a"); self.assertEqual(s.by_tag("x"), [])
    def test_other_tag_kept(self):
        r, s = make(); s.by_tag("y"); r.calls = 0; s.put("a", {"tags":["x"]}); s.by_tag("y"); self.assertEqual(r.calls, 0)
    def test_no_pollution(self):
        r, s = make(); v = s.get("a"); v["tags"].append("hacked"); self.assertEqual(s.get("a"), {"tags":["x"]})
        t = s.by_tag("x"); t.append("hacked"); self.assertEqual(s.by_tag("x"), ["a"])
`,
    },
    run: pyTest,
    check: ({ changed }) => lacks(!changed.includes('catalog/repo.py'), 'changed repo.py'),
  },
  {
    id: 'hard-config-migration',
    category: 'hard-refactor',
    language: 'mixed',
    files: {
      'config/dev.json':
        '{\n  "db_host": "localhost",\n  "db_port": 5432,\n  "debug": true,\n  "retry": 3\n}\n',
      'config/prod.json':
        '{\n  "db_host": "db.internal",\n  "db_port": 6432,\n  "debug": false,\n  "retry": 5,\n  "replica": "db2.internal"\n}\n',
      'config/test.json': '{\n  "db_host": "127.0.0.1",\n  "db_port": 5433,\n  "debug": true\n}\n',
      'settings.py':
        'import json\n\n\ndef load(path):\n    with open(path, encoding="utf-8") as handle:\n        raw = json.load(handle)\n    return {\n        "dsn": f"{raw[\'db_host\']}:{raw[\'db_port\']}",\n        "debug": raw["debug"],\n        "retry": raw.get("retry", 1),\n        "replica": raw.get("replica"),\n    }\n',
    },
    steps: [
      say(
        'Move the config files to a new shape: { "version": 2, "database": { "host", "port", "replica" when there is one }, "debug", "retries" }. retries is the old retry, or 1 when there was none, written out explicitly. Rewrite all three files in config/. settings.load must accept both the old and the new shape and return exactly what it returns today, and raise ValueError for a version it does not know.',
      ),
    ],
    hidden: {
      'hidden_test.py': `import json, os, tempfile, unittest, settings
OLD = {"db_host":"h","db_port":1,"debug":True}
class T(unittest.TestCase):
    def test_files(self):
        d = json.load(open("config/prod.json")); self.assertEqual(d, {"version":2,"database":{"host":"db.internal","port":6432,"replica":"db2.internal"},"debug":False,"retries":5})
        t = json.load(open("config/test.json")); self.assertEqual(t, {"version":2,"database":{"host":"127.0.0.1","port":5433},"debug":True,"retries":1})
        v = json.load(open("config/dev.json")); self.assertEqual(v["database"]["port"], 5432); self.assertEqual(v["retries"], 3)
    def test_load_new(self):
        self.assertEqual(settings.load("config/prod.json"), {"dsn":"db.internal:6432","debug":False,"retry":5,"replica":"db2.internal"})
        self.assertEqual(settings.load("config/test.json"), {"dsn":"127.0.0.1:5433","debug":True,"retry":1,"replica":None})
    def _write(self, data):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(data, f); f.close(); self.addCleanup(os.unlink, f.name); return f.name
    def test_load_old(self):
        self.assertEqual(settings.load(self._write(OLD)), {"dsn":"h:1","debug":True,"retry":1,"replica":None})
    def test_unknown(self):
        with self.assertRaises(ValueError): settings.load(self._write({"version":3}))
`,
    },
    run: pyTest,
  },
  {
    id: 'hard-long-python-many-edits',
    category: 'hard-edit',
    language: 'py',
    files: { 'tables.py': longPython() },
    steps: [
      say(
        'tables.py is long. Make these changes: convert_17 must reject a negative amount with ValueError; convert_203 should use a default rate of 1.5; convert_390 must add 1000 instead of 390. Nothing else may change.',
      ),
    ],
    hidden: {
      'hidden_test.py': `import unittest, tables as t
class T(unittest.TestCase):
    def test_17(self):
        self.assertEqual(t.convert_17(1), 18)
        with self.assertRaises(ValueError): t.convert_17(-1)
    def test_203(self): self.assertEqual(t.convert_203(2), 206)
    def test_390(self): self.assertEqual(t.convert_390(1), 1001)
    def test_others(self):
        for i in (0, 16, 18, 202, 204, 389, 399): self.assertEqual(getattr(t, f"convert_{i}")(2), 2 + i)
`,
    },
    run: pyTest,
    check: ({ files }: Judged) => {
      const added =
        (files.get('tables.py') ?? '').split('\n').length - longPython().split('\n').length;
      return lacks(Math.abs(added) < 8, `file length changed by ${String(added)} lines`);
    },
  },
  {
    id: 'hard-review-conversation',
    category: 'hard-multi-turn',
    language: 'ts',
    files: {
      'src/index.ts': "export { RateLimiter } from './rate.ts';\n",
      'src/rate.ts': '',
    },
    steps: [
      say(
        'Implement class RateLimiter in src/rate.ts: new RateLimiter({ limit, windowMs, now }), with allow(key) returning true at most limit times per key in any sliding window of windowMs. now is () => number, defaulting to Date.now.',
      ),
      say(
        'Review comment: add remaining(key), the number of calls still allowed now. It must not count as a call.',
      ),
      say(
        'Review comment: memory grows for ever with many keys. Drop a key once nothing of it is left in its window, and add a keyCount getter so we can test that.',
      ),
      say(
        'Review comment: allow should take an optional cost: allow(key, cost = 1). A call whose cost does not fit is refused and uses nothing. A cost above the limit always fails.',
      ),
      say(
        'Last one: rename allow to take, keep behaviour, and update the export if it needs it. No alias for the old name.',
      ),
    ],
    hidden: {
      'hidden.test.ts': `${TS}import { RateLimiter } from './src/index.ts';
const make = (limit = 2, windowMs = 100) => { let t = 0; return { r: new RateLimiter({ limit, windowMs, now: () => t }), go: (d: number) => { t += d; } }; };
test('limit', () => { const {r} = make(); assert.equal(r.take('a'),true); assert.equal(r.take('a'),true); assert.equal(r.take('a'),false); assert.equal(r.take('b'),true); });
test('sliding', () => { const {r,go} = make(); r.take('a'); go(60); r.take('a'); go(41); assert.equal(r.take('a'),true); assert.equal(r.take('a'),false); });
test('remaining', () => { const {r} = make(); assert.equal(r.remaining('a'),2); r.take('a'); assert.equal(r.remaining('a'),1); assert.equal(r.remaining('a'),1); });
test('cost', () => { const {r} = make(3); assert.equal(r.take('a',2),true); assert.equal(r.take('a',2),false); assert.equal(r.remaining('a'),1); assert.equal(r.take('a',1),true); assert.equal(make(3).r.take('z',4),false); });
test('forgets keys', () => { const {r,go} = make(); r.take('a'); r.take('b'); assert.equal(r.keyCount,2); go(101); r.take('c'); assert.equal(r.keyCount,1); });
test('no alias', () => assert.equal((make().r as any).allow, undefined));
`,
    },
    run: nodeTest,
  },
];
