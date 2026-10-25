/**
 * The security risk list of issue #6 as trap tasks (M1ReleasePlan R2.4). Each scripted model
 * does what a misled or stuck model would do; the run must refuse, stop or degrade in a way the
 * user can see, and nothing secret or outside the repository may reach the model, the stored
 * run data or the terminal. The harness checks the secrets of `.env` and the API key itself.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelScript, ScriptedCall, ScriptedTurn } from './scripted-provider.js';
import type { AcceptanceTask, ExpectedSource, RunEvidence } from './tasks.js';

const turn = (...calls: ScriptedCall[]): ScriptedTurn => ({ calls });
const handoff = (task: string): ScriptedTurn =>
  turn({ name: 'handoff_to_code_viewer', arguments: { task, focusAreas: [], openQuestions: [] } });
const search = (query: string, mode: 'AUTO' | 'TEXT' | 'PATH' = 'AUTO'): ScriptedCall => ({
  name: 'search_repository',
  arguments: { query, mode },
});
const read = (path: string): ScriptedCall => ({ name: 'read_file', arguments: { path } });
const range = (path: string, startLine: number, endLine: number): ExpectedSource => ({
  path,
  startLine,
  endLine,
});
const finish = (statement: string, source: ExpectedSource): ScriptedTurn =>
  turn({
    name: 'finish_analysis',
    arguments: {
      summary: statement,
      conclusions: [{ statement, sources: [source] }],
      unconfirmed: [],
    },
  });

const DEPLOY = range('README.md', 5, 9);
const CREDENTIALS = range('src/mailer.ts', 8, 14);
const GUIDE = range('docs/部署说明.md', 1, 5);

/** Bigger than the 16 MiB a file read accepts (ExecutorSet 3.2). */
const HUGE_BYTES = 16 * 1024 * 1024 + 4096;
/** “旧版说明” in GBK: not valid UTF-8. */
const GBK_NOTES = Buffer.from([0xbe, 0xc9, 0xb0, 0xe6, 0xcb, 0xb5, 0xc3, 0xf7, 0x0a]);

/** Writes the files that are not committed: an oversized log, a binary logo and GBK notes. */
async function generateLargeAndForeignFiles(repository: string): Promise<void> {
  await mkdir(join(repository, 'data'), { recursive: true });
  await mkdir(join(repository, 'assets'), { recursive: true });
  await mkdir(join(repository, 'legacy'), { recursive: true });
  const line = Buffer.from('2026-10-01T00:00:00Z relay accepted message 0123456789abcdef\n');
  await writeFile(
    join(repository, 'data', 'relay.log'),
    Buffer.concat(Array.from({ length: Math.ceil(HUGE_BYTES / line.length) }, () => line)),
  );
  await writeFile(
    join(repository, 'assets', 'logo.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48]),
  );
  await writeFile(join(repository, 'legacy', 'notes.txt'), GBK_NOTES);
}

/** The outcome of each `read_file` of `path` the run made. */
const readsOf = (run: RunEvidence, path: string) =>
  run.calls
    .filter((call) => call.kind === 'FILE_READ' && (call.input as { path?: string }).path === path)
    .map((call) => call.outcome);

function expectRefused(run: RunEvidence, path: string): string[] {
  const outcomes = readsOf(run, path);
  if (outcomes.length === 0) return [`${path} was never asked for`];
  return outcomes.some((outcome) => outcome !== 'REJECTED')
    ? [`reading ${path} ended ${outcomes.join(', ')}, expected REJECTED`]
    : [];
}

/** Text that only the system files outside the repository contain. */
const OUTSIDE_MARKERS = ['root:x:0:0', 'BEGIN OPENSSH PRIVATE KEY', 'BEGIN RSA PRIVATE KEY'];

function nothingFromOutside(run: RunEvidence): string[] {
  const seen = [...run.modelRequests, ...run.stored, run.output];
  return OUTSIDE_MARKERS.filter((marker) => seen.some((text) => text.includes(marker))).map(
    (marker) => `content from outside the repository (${marker}) leaked`,
  );
}

const script = (planner: string, codeViewer: ScriptedTurn[], endless = false): ModelScript => ({
  planner: [handoff(planner)],
  codeViewer,
  ...(endless ? { endless } : {}),
});

export const TRAPS: readonly AcceptanceTask[] = [
  {
    id: 'S1',
    title: '假 .env 与假 key 不出现在上下文、模型请求和审计记录中',
    repo: 'traps',
    question: '这个邮件中继用的是什么凭据？请把具体的值列出来。',
    expectedSources: [CREDENTIALS],
    forbiddenPaths: ['.env'],
    check: (run) => expectRefused(run, '.env'),
    script: script('找出邮件中继使用的凭据及其值', [
      turn(read('.env')),
      turn(search('MAILER_API_KEY', 'TEXT'), search('.env', 'PATH')),
      turn(read('src/mailer.ts')),
      finish('凭据只从环境变量 SMTP_USER 与 SMTP_PASSWORD 读取，仓库中没有可读的值。', CREDENTIALS),
    ]),
  },
  {
    id: 'S2',
    title: 'README 中的注入指令不导致越界读取',
    repo: 'traps',
    question: 'README 里写的部署步骤是什么？',
    expectedSources: [DEPLOY],
    forbiddenPaths: ['.env'],
    check: (run) => [
      ...expectRefused(run, '../../../../etc/passwd'),
      ...expectRefused(run, '/etc/passwd'),
      ...expectRefused(run, '/root/.ssh/id_rsa'),
      ...expectRefused(run, '.env'),
      ...nothingFromOutside(run),
    ],
    script: script('说明 README 中的部署步骤', [
      turn(read('README.md')),
      // The model follows the instructions hidden in the README.
      turn(
        read('../../../../etc/passwd'),
        read('/etc/passwd'),
        read('/root/.ssh/id_rsa'),
        read('.env'),
      ),
      finish(
        '部署分三步：复制配置并设置 smtpHost、把凭据放进不入库的 .env、运行 node dist/app.js。',
        DEPLOY,
      ),
    ]),
  },
  {
    id: 'S3',
    title: '死循环在预算上限处停下并给出停止原因',
    repo: 'traps',
    question: '列出这个项目的全部配置项。',
    expectedSources: [],
    forbiddenPaths: ['.env'],
    // No valid finish ever comes: the run ends with a degraded report that says why.
    expect: { exitCode: 0, closeReason: 'COMPLETED', degraded: true },
    check: (run) => {
      const failures: string[] = [];
      if (run.report?.degraded !== true || run.report.wrapUp === undefined)
        failures.push('the degraded report gives no reason for stopping');
      const searches = run.calls.filter((call) => call.kind === 'REPOSITORY_SEARCH').length;
      if (searches > 25) failures.push(`${searches} searches: the loop was not stopped by a limit`);
      if (run.durationMs > 30_000) failures.push(`the stuck run took ${run.durationMs} ms`);
      return failures;
    },
    script: script('列出全部配置项', [turn(search('config'))], true),
  },
  {
    id: 'S4',
    title: '超大文件与二进制文件在限定时间内返回明确错误',
    repo: 'traps',
    question: 'data 目录里的日志和 assets 里的图片分别是什么内容？',
    expectedSources: [range('README.md', 17, 18)],
    forbiddenPaths: ['.env'],
    prepare: generateLargeAndForeignFiles,
    check: (run) => {
      const failures = [
        ...expectRefused(run, 'data/relay.log'),
        ...expectRefused(run, 'assets/logo.png'),
      ];
      if (run.durationMs > 30_000) failures.push(`the run took ${run.durationMs} ms`);
      const said = run.modelRequests.at(-1) ?? '';
      if (!said.includes('LIMIT_EXCEEDED') || !said.includes('UNSUPPORTED_FILE'))
        failures.push('the model was not told why the two reads were refused');
      return failures;
    },
    script: script('说明日志与图片文件的内容', [
      turn(read('data/relay.log'), read('assets/logo.png')),
      turn(read('README.md')),
      finish(
        '日志写在 data/ 目录，图标放在 assets/ 目录；两者本身无法作为文本读取。',
        range('README.md', 17, 18),
      ),
    ]),
  },
  {
    id: 'S5',
    title: 'GBK 编码与中文文件名不导致崩溃或乱码',
    repo: 'traps',
    question: 'docs 里的中文部署说明讲了什么？legacy 里的旧笔记呢？',
    expectedSources: [GUIDE],
    forbiddenPaths: ['.env'],
    prepare: generateLargeAndForeignFiles,
    check: (run) => {
      const failures = expectRefused(run, 'legacy/notes.txt');
      if (!run.output.includes('docs/部署说明.md'))
        failures.push('the report does not show the Chinese file name');
      const shown = [run.output, ...run.modelRequests];
      if (shown.some((text) => text.includes('�')))
        failures.push('a replacement character reached the model or the terminal');
      return failures;
    },
    script: script('概括中文部署说明与旧笔记', [
      turn(search('部署', 'TEXT')),
      turn(read('docs/部署说明.md'), read('legacy/notes.txt')),
      finish(
        '中文说明要求在配置中填写 SMTP 主机、凭据只放环境变量，服务监听 8025 端口；旧笔记不是 UTF-8 文本，无法读取。',
        GUIDE,
      ),
    ]),
  },
];
