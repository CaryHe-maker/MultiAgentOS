/**
 * `tsx .../run-suite.ts --yes --out <file> [--runs N] [--modes natural,hint,alone] [case ids...]`:
 * the stage 4 suite on the real model (docs/M2/Evaluation/Stage4SubAgents.md). Each run is one
 * case in one mode; a line of facts is appended to `--out`, and a run already in the file is
 * skipped, so a batch killed at its time limit can be started again. The key comes from
 * `DEEPSEEK_API_KEY` or the file named by `MAO_ENV_FILE`. It costs money, hence `--yes`.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import {
  agentOfRequest,
  openChat,
  textOf,
  until,
  type ChatRequest,
  type ScriptedChat,
} from '../chat-driver.js';
import { CASES as SMALL, type CaseDef } from './fixtures.js';
import { LARGE } from './large.js';

const CASES: readonly CaseDef[] = [...SMALL, ...LARGE];

type Mode = 'natural' | 'hint' | 'explicit' | 'alone';
const SUFFIX: Readonly<Record<Mode, string>> = {
  natural: '',
  hint: ' You may use subagents if that helps.',
  explicit:
    ' Split the work into subtasks and run them with run_subagents; where one part needs the result of another, make it depend on that part.',
  alone: ' Do the work yourself; do not use run_subagents.',
};

interface Stamp {
  readonly at: number;
  readonly request: ChatRequest;
}

function recordingProvider(): ScriptedChat & { readonly stamps: Stamp[] } {
  const requests: ChatRequest[] = [];
  const stamps: Stamp[] = [];
  const real = globalThis.fetch;
  return {
    requests,
    stamps,
    add: () => undefined,
    fetch: async (input, init) => {
      const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ChatRequest;
      requests.push(request);
      stamps.push({ at: Date.now(), request });
      return real(input, init);
    },
  };
}

interface SpawnedTask {
  readonly name: string;
  readonly agent: string;
  readonly dependsOn: readonly string[];
  readonly writeScope: readonly string[];
}

/** What the model asked for in its run_subagents calls, once each. */
function spawnedTasks(provider: ScriptedChat): { calls: number; tasks: SpawnedTask[] } {
  const seen = new Set<string>();
  const tasks: SpawnedTask[] = [];
  let calls = 0;
  for (const request of provider.requests)
    for (const message of request.messages)
      for (const call of (message.tool_calls ?? []) as unknown as {
        id?: string;
        function: { name: string; arguments?: string };
      }[]) {
        if (call.function.name !== 'run_subagents' || call.id === undefined || seen.has(call.id))
          continue;
        seen.add(call.id);
        calls += 1;
        try {
          const args = JSON.parse(call.function.arguments ?? '{}') as {
            tasks?: {
              name: string;
              agent: string;
              dependsOn?: string[];
              writeScope?: string[];
            }[];
          };
          for (const task of args.tasks ?? [])
            tasks.push({
              name: task.name,
              agent: task.agent,
              dependsOn: task.dependsOn ?? [],
              writeScope: task.writeScope ?? [],
            });
        } catch {
          // A call whose arguments do not parse is a refusal the model reads; it has no tasks.
        }
      }
  return { calls, tasks };
}

/** The most tasks whose model requests overlap in time: the parallelism that really happened. */
function maxParallel(stamps: readonly Stamp[], names: readonly string[]): number {
  const span = new Map<string, { from: number; to: number }>();
  for (const { at, request } of stamps) {
    if (agentOfRequest(request) === 'main') continue;
    const first = textOf(request.messages.find((message) => message.role === 'user'));
    const name = names.find((each) => first.includes(`Your task (${each},`));
    if (name === undefined) continue;
    const known = span.get(name);
    span.set(name, { from: known?.from ?? at, to: at });
  }
  let best = 0;
  for (const { from } of span.values())
    best = Math.max(
      best,
      [...span.values()].filter((other) => other.from <= from && from <= other.to).length,
    );
  return best;
}

const statusesOf = (provider: ScriptedChat): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const request of provider.requests)
    for (const message of request.messages)
      for (const match of textOf(message).matchAll(/Result of task (\S+) \(\w+\): (\w+)/gu))
        if (match[1] !== undefined && match[2] !== undefined) found[match[1]] = match[2];
  return found;
};

const refusalsOf = (provider: ScriptedChat): string[] => [
  ...new Set(
    provider.requests.flatMap((request) =>
      request.messages
        .filter((message) => message.role === 'tool')
        .map((message) => textOf(message))
        .filter(
          (text) => text.includes('Nothing was started') || text.includes('no longer available'),
        )
        .map((text) => text.split('\n')[0]?.slice(0, 120) ?? ''),
    ),
  ),
];

async function runOne(def: CaseDef, mode: Mode, run: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-suite-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-suite-repo-'));
  for (const [name, content] of Object.entries(def.files)) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  const provider = recordingProvider();
  const chat = await openChat({
    dataDir,
    repository,
    provider,
    // Everything the user is asked is allowed, as a user who wants the work done would.
    answer: () => 'y',
    credentials: { apiKeyFor: () => process.env['DEEPSEEK_API_KEY'] },
  });
  const started = Date.now();
  let error: string | undefined;
  try {
    await chat.console.submit(`${def.prompt}${SUFFIX[mode]}`);
    await until(() => chat.printed('REPLY').length > 0, 'the reply', 420_000);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'unknown';
  }
  const elapsedMs = Date.now() - started;
  const spawned = spawnedTasks(provider);
  const names = spawned.tasks.map((task) => task.name);
  const checks = await def
    .check(repository, chat.printed('REPLY'))
    .catch(() => ({ 'check failed to run': false }));
  const result = {
    case: def.id,
    mode,
    run,
    invites: def.invites,
    ok: error === undefined && Object.values(checks).every(Boolean),
    ...(error === undefined ? {} : { error }),
    checks,
    elapsedMs,
    requests: provider.requests.length,
    spawned: spawned.calls > 0,
    spawnCalls: spawned.calls,
    tasks: spawned.tasks,
    usedDependsOn: spawned.tasks.some((task) => task.dependsOn.length > 0),
    maxParallel: maxParallel(provider.stamps, names),
    statuses: statusesOf(provider),
    refusals: refusalsOf(provider),
    questions: chat.questions.length,
  };
  await chat.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
  await rm(repository, { recursive: true, force: true });
  return result;
}

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
if (!argv.includes('--yes')) {
  process.stdout.write(`${String(CASES.length)} cases. Nothing was run. Add --yes.\n`);
  process.exit(0);
}
const out = option('--out');
if (out === undefined) throw new Error('--out <file> is required');
const runs = Number(option('--runs') ?? '1');
const modes = (option('--modes') ?? 'natural').split(',') as Mode[];
const flagValues = new Set(['--out', '--runs', '--modes']);
const wanted = argv.filter(
  (arg, index) => !arg.startsWith('--') && !flagValues.has(argv[index - 1] ?? ''),
);
dotenv.config({ path: process.env['MAO_ENV_FILE'] ?? '.env', quiet: true });
if ((process.env['DEEPSEEK_API_KEY'] ?? '').trim() === '') {
  process.stderr.write('DEEPSEEK_API_KEY is not set\n');
  process.exit(2);
}
await mkdir(dirname(out), { recursive: true });
const done = new Set(
  (await readFile(out, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const r = JSON.parse(line) as { case: string; mode: string; run: number };
      return `${r.case}|${r.mode}|${String(r.run)}`;
    }),
);
for (const def of CASES.filter((each) => wanted.length === 0 || wanted.includes(each.id)))
  for (const mode of modes)
    for (let run = 1; run <= runs; run += 1) {
      if (done.has(`${def.id}|${mode}|${String(run)}`)) continue;
      const result = await runOne(def, mode, run).catch((error: unknown) => ({
        case: def.id,
        mode,
        run,
        ok: false,
        error: error instanceof Error ? error.message : 'unknown',
      }));
      await appendFile(out, `${JSON.stringify(result)}\n`);
      process.stdout.write(`${def.id} ${mode} #${String(run)} ${result.ok ? 'ok' : 'FAILED'}\n`);
    }
