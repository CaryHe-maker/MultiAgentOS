/**
 * `tsx .../run-human-in-loop.ts --yes --out <file> [--runs N] [scenario ids...]`: the human-in-the-loop controls on the real model
 * (docs/History/M2/Evaluation/Stage5HumanInTheLoop.md). A scenario does to a running chat what a user does
 * (answers an `ask_user`, pauses and continues with a note, slips in a note, aborts) and judges the
 * files and the conversation it leaves. A line of facts per run is appended to `--out`; a run that
 * is already there is skipped, so a batch killed at its time limit can be started again. The key
 * comes from `DEEPSEEK_API_KEY` or the file named by `MAO_ENV_FILE`. It costs money, hence `--yes`.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import {
  openChat,
  textOf,
  until,
  type Chat,
  type ChatRequest,
  type ScriptedChat,
} from '../chat-driver.js';

interface Scenario {
  readonly id: string;
  readonly prompt: string;
  readonly files?: Readonly<Record<string, string>>;
  /** What the user does; it returns what it did, for the record. */
  readonly act: (chat: Chat, provider: ScriptedChat) => Promise<Readonly<Record<string, unknown>>>;
  readonly check: (
    repository: string,
    chat: Chat,
    provider: ScriptedChat,
  ) => Promise<Record<string, boolean>>;
}

const exists = (repository: string, path: string) =>
  stat(join(repository, path)).then(
    () => true,
    () => false,
  );
const content = (repository: string, path: string) =>
  readFile(join(repository, path), 'utf8').catch(() => '');
const everything = (provider: ScriptedChat): string =>
  provider.requests
    .flatMap((request) => request.messages.map((message) => textOf(message)))
    .join('\n');
const status = (chat: Chat) => chat.lives.at(-1)?.status;
const mainRequests = (provider: ScriptedChat) =>
  provider.requests.filter((request) =>
    (request.tools ?? []).some((tool) => tool.function.name === 'run_subagents'),
  ).length;
const replies = (chat: Chat) => chat.printed('REPLY').length;

const sevenFiles =
  'Create the files f1.txt to f6.txt, one tool call per file, each containing its own number (1 to 6), one file at a time, then reply.';

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'ask-answer',
    prompt:
      'I want a file greeting.txt with a one-line greeting, but I have not decided the language. Ask me which language (English or French) with ask_user before you write the file, then write it in that language, then reply.',
    act: async (chat) => {
      await until(() => chat.lives.at(-1)?.pending?.kind === 'QUESTION', 'the question', 120_000);
      const question = chat.lives.at(-1)?.pending?.text ?? '';
      await chat.console.submit('French');
      return { question: question.slice(0, 200) };
    },
    check: async (repository, chat, provider) => {
      const greeting = (await content(repository, 'greeting.txt')).toLowerCase();
      return {
        'asked before writing': everything(provider).includes('The user answered'),
        'file is French': /bonjour|salut|bonsoir/u.test(greeting),
        replied: replies(chat) > 0,
        'no error': chat.printed('ERROR').length === 0,
      };
    },
  },
  {
    id: 'pause-continue-note',
    prompt:
      'Create the files a.txt, b.txt and c.txt, each containing its own capital letter (A, B, C), one tool call per file and one file at a time, then reply.',
    act: async (chat, provider) => {
      await until(() => mainRequests(provider) >= 2, 'work under way', 120_000);
      const before = status(chat);
      await chat.console.interrupt();
      await until(() => status(chat) === '已暂停', 'the run to be paused', 60_000);
      await chat.console.submit('/continue Also create d.txt containing D.');
      return { stateBeforePause: before, requestsAtPause: mainRequests(provider) };
    },
    check: async (repository, chat, provider) => ({
      'a, b, c written': (
        await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((name) => exists(repository, name)))
      ).every(Boolean),
      'note followed (d.txt)': (await content(repository, 'd.txt')).includes('D'),
      replied: replies(chat) > 0,
      'note reached the model': everything(provider).includes('Also create d.txt'),
      'no error': chat.printed('ERROR').length === 0,
    }),
  },
  {
    id: 'steer-note',
    prompt:
      'Create the files a.txt, b.txt and c.txt, each containing its own capital letter (A, B, C), one tool call per file and one file at a time, then reply.',
    act: async (chat, provider) => {
      await until(() => mainRequests(provider) >= 2, 'work under way', 120_000);
      await chat.console.steer('Also create e.txt containing E.');
      return { requestsAtSteer: mainRequests(provider) };
    },
    check: async (repository, chat, provider) => ({
      'a, b, c written': (
        await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((name) => exists(repository, name)))
      ).every(Boolean),
      'note followed (e.txt)': (await content(repository, 'e.txt')).includes('E'),
      replied: replies(chat) > 0,
      'note reached the model': everything(provider).includes('Also create e.txt'),
      'never paused': !chat.lives.some((live) => live.status === '已暂停'),
    }),
  },
  {
    id: 'abort-go-on',
    prompt: sevenFiles,
    act: async (chat, provider) => {
      await until(() => mainRequests(provider) >= 2, 'work under way', 120_000);
      await chat.console.interrupt();
      await until(() => status(chat) === '已暂停', 'the run to be paused', 60_000);
      await chat.console.interrupt();
      await until(() => status(chat) === '等待输入', 'the Turn to end', 90_000);
      const aborted = chat.printed('ERROR').join('\n');
      const before = replies(chat);
      await chat.console.submit('Forget the files. Just reply with the single word: ok');
      await until(() => replies(chat) > before, 'the reply after the abort', 120_000);
      return { abortNotice: aborted.slice(0, 120) };
    },
    check: async (repository, chat, provider) => ({
      'abort was told': chat.printed('ERROR').join('\n').includes('已中止'),
      'conversation went on': replies(chat) > 0,
      'main knew it was stopped': everything(provider).includes('the user stopped it'),
      'not all six written': !(
        await Promise.all(
          ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f6.txt'].map((name) =>
            exists(repository, name),
          ),
        )
      ).every(Boolean),
    }),
  },
  {
    id: 'abort-while-asking',
    prompt:
      'Before doing anything, ask me with ask_user what the file should be called, then create it containing the word hello, then reply.',
    act: async (chat) => {
      await until(() => chat.lives.at(-1)?.pending?.kind === 'QUESTION', 'the question', 120_000);
      await chat.console.interrupt();
      await until(() => status(chat) === '已暂停', 'the run to be paused', 60_000);
      await chat.console.interrupt();
      await until(() => status(chat) === '等待输入', 'the Turn to end', 90_000);
      const before = replies(chat);
      await chat.console.submit('Never mind. Reply with the single word: ok');
      await until(() => replies(chat) > before, 'the reply after the abort', 120_000);
      return {};
    },
    check: (_repository, chat) =>
      Promise.resolve({
        'question was dropped': chat.lives.at(-1)?.pending === undefined,
        'question cancelled': chat.printed('NOTICE').some((text) => text.includes('问题已取消')),
        'conversation went on': replies(chat) > 0,
      }),
  },
];

function recordingProvider(): ScriptedChat {
  const requests: ChatRequest[] = [];
  const real = globalThis.fetch;
  return {
    requests,
    add: () => undefined,
    fetch: (input, init) => {
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ChatRequest);
      return real(input, init);
    },
  };
}

async function runOne(scenario: Scenario, run: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-s5-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-s5-repo-'));
  for (const [name, text] of Object.entries({ 'README.md': '# fixture\n', ...scenario.files })) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), text);
  }
  const provider = recordingProvider();
  const chat = await openChat({
    dataDir,
    repository,
    provider,
    answer: () => 'y',
    credentials: { apiKeyFor: () => process.env['DEEPSEEK_API_KEY'] },
  });
  const started = Date.now();
  let error: string | undefined;
  let did: Readonly<Record<string, unknown>> = {};
  try {
    await chat.console.submit(scenario.prompt);
    did = await scenario.act(chat, provider);
    await until(() => replies(chat) > 0, 'the reply', 300_000);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'unknown';
  }
  const checks = await scenario
    .check(repository, chat, provider)
    .catch(() => ({ 'check failed to run': false }));
  const result = {
    scenario: scenario.id,
    run,
    ok: error === undefined && Object.values(checks).every(Boolean),
    ...(error === undefined ? {} : { error }),
    checks,
    did,
    elapsedMs: Date.now() - started,
    requests: provider.requests.length,
    replies: chat.printed('REPLY').map((text) => text.slice(0, 300)),
    errors: chat.printed('ERROR').map((text) => text.slice(0, 200)),
    notices: chat
      .printed('NOTICE')
      .slice(-5)
      .map((text) => text.slice(0, 160)),
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
  process.stdout.write(`${String(SCENARIOS.length)} scenarios. Nothing was run. Add --yes.\n`);
  process.exit(0);
}
const out = option('--out');
if (out === undefined) throw new Error('--out <file> is required');
const runs = Number(option('--runs') ?? '1');
const flagValues = new Set(['--out', '--runs']);
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
      const r = JSON.parse(line) as { scenario: string; run: number };
      return `${r.scenario}|${String(r.run)}`;
    }),
);
for (const scenario of SCENARIOS.filter((each) => wanted.length === 0 || wanted.includes(each.id)))
  for (let run = 1; run <= runs; run += 1) {
    if (done.has(`${scenario.id}|${String(run)}`)) continue;
    const result = await runOne(scenario, run).catch((error: unknown) => ({
      scenario: scenario.id,
      run,
      ok: false,
      error: error instanceof Error ? error.message : 'unknown',
    }));
    await appendFile(out, `${JSON.stringify(result)}\n`);
    process.stdout.write(`${scenario.id} #${String(run)} ${result.ok ? 'ok' : 'FAILED'}\n`);
  }
process.exit(0);
