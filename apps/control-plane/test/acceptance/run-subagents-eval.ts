/**
 * `tsx apps/control-plane/test/acceptance/run-subagents-eval.ts [--yes] [case ids...]`: stage 4's
 * checks on the real model (M2Plan 6.5, exit D), which the scripted cases cannot give: does main
 * spawn SubAgents for work that is independent, do they stay in their scopes and finish with a
 * result, and what does it cost in time and requests next to the same work done by main alone.
 * It costs money, so it starts only with `--yes`. The key comes from `DEEPSEEK_API_KEY`, or from
 * the file named by `MAO_ENV_FILE` (default `.env`). Only structured facts are printed.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import { openChat, type ChatRequest, type ScriptedChat } from './chat-driver.js';

const FILES: Readonly<Record<string, string>> = {
  'README.md': '# shop\n\nA small shop library with three independent modules.\n',
  'src/cart.ts':
    'export function addItem(cart: string[], item: string): string[] {\n  if (item === "") throw new Error("empty item");\n  return [...cart, item];\n}\n',
  'src/prices.ts':
    'export function total(prices: number[]): number {\n  return prices.reduce((sum, price) => sum + Math.max(0, price), 0);\n}\n',
  'src/users.ts':
    'export function isValidEmail(email: string): boolean {\n  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/u.test(email);\n}\n',
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

interface Result {
  readonly id: string;
  readonly ok: boolean;
  readonly facts: Readonly<Record<string, unknown>>;
}

function realProvider(): ScriptedChat {
  const requests: ChatRequest[] = [];
  const real = globalThis.fetch;
  return {
    requests,
    add: () => undefined,
    fetch: async (input, init) => {
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ChatRequest);
      return real(input, init);
    },
  };
}

/** Everything the model was asked and answered, across all Agents, as the tool calls it made. */
const callsOf = (provider: ScriptedChat): string[] => {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const request of provider.requests)
    for (const message of request.messages)
      for (const call of message.tool_calls ?? [])
        if (call.id !== undefined && !seen.has(call.id)) {
          seen.add(call.id);
          names.push(call.function.name);
        }
  return names;
};

async function withChat(
  id: string,
  message: string,
  judge: (context: {
    readonly repository: string;
    readonly replies: readonly string[];
    readonly calls: readonly string[];
    readonly agents: readonly string[];
  }) => Promise<Readonly<Record<string, unknown>> & { readonly ok: boolean }>,
): Promise<Result> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-sub-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-sub-repo-'));
  for (const [name, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  const provider = realProvider();
  const chat = await openChat({
    dataDir,
    repository,
    provider,
    credentials: { apiKeyFor: () => process.env['DEEPSEEK_API_KEY'] },
  });
  const started = Date.now();
  try {
    await chat.say(message);
    const elapsedMs = Date.now() - started;
    const calls = callsOf(provider);
    const agents = [
      ...new Set(
        chat.lives.flatMap((live) => live.activity.map((line) => line.label.split(' ')[0] ?? '')),
      ),
    ];
    const { ok, ...facts } = await judge({
      repository,
      replies: chat.printed('REPLY'),
      calls,
      agents,
    });
    return {
      id,
      ok,
      facts: {
        ...facts,
        elapsedMs,
        requests: provider.requests.length,
        spawnCalls: calls.filter((name) => name === 'run_subagents').length,
        finished: calls.filter((name) => name === 'finish_subagent').length,
        agents,
        questions: chat.questions.length,
      },
    };
  } finally {
    await chat.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
  }
}

const mentionsAll = (replies: readonly string[]) =>
  ['cart', 'price', 'email'].every((word) => replies.join('\n').toLowerCase().includes(word));

const CASES: readonly [string, () => Promise<Result>][] = [
  [
    'D1-parallel',
    () =>
      withChat(
        'D1 research, subagents allowed',
        'In src/, three modules are independent: cart, prices and users. For each, tell me what it validates and what edge case it does not handle. Use subagents for the independent parts.',
        ({ replies, calls }) =>
          Promise.resolve({
            ok: calls.includes('run_subagents') && mentionsAll(replies),
            spawned: calls.includes('run_subagents'),
          }),
      ),
  ],
  [
    'D1-alone',
    () =>
      withChat(
        'D1 research, main alone (control)',
        'In src/, three modules are independent: cart, prices and users. For each, tell me what it validates and what edge case it does not handle. Do the work yourself; do not use run_subagents.',
        ({ replies, calls }) =>
          Promise.resolve({
            ok: !calls.includes('run_subagents') && mentionsAll(replies),
          }),
      ),
  ],
  [
    'D2-workers',
    () =>
      withChat(
        'D2 two independent changes, subagents allowed',
        'Do two independent things: create docs/cart.md with one paragraph on what src/cart.ts does, and create docs/prices.md with one paragraph on what src/prices.ts does. Use subagents for them, one each.',
        async ({ repository, calls }) => {
          const cart = await exists(join(repository, 'docs/cart.md'));
          const prices = await exists(join(repository, 'docs/prices.md'));
          const untouched =
            (await readFile(join(repository, 'src/cart.ts'), 'utf8')) === FILES['src/cart.ts'];
          return {
            ok: calls.includes('run_subagents') && cart && prices && untouched,
            cart,
            prices,
            untouched,
          };
        },
      ),
  ],
  [
    'D3-greeting',
    () =>
      withChat('D3 a greeting needs no subagents', 'Hello!', ({ calls }) =>
        Promise.resolve({ ok: !calls.includes('run_subagents') }),
      ),
  ],
];

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const wanted = args.filter((arg) => arg !== '--yes');
if (!yes) {
  process.stdout.write(`${String(CASES.length)} real-model chats. Nothing was run. Add --yes.\n`);
  process.exit(0);
}
dotenv.config({ path: process.env['MAO_ENV_FILE'] ?? '.env', quiet: true });
if ((process.env['DEEPSEEK_API_KEY'] ?? '').trim() === '') {
  process.stderr.write('DEEPSEEK_API_KEY is not set\n');
  process.exit(2);
}
let failed = 0;
const chosen = CASES.filter(([key]) => wanted.length === 0 || wanted.includes(key));
for (const [key, run] of chosen) {
  const result = await run().catch((error: unknown) => ({
    id: key,
    ok: false,
    facts: { error: error instanceof Error ? error.message : 'unknown' },
  }));
  if (!result.ok) failed += 1;
  process.stdout.write(`${JSON.stringify({ key, ...result })}\n`);
}
process.stdout.write(`${String(chosen.length - failed)}/${String(chosen.length)} passed\n`);
process.exit(failed === 0 ? 0 : 1);
