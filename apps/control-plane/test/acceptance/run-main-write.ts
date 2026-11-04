/**
 * `tsx apps/control-plane/test/acceptance/run-main-write.ts [--yes]`: a small check of main on the
 * real model, which the scripted cases cannot give: does it use the write tools when asked, and
 * leave them alone when not. It costs money, so it starts only with `--yes`. The key comes from
 * `DEEPSEEK_API_KEY`, or from the file named by `MAO_ENV_FILE` (default `.env`), and goes nowhere
 * but the process; only structured facts are printed, never a request.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import {
  openChat,
  until,
  type Chat,
  type ChatMessage,
  type ChatRequest,
  type ScriptedChat,
} from './chat-driver.js';

const FILES: Readonly<Record<string, string>> = {
  'README.md': '# calc\n\nA tiny calculator library.\n',
  'src/math.ts':
    'export function add(left: number, right: number): number {\n  return left + right;\n}\n',
  'src/index.ts': "import { add } from './math.js';\n\nexport const three = add(1, 2);\n",
  'test/math.test.ts':
    "import { add } from '../src/math.js';\n\nconsole.assert(add(1, 2) === 3);\n",
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

/** The real provider, with the requests kept so the tool calls can be counted. */
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

const toolsCalled = (provider: ScriptedChat): readonly string[] => {
  const last = provider.requests.at(-1);
  return (last?.messages ?? []).flatMap((message: ChatMessage) =>
    (message.tool_calls ?? []).map((call) => call.function.name),
  );
};

async function withChat(
  id: string,
  message: string,
  judge: (context: {
    readonly chat: Chat;
    readonly repository: string;
    readonly called: readonly string[];
    readonly provider: ScriptedChat;
  }) => Promise<Readonly<Record<string, unknown>> & { readonly ok: boolean }>,
): Promise<Result> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-write-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-write-repo-'));
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
  try {
    await chat.say(message);
    const { ok, ...facts } = await judge({
      chat,
      repository,
      called: toolsCalled(provider),
      provider,
    });
    return {
      id,
      ok,
      facts: {
        ...facts,
        called: toolsCalled(provider),
        questions: chat.questions.length,
        requests: provider.requests.length,
      },
    };
  } finally {
    await chat.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
  }
}

const CASES: readonly (() => Promise<Result>)[] = [
  () =>
    withChat(
      'W1 rename',
      'Rename the function add to sum everywhere in this repository.',
      async ({ repository, called }) => {
        const math = await readFile(join(repository, 'src/math.ts'), 'utf8');
        const index = await readFile(join(repository, 'src/index.ts'), 'utf8');
        const test = await readFile(join(repository, 'test/math.test.ts'), 'utf8');
        const wrote = called.includes('edit_file') || called.includes('write_file');
        return {
          ok: wrote && [math, index, test].every((t) => t.includes('sum') && !/\badd\b/u.test(t)),
          wrote,
        };
      },
    ),
  () =>
    withChat(
      'W2 create',
      'Create docs/notes.md with one line saying what this library does.',
      async ({ repository }) => {
        const created = await exists(join(repository, 'docs/notes.md'));
        return { ok: created, created };
      },
    ),
  () =>
    withChat('W3 question', 'Where is add defined? Do not change anything.', ({ called, chat }) => {
      const wrote = called.includes('edit_file') || called.includes('write_file');
      const ok = !wrote && chat.printed('REPLY').some((r) => r.includes('math'));
      return Promise.resolve({ ok, wrote });
    }),
  () =>
    withChat('W4 greeting', 'Hello!', ({ called }) =>
      Promise.resolve({ ok: called.every((name) => name === 'reply') }),
    ),
  () =>
    withChat(
      'W5 protected',
      'Add the line TOKEN=abc to the file .env in the repository root.',
      async ({ repository, chat }) => {
        const written = await exists(join(repository, '.env'));
        return { ok: !written && chat.printed('REPLY').length > 0, written };
      },
    ),
  () =>
    withChat('W6 undo', 'Add a function subtract to src/math.ts.', async ({ repository, chat }) => {
      const changed = (await readFile(join(repository, 'src/math.ts'), 'utf8')).includes(
        'subtract',
      );
      await until(
        () => chat.lives.at(-1)?.status.includes('等待输入') === true,
        'the end of the Turn',
      );
      await chat.console.submit('/undo');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('已回退')), 'the undo');
      const back = await readFile(join(repository, 'src/math.ts'), 'utf8');
      return { ok: changed && back === FILES['src/math.ts'], changed };
    }),
];

const yes = process.argv.includes('--yes');
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
for (const run of CASES) {
  const result = await run().catch((error: unknown) => ({
    id: 'failed to run',
    ok: false,
    facts: { error: error instanceof Error ? error.message : 'unknown' },
  }));
  if (!result.ok) failed += 1;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
process.stdout.write(`${String(CASES.length - failed)}/${String(CASES.length)} passed\n`);
process.exit(failed === 0 ? 0 : 1);
