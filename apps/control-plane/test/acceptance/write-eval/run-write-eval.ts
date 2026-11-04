/**
 * `tsx .../run-write-eval.ts [--yes] [--runs N] [--tasks a,b] [--shard i/n] [--out DIR] [--budget USD]`:
 * runs the write tasks on the real model and judges the result by running it. Every chat appends
 * one line to `<out>/records.<shard>.jsonl`: the verdict, every provider usage, what the tools
 * refused. A failed chat also keeps its files and log for diagnosis. It costs money, so it starts
 * only with `--yes`. The key comes from `DEEPSEEK_API_KEY` or the file named by `MAO_ENV_FILE`, and
 * is never printed or written.
 */
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import dotenv from 'dotenv';
import { openChat, until, type Chat, type ScriptedChat } from '../chat-driver.js';
import { HARD_TASKS, REAL_TASKS } from './tasks-hard.js';
import { WRITE_TASKS, type Judged, type WriteTask } from './tasks.js';

/** The list prices in USD per million tokens, off-peak (`deepseek-flash` definition). */
const RATES = { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 };
const TURN_TIMEOUT_MS = 8 * 60_000;
const AWAITING = '等待输入';

const ALL_TASKS = [...WRITE_TASKS, ...HARD_TASKS, ...REAL_TASKS];

interface Usage {
  input: number;
  cacheHit: number;
  output: number;
  reasoning: number;
}

interface Options {
  readonly yes: boolean;
  readonly runs: number;
  readonly tasks: readonly WriteTask[];
  readonly shard: readonly [number, number];
  readonly out: string;
  readonly budgetUsd: number;
}

function parse(argv: readonly string[]): Options {
  const value = (flag: string) => {
    const at = argv.indexOf(flag);
    return at < 0 ? undefined : argv[at + 1];
  };
  const only = value('--tasks')?.split(',');
  const [i = 0, n = 1] = (value('--shard') ?? '0/1').split('/').map(Number);
  return {
    yes: argv.includes('--yes'),
    runs: Number(value('--runs') ?? 1),
    tasks: only === undefined ? ALL_TASKS : ALL_TASKS.filter((t) => only.includes(t.id)),
    shard: [i, n],
    out: value('--out') ?? join('.multiagentos', 'write-eval', 'latest'),
    budgetUsd: Number(value('--budget') ?? 10),
  };
}

const costOf = (usage: readonly Usage[]): number =>
  usage.reduce(
    (sum, u) =>
      sum +
      ((u.input - u.cacheHit) * RATES.cacheMiss +
        u.cacheHit * RATES.cacheHit +
        u.output * RATES.output) /
        1_000_000,
    0,
  );

/** The real provider, keeping usage and the tools each reply called; bodies stay in memory. */
function meteredProvider(usage: Usage[], called: string[], modes: string[]): ScriptedChat {
  const requests: ScriptedChat['requests'] = [];
  const real = globalThis.fetch;
  return {
    requests,
    add: () => undefined,
    fetch: async (input, init) => {
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as never);
      const response = await real(input, init);
      try {
        const body = (await response.clone().json()) as {
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_cache_hit_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
          };
          choices?: {
            message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] };
          }[];
        };
        usage.push({
          input: body.usage?.prompt_tokens ?? 0,
          cacheHit: body.usage?.prompt_cache_hit_tokens ?? 0,
          output: body.usage?.completion_tokens ?? 0,
          reasoning: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        });
        for (const call of body.choices?.[0]?.message?.tool_calls ?? []) {
          called.push(call.function?.name ?? '?');
          if (call.function?.name === 'search_repository') {
            const args = JSON.parse(call.function.arguments ?? '{}') as { mode?: string };
            modes.push(args.mode ?? 'AUTO');
          }
        }
      } catch {
        // A body that is no JSON is the model-call Executor's to report.
      }
      return response;
    },
  };
}

async function allFiles(root: string, under = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(under, { withFileTypes: true })) {
    const path = join(under, entry.name);
    if (entry.isDirectory()) found.push(...(await allFiles(root, path)));
    else if (entry.isFile()) found.push(relative(root, path).split(sep).join('/'));
  }
  return found;
}

async function write(root: string, files: WriteTask['files']): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
}

const statusOf = (chat: Chat) => chat.lives.at(-1)?.status ?? '';

/** Sends a message and waits until the Turn it opened has ended, whatever it ended with. */
async function sayAndWait(chat: Chat, provider: ScriptedChat, text: string): Promise<void> {
  const before = provider.requests.length;
  await chat.console.submit(text);
  await until(() => provider.requests.length > before, 'the first request', TURN_TIMEOUT_MS);
  await until(() => statusOf(chat).includes(AWAITING), 'the end of the Turn', TURN_TIMEOUT_MS);
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

async function runTask(task: WriteTask, runIndex: number, options: Options): Promise<object> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-eval-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-eval-repo-'));
  await write(repository, task.files);
  if (task.realRepository === true) {
    const quiet = { cwd: repository, encoding: 'utf8', timeout: 300_000 } as const;
    spawnSync('git', ['clone', '-q', process.cwd(), '.'], quiet);
    spawnSync('pnpm', ['install', '--offline', '--frozen-lockfile'], quiet);
  }
  const usage: Usage[] = [];
  const called: string[] = [];
  const modes: string[] = [];
  const provider = meteredProvider(usage, called, modes);
  const started = Date.now();
  const failures: string[] = [];
  const replies: string[] = [];
  let questions: readonly string[];
  let log = '';
  const original = new Map(
    Object.entries(task.files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]),
  );
  const answer = (question: string) => {
    for (const [key, value] of Object.entries(task.answers ?? {}))
      if (question.includes(key)) return value;
    return 'y' as const;
  };
  const chat = await openChat({
    dataDir,
    repository,
    provider,
    answer,
    credentials: { apiKeyFor: () => process.env['DEEPSEEK_API_KEY'] },
  });
  try {
    for (const step of task.steps) {
      if ('say' in step) await sayAndWait(chat, provider, step.say);
      else if ('edit' in step) await write(repository, step.edit);
      else {
        const noticed = chat.printed('NOTICE').length;
        await chat.console.submit(step.undo === 'ALL' ? '/undo all' : '/undo');
        await until(
          () => chat.printed('NOTICE').length > noticed,
          'the answer to the undo',
          60_000,
        );
      }
    }
  } catch (error) {
    failures.push(`did not finish: ${error instanceof Error ? error.message : 'unknown'}`);
  } finally {
    replies.push(...chat.printed('REPLY'));
    questions = [...chat.questions];
    await chat.close().catch(() => undefined);
  }
  const [sessionId] = await readdir(join(dataDir, 'sessions')).catch(() => [] as string[]);
  if (sessionId !== undefined)
    log = await readFile(
      join(dataDir, 'sessions', sessionId, 'workflow', 'log.v1.jsonl'),
      'utf8',
    ).catch(() => '');

  // A real repository is judged by what git says changed; its node_modules are no business here.
  const paths =
    task.realRepository === true
      ? spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: repository, encoding: 'utf8' })
          .stdout.split('\n')
          .filter((line) => line !== '')
          .map((line) => line.slice(3))
      : await allFiles(repository);
  const bytes = new Map<string, Buffer>();
  for (const path of paths) {
    const content = await readFile(join(repository, path)).catch(() => undefined);
    if (content !== undefined) bytes.set(path, content);
  }
  const changed = paths.filter(
    (path) => !original.get(path)?.equals(bytes.get(path) ?? Buffer.alloc(0)),
  );
  const judged: Judged = {
    files: new Map([...bytes].map(([k, v]) => [k, v.toString('utf8')])),
    bytes,
    replies,
    changed,
  };
  failures.push(...(task.check?.(judged) ?? []));

  await write(repository, task.hidden ?? {});
  const commands = [...(task.run === undefined ? [] : [task.run]), ...(task.runs ?? [])];
  const testOutput: string[] = [];
  for (const [command, ...args] of commands) {
    const result = spawnSync(command ?? 'false', args, {
      cwd: repository,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 1 << 28,
    });
    if (result.status !== 0) {
      failures.push(`${[command, ...args].join(' ')} failed`);
      testOutput.push(`${result.stdout}\n${result.stderr}`.slice(-3000));
    }
  }

  const records = log
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { type?: string; reasonCode?: string; code?: string });
  const totals = usage.reduce(
    (t, u) => ({
      input: t.input + u.input,
      cacheHit: t.cacheHit + u.cacheHit,
      output: t.output + u.output,
      reasoning: t.reasoning + u.reasoning,
    }),
    { input: 0, cacheHit: 0, output: 0, reasoning: 0 },
  );
  const record = {
    id: task.id,
    category: task.category,
    language: task.language,
    run: runIndex,
    ok: failures.length === 0,
    failures,
    ms: Date.now() - started,
    requests: usage.length,
    ...totals,
    cacheRate: totals.input === 0 ? 0 : totals.cacheHit / totals.input,
    /** The first request of a chat cannot hit; this is what the rest achieved. */
    cacheRateAfterFirst:
      usage.length < 2
        ? 0
        : usage.slice(1).reduce((s, u) => s + u.cacheHit, 0) /
          Math.max(
            1,
            usage.slice(1).reduce((s, u) => s + u.input, 0),
          ),
    costUsd: costOf(usage),
    tools: countBy(called),
    searchModes: countBy(modes),
    refusals: countBy(records.flatMap((r) => (r.reasonCode === undefined ? [] : [r.reasonCode]))),
    feedback: countBy(
      records.flatMap((r) => (r.type === 'FEEDBACK' && r.code !== undefined ? [r.code] : [])),
    ),
    questions: questions.length,
    changed,
  };
  if (failures.length > 0) {
    const keep = join(options.out, 'failed', `${task.id}.${String(runIndex)}`);
    await mkdir(keep, { recursive: true });
    if (task.realRepository === true)
      await writeFile(
        join(keep, 'changes.diff'),
        spawnSync('git', ['diff', 'HEAD'], {
          cwd: repository,
          encoding: 'utf8',
          maxBuffer: 1 << 28,
        }).stdout,
      );
    else await cp(repository, join(keep, 'repository'), { recursive: true });
    await writeFile(join(keep, 'log.jsonl'), log);
    await writeFile(join(keep, 'replies.txt'), replies.join('\n---\n'));
    await writeFile(join(keep, 'tests.txt'), testOutput.join('\n---\n'));
  }
  await rm(dataDir, { recursive: true, force: true });
  await rm(repository, { recursive: true, force: true });
  return record;
}

const options = parse(process.argv.slice(2));

/**
 * `--baseline`: judges every task on its untouched repository, with no model. A task that passes
 * here cannot tell a right answer from doing nothing, unless doing nothing is the right answer.
 */
if (process.argv.includes('--baseline')) {
  for (const task of options.tasks.filter((t) => t.realRepository !== true)) {
    const repository = await mkdtemp(join(tmpdir(), 'mas-eval-base-'));
    await write(repository, task.files);
    const paths = await allFiles(repository);
    const bytes = new Map<string, Buffer>();
    for (const path of paths) bytes.set(path, await readFile(join(repository, path)));
    const problems = [
      ...(task.check?.({
        files: new Map([...bytes].map(([k, v]) => [k, v.toString('utf8')])),
        bytes,
        replies: [],
        changed: [],
      }) ?? []),
    ];
    await write(repository, task.hidden ?? {});
    for (const [command, ...args] of [
      ...(task.run === undefined ? [] : [task.run]),
      ...(task.runs ?? []),
    ]) {
      const result = spawnSync(command ?? 'false', args, {
        cwd: repository,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (result.status !== 0) problems.push(`${String(command)} failed`);
    }
    process.stdout.write(
      `${problems.length === 0 ? 'VACUOUS' : 'catches'} ${task.id} (${String(problems.length)})\n`,
    );
    await rm(repository, { recursive: true, force: true });
  }
  process.exit(0);
}
const planned = options.tasks.flatMap((task) =>
  Array.from({ length: options.runs }, (_, run) => ({ task, run })),
);
const mine = planned.filter((_, index) => index % options.shard[1] === options.shard[0]);
process.stdout.write(
  `${String(planned.length)} chats in all (${String(options.tasks.length)} tasks x ${String(options.runs)}), ${String(mine.length)} in this shard; stops above ${String(options.budgetUsd)} USD per shard.\n`,
);
if (!options.yes) {
  process.stdout.write('Nothing was run. Add --yes.\n');
  process.exit(0);
}
dotenv.config({ path: process.env['MAO_ENV_FILE'] ?? '.env', quiet: true });
if ((process.env['DEEPSEEK_API_KEY'] ?? '').trim() === '') {
  process.stderr.write('DEEPSEEK_API_KEY is not set\n');
  process.exit(2);
}
await mkdir(options.out, { recursive: true });
let spent = 0;
for (const { task, run } of mine) {
  if (spent > options.budgetUsd) {
    process.stdout.write(`budget reached at ${spent.toFixed(3)} USD; stopping\n`);
    break;
  }
  const record = (await runTask(task, run, options).catch((error: unknown) => ({
    id: task.id,
    run,
    ok: false,
    failures: [`harness: ${error instanceof Error ? error.message : 'unknown'}`],
    costUsd: 0,
  }))) as { id: string; ok: boolean; costUsd: number; failures: string[] };
  spent += record.costUsd;
  await appendFile(
    join(options.out, `records.${String(options.shard[0])}.jsonl`),
    `${JSON.stringify(record)}\n`,
  );
  process.stdout.write(
    `${record.ok ? 'PASS' : 'FAIL'} ${record.id}#${String(run)} $${record.costUsd.toFixed(4)} ${record.failures.join('; ').slice(0, 200)}\n`,
  );
}
process.stdout.write(`shard spent ${spent.toFixed(4)} USD\n`);
process.exit(0);
