/**
 * `tsx .../run-long-dialog.ts --yes --out <file> --budget N [--runs N]`: the product's own
 * compaction on the real model (docs/History/M2/Evaluation/Stage8Compaction.md). A chat reads four long
 * documents, one per message, with a few facts told by the user and a few planted in the
 * documents; the compaction thresholds are lowered so that the context is compacted in the middle
 * of the dialog (the window is not made smaller, the thresholds are); then the user asks for the
 * facts. A line per run goes to `--out`: whether each fact came back, what was compacted, and the
 * cache hit of the requests (summary requests apart from the others). `--budget` caps the
 * provider requests of the whole run. The key comes from `DEEPSEEK_API_KEY` or the file named by
 * `MAO_ENV_FILE` and is never written down. It costs money, hence `--yes`.
 */
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import { openChat, textOf, until, type ChatRequest, type ScriptedChat } from '../chat-driver.js';

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
if (!argv.includes('--yes')) {
  process.stdout.write('The long dialog. Nothing was run. Add --yes --out <file> --budget N.\n');
  process.exit(0);
}
const out = option('--out');
const budget = Number(option('--budget') ?? '0');
const runs = Number(option('--runs') ?? '1');
if (out === undefined || !(budget > 0)) throw new Error('--out <file> and --budget N are required');
dotenv.config({ path: process.env['MAO_ENV_FILE'] ?? '.env', quiet: true });
if ((process.env['DEEPSEEK_API_KEY'] ?? '').trim() === '') {
  process.stderr.write('DEEPSEEK_API_KEY is not set\n');
  process.exit(2);
}

/** Filler that reads like documentation, so that a document is long without being empty. */
const filler = (topic: string, lines: number): string =>
  Array.from(
    { length: lines },
    (_, index) =>
      `- ${topic} note ${String(index + 1)}: the ${topic} module keeps its own queue, logs each step to the shared journal and hands the result to the next stage after validation.`,
  ).join('\n');

const DOCUMENTS: Record<string, string> = {
  'docs/queue.md': `# Queue\n\n${filler('queue', 40)}\n\nThe retry limit of the queue is 7 attempts.\n\n${filler('queue', 40)}\n`,
  'docs/cache.md': `# Cache\n\n${filler('cache', 40)}\n\nThe cache entries live for 900 seconds.\n\n${filler('cache', 40)}\n`,
  'docs/owners.md': `# Owners\n\n${filler('owner', 40)}\n\nThe on-call owner of the billing module is Marguerite Okafor.\n\n${filler('owner', 40)}\n`,
  'docs/flags.md': `# Flags\n\n${filler('flag', 40)}\n\nThe feature flag that guards the new exporter is named exporter_v3_guard.\n\n${filler('flag', 40)}\n`,
};

const MESSAGES = [
  'For this whole conversation: the project codename is AURORA-7731 and the staging port is 4821. Now read docs/queue.md and tell me in one sentence what the queue module does.',
  'Read docs/cache.md and tell me in one sentence what the cache module does.',
  'Read docs/owners.md and tell me in one sentence what it is about.',
  'Read docs/flags.md and tell me in one sentence what it is about.',
  'Without reading any file again, tell me: (1) the project codename, (2) the staging port, (3) the retry limit of the queue, (4) how long cache entries live, (5) who is the on-call owner of billing, (6) the name of the exporter feature flag. One line each.',
];

const FACTS: Record<string, RegExp> = {
  codename: /AURORA-7731/u,
  port: /4821/u,
  'retry limit': /\b7\b/u,
  'cache ttl': /900/u,
  owner: /Marguerite Okafor/u,
  flag: /exporter_v3_guard/u,
};

interface Counted {
  readonly kind: 'SUMMARY' | 'NORMAL';
  readonly input: number;
  readonly hit: number;
}

let requestsMade = 0;

async function runOne(run: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-s8-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-s8-repo-'));
  for (const [name, text] of Object.entries(DOCUMENTS)) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), text);
  }
  const requests: ChatRequest[] = [];
  const counted: Counted[] = [];
  const real = globalThis.fetch;
  const provider: ScriptedChat = {
    requests,
    add: () => undefined,
    fetch: async (input, init) => {
      if (requestsMade >= budget) throw new Error('the request budget of this run is spent');
      requestsMade += 1;
      const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ChatRequest;
      requests.push(request);
      const response = await real(input, init);
      const usage = (
        (await response
          .clone()
          .json()
          .catch(() => ({}))) as {
          usage?: { prompt_tokens?: number; prompt_cache_hit_tokens?: number };
        }
      ).usage;
      if (usage?.prompt_tokens !== undefined)
        counted.push({
          kind: request.messages.some((m) => textOf(m).includes('Use exactly these sections'))
            ? 'SUMMARY'
            : 'NORMAL',
          input: usage.prompt_tokens,
          hit: usage.prompt_cache_hit_tokens ?? 0,
        });
      return response;
    },
  };
  const chat = await openChat({
    dataDir,
    repository,
    provider,
    answer: () => 'y',
    credentials: { apiKeyFor: () => process.env['DEEPSEEK_API_KEY'] },
    // The window stays what it is; the thresholds are lowered so that the dialog compacts.
    configure: (config) => ({
      ...config,
      kernel: {
        ...config.kernel,
        compaction: {
          ...config.kernel.compaction,
          triggerRatio: 0.008,
          keepTokens: 4000,
          pruneMinBytes: 4000,
          idleEnabled: false,
        },
      },
    }),
  });
  const started = Date.now();
  let error: string | undefined;
  try {
    for (const message of MESSAGES) {
      const before = chat.printed('REPLY').length;
      await chat.console.submit(message);
      await until(() => chat.printed('REPLY').length > before, 'the reply', 300_000);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'unknown';
  }
  const answer = chat.printed('REPLY').at(-1) ?? '';
  const [id] = await readdir(join(dataDir, 'sessions')).catch(() => []);
  const log =
    id === undefined
      ? []
      : (await readFile(join(dataDir, 'sessions', id, 'workflow', 'log.v1.jsonl'), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { type: string; summaryInput?: { mode: string } });
  const audit =
    id === undefined
      ? []
      : (
          await readFile(join(dataDir, 'sessions', id, 'kernel-core', 'audit.jsonl'), 'utf8').catch(
            () => '',
          )
        )
          .split('\n')
          .filter((line) => /COMPACTION|reasonCode/u.test(line))
          .map((line) => line.slice(0, 300));
  const facts = Object.fromEntries(
    Object.entries(FACTS).map(([name, re]) => [name, re.test(answer)]),
  );
  const rate = (kind: Counted['kind']) => {
    const of = counted.filter((c) => c.kind === kind);
    const input = of.reduce((total, c) => total + c.input, 0);
    return input === 0 ? null : Math.round((1000 * of.reduce((t, c) => t + c.hit, 0)) / input) / 10;
  };
  const result = {
    run,
    ok:
      error === undefined &&
      Object.values(facts).every(Boolean) &&
      log.some((r) => r.type === 'CONTEXT_COMPACTED'),
    ...(error === undefined ? {} : { error }),
    facts,
    compacted: log.filter((r) => r.type === 'CONTEXT_COMPACTED').length,
    modes: log.filter((r) => r.type === 'CONTEXT_COMPACTED').map((r) => r.summaryInput?.mode),
    pruned: log.filter((r) => r.type === 'TOOL_RESULTS_PRUNED').length,
    requests: requests.length,
    summaryRequests: counted.filter((c) => c.kind === 'SUMMARY').length,
    cacheHitPercent: { summary: rate('SUMMARY'), normal: rate('NORMAL') },
    inputTokensMax: Math.max(0, ...counted.map((c) => c.input)),
    elapsedMs: Date.now() - started,
    ...(error === undefined ? {} : { audit: audit.slice(-12) }),
    errors: chat.printed('ERROR').map((text) => text.slice(0, 200)),
    answer: answer.slice(0, 600),
  };
  await chat.close().catch(() => undefined);
  if (result.ok) await rm(dataDir, { recursive: true, force: true });
  else process.stdout.write(`kept ${dataDir}\n`);
  await rm(repository, { recursive: true, force: true });
  return result;
}

await mkdir(dirname(out), { recursive: true });
const done = new Set(
  (await readFile(out, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => String((JSON.parse(line) as { run: number }).run)),
);
for (let run = 1; run <= runs; run += 1) {
  if (done.has(String(run))) continue;
  const result = await runOne(run).catch((error: unknown) => ({
    run,
    ok: false,
    error: error instanceof Error ? error.message : 'unknown',
  }));
  await appendFile(out, `${JSON.stringify(result)}\n`);
  process.stdout.write(`run ${String(run)} ${result.ok ? 'ok' : 'FAILED'}\n`);
}
process.exit(0);
