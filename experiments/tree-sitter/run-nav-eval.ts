// Experiment only: one arm of the navigation A/B. Read-only tasks on real code bases, judged
// against answers drawn from the compiler's AST.
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { openChat, until, type ScriptedChat } from '../chat-driver.js';

const RATES = { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 };
const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const armName = process.env['MAO_TS_ARM'] ?? 'regex';
const out = flag('--out') ?? '.';
const runs = Number(flag('--runs') ?? 2);
const [shard = 0, shards = 1] = (flag('--shard') ?? '0/1').split('/').map(Number);
const { tasks } = JSON.parse(await readFile(flag('--tasks') ?? '', 'utf8')) as { tasks: any[] };
const corpus: Record<string, string> = {
  ts: flag('--ts') ?? '',
  py: flag('--py') ?? '',
};
dotenv.config({ path: process.env['MAO_ENV_FILE'] ?? '.env', quiet: true });
await mkdir(out, { recursive: true });

function judge(task: any, reply: string): { ok: boolean; score: number; note: string } {
  const { answer } = task;
  if (answer.path !== undefined) {
    const hasPath = reply.includes(answer.path);
    const near = [...reply.matchAll(/\d+/gu)].some(
      (m) => Math.abs(Number(m[0]) - answer.line) <= 2,
    );
    return {
      ok: hasPath && near,
      score: hasPath && near ? 1 : 0,
      note: `${hasPath ? '' : 'path '}${near ? '' : 'line'}`,
    };
  }
  const wanted: readonly string[] = answer.paths ?? answer.names;
  const found = wanted.filter((w) => reply.includes(w));
  return {
    ok: found.length === wanted.length,
    score: found.length / wanted.length,
    note: `${String(found.length)}/${String(wanted.length)}`,
  };
}

const planned = tasks.flatMap((task) => Array.from({ length: runs }, (_, run) => ({ task, run })));
const mine = planned.filter((_, index) => index % shards === shard);
let spent = 0;
const done = new Set<string>();
for (const file of await readdir(out))
  if (file.startsWith(`nav.${armName}.`))
    for (const line of (await readFile(join(out, file), 'utf8')).split('\n'))
      if (line !== '') {
        const row = JSON.parse(line) as { id: string; run: number };
        done.add(`${row.id}#${String(row.run)}`);
      }
for (const { task, run } of mine) {
  if (spent > 4) break;
  if (done.has(`${String(task.id)}#${String(run)}`)) continue;
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-nav-'));
  const usage: { input: number; hit: number; output: number }[] = [];
  const called: string[] = [];
  const modes: string[] = [];
  const requests: ScriptedChat['requests'] = [];
  const real = globalThis.fetch;
  const provider: ScriptedChat = {
    requests,
    add: () => undefined,
    fetch: async (input, init) => {
      requests.push({} as never);
      const response = await real(input, init);
      try {
        const body = (await response.clone().json()) as any;
        usage.push({
          input: body.usage?.prompt_tokens ?? 0,
          hit: body.usage?.prompt_cache_hit_tokens ?? 0,
          output: body.usage?.completion_tokens ?? 0,
        });
        for (const call of body.choices?.[0]?.message?.tool_calls ?? []) {
          called.push(call.function?.name ?? '?');
          if (call.function?.name === 'search_repository')
            modes.push(JSON.parse(call.function.arguments ?? '{}').mode ?? 'AUTO');
        }
      } catch {
        // Not JSON: the Executor reports it.
      }
      return response;
    },
  };
  const started = Date.now();
  let failure = '';
  const chat = await openChat({
    dataDir,
    repository: corpus[task.repo] ?? '',
    provider,
    answer: () => 'y',
    credentials: { apiKeyFor: () => process.env['DEEPSEEK_API_KEY'] },
  });
  try {
    await chat.console.submit(task.prompt);
    await until(() => requests.length > 0, 'the first request', 300_000);
    await until(() => chat.lives.at(-1)?.status.includes('等待输入') === true, 'the end', 300_000);
  } catch (error) {
    failure = error instanceof Error ? error.message : 'unknown';
  }
  const reply = chat.printed('REPLY').join('\n');
  await chat.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
  const verdict = failure === '' ? judge(task, reply) : { ok: false, score: 0, note: failure };
  const input = usage.reduce((s, u) => s + u.input, 0);
  const hit = usage.reduce((s, u) => s + u.hit, 0);
  const output = usage.reduce((s, u) => s + u.output, 0);
  const cost =
    ((input - hit) * RATES.cacheMiss + hit * RATES.cacheHit + output * RATES.output) / 1e6;
  spent += cost;
  const counts = (list: readonly string[]) =>
    list.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
  await appendFile(
    join(out, `nav.${armName}.${String(shard)}.jsonl`),
    `${JSON.stringify({ arm: armName, id: task.id, group: task.group, run, ...verdict, requests: usage.length, input, hit, output, cost, ms: Date.now() - started, tools: counts(called), modes: counts(modes), reply: reply.slice(0, 400) })}\n`,
  );
  process.stdout.write(
    `${armName} ${verdict.ok ? 'PASS' : 'FAIL'} ${String(task.id)}#${String(run)} ${verdict.note}\n`,
  );
}
process.exit(0);
