/**
 * The deterministic acceptance cases (M2Design 13): commands and the sandbox
 * (C5), the authorization of commands (A), H6 and H7, and memory pressure. Every case runs the
 * real product from the console down to `bwrap` and `git`, with only the provider's HTTP API
 * scripted. What the model would see is read from the requests the provider received.
 *
 * Cases that need the real sandbox run where `bwrap` works (Ubuntu 24.04 and WSL, M2TechStack
 * 3.1); the others run wherever the product runs.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  StopUnconfirmedError,
  type ExecutorRegistry,
  type SystemConfig,
  type SystemFault,
} from '@multiagentos/contracts';
import { createExecutorRegistry } from '@multiagentos/executor-set';
import { createSubprocessRunner, probeSandbox, type MemorySample } from '@multiagentos/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listSessions,
  openChat,
  reply,
  scriptedChat,
  textOf,
  tool,
  until,
  type Answer,
  type Chat,
  type ChatOptions,
  type ChatRequest,
  type ProviderTurn,
  type ScriptedChat,
} from './chat-driver.js';

const TIMEOUT = 90_000;
const bwrapWorks = (await probeSandbox(tmpdir())).available;
const subprocess = createSubprocessRunner();
const real = bwrapWorks ? describe : describe.skip;
const onLinux = process.platform === 'linux' ? describe : describe.skip;

const directories: string[] = [];
const open: Chat[] = [];
const traces: { chat: Chat; provider: ScriptedChat }[] = [];
afterEach(async (context) => {
  if (process.env['STAGE3_DEBUG'] !== undefined && context.task.result?.state !== 'pass') {
    for (const { chat, provider } of traces) {
      process.stderr.write(`--- ${context.task.name}
`);
      for (const record of chat.records)
        process.stderr.write(`[${record.kind}] ${record.text}
`);
      process.stderr.write(`questions: ${JSON.stringify(chat.questions)}
`);
      for (const request of provider.requests)
        process.stderr.write(`REQ tools-results: ${JSON.stringify(toolResults(request))}
`);
    }
  }
  traces.splice(0);
  delete process.env['MAS_SANDBOX_SECRET_TOKEN'];
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface Place {
  readonly dataDir: string;
  readonly repository: string;
}

/** A repository with files, and optionally a git history of them. */
async function roots(
  files: Readonly<Record<string, string>> = {},
  options: { readonly git?: boolean } = {},
): Promise<Place> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-sandbox-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-sandbox-repo-'));
  directories.push(dataDir, repository);
  for (const [name, content] of Object.entries({ 'a.txt': 'one\n', ...files })) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  if (options.git === true) {
    const git = async (...args: string[]) => {
      const result = await subprocess.run(
        'git',
        ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
        { cwd: repository, signal: new AbortController().signal, maxOutputBytes: 100_000, env: {} },
      );
      if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
    };
    await git('init', '-q');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'first commit');
  }
  return { dataDir, repository };
}

const kernel =
  (over: Partial<SystemConfig['kernel']>) =>
  (config: SystemConfig): SystemConfig => ({ ...config, kernel: { ...config.kernel, ...over } });

async function chatOn(
  place: Place,
  provider: ScriptedChat,
  options: Partial<ChatOptions> = {},
): Promise<Chat> {
  const chat = await openChat({ ...place, provider, ...options });
  open.push(chat);
  traces.push({ chat, provider });
  return chat;
}

const seen = (provider: ScriptedChat): string =>
  provider.requests
    .flatMap((request) => request.messages.map((message) => textOf(message)))
    .join('\n');
/** The tool results the model got in its last request, in order. */
const toolResults = (request: ChatRequest | undefined): string[] =>
  (request?.messages ?? []).filter((m) => m.role === 'tool').map((m) => textOf(m));
const lastResult = (provider: ScriptedChat): string =>
  // Every result ends with the line that names its call ; what it says is above it.
  (toolResults(provider.requests.at(-1)).at(-1) ?? '').replace(/\s*\[toolCallId: [^\]]+\]$/u, '');
const run = (command: string, extra: Record<string, unknown> = {}) =>
  tool('run_command', { command, ...extra });
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
/** Several tool calls in one reply of the model. */
const together = (...names: readonly ProviderTurn[]): ProviderTurn => ({
  calls: names.flatMap((turn) => ('calls' in turn ? turn.calls : [])),
});
/** The real Executors, built while the provider is the scripted one (ExecutorSet 7). */
function registryOver(
  provider: ScriptedChat,
  over: (real: ExecutorRegistry) => Partial<ExecutorRegistry>,
): ExecutorRegistry {
  const original = globalThis.fetch;
  globalThis.fetch = provider.fetch;
  try {
    const real = createExecutorRegistry();
    return { ...real, ...over(real) };
  } finally {
    globalThis.fetch = original;
  }
}
/** Answers the way a user who allows whatever is on offer would: the longest standing allowance. */
const widest = (question: string): Answer => (question.includes('3 / p') ? 'p' : 'y');
const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every file under `directory` whose content holds `needle`. */
async function filesHolding(directory: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesHolding(path, needle)));
    else if ((await readFile(path).catch(() => Buffer.alloc(0))).includes(needle)) found.push(path);
  }
  return found;
}
const sessionDirectory = async (dataDir: string) => {
  const [id] = await readdir(join(dataDir, 'sessions'));
  if (id === undefined) throw new Error('no Session directory');
  return join(dataDir, 'sessions', id);
};
const logOf = async (dataDir: string) =>
  readFile(join(await sessionDirectory(dataDir), 'workflow', 'log.v1.jsonl'), 'utf8');

/** `submit` without waiting for a reply: for a Turn that is meant not to end in one. */
async function sayAndSettle(chat: Chat, text: string, ms = 600): Promise<void> {
  await chat.console.submit(text);
  await nap(ms);
}

// ------------------------------------------------------------------------------------------------

real('C: running a command, in the sandbox', () => {
  it(
    'runs after one question that shows the command, and the output reaches the model',
    async () => {
      const place = await roots();
      const provider = scriptedChat(run('echo out; echo err >&2; exit 3'), reply('done'));
      const chat = await chatOn(place, provider);
      await chat.say('run it');
      // The probe found the sandbox, and the model is told what it can rely on.
      expect(seen(provider)).toContain('Sandbox: bwrap (isolated');
      expect(await logOf(place.dataDir)).toContain('"sandbox":{"state":"ISOLATED"}');
      expect(chat.questions).toHaveLength(1);
      expect(chat.questions[0]).toContain('echo out; echo err >&2; exit 3');
      expect(chat.questions[0]).toContain('1 / y');
      expect(chat.questions[0]).toContain('3 / p');
      const result = lastResult(provider);
      // A non-zero exit is a result, not an error, and both streams are there.
      expect(result).toContain('exit code 3');
      expect(result).toContain('out');
      expect(result).toContain('err');
    },
    TIMEOUT,
  );

  it(
    'runs a line of the read-only list after one question about reading the repository, none about the command',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run('ls -la && wc -l a.txt'),
        run('cat a.txt | head -3'),
        run('pwd'),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('look around');
      // The only question is the one `read_file` would have asked: the command is not asked about.
      expect(chat.questions).toHaveLength(1);
      expect(chat.questions[0]).toContain('读取仓库');
      const results = toolResults(provider.requests.at(-1));
      expect(results[0]).toContain('exit code 0');
      expect(results[0]).toContain('a.txt');
      expect(results[1]).toContain('exit code 0');
      expect(results[2]).toContain('exit code 0');
      // The model is shown the same status line as for any command: nothing about a shortcut.
      for (const result of results) expect(result).not.toMatch(/read-only|auto/iu);
      // It is on record, though, and the user's story of the run holds it.
      const audit = await readFile(
        join(await sessionDirectory(place.dataDir), 'kernel-core', 'audit.jsonl'),
        'utf8',
      );
      expect(audit.match(/COMMAND_READ_ONLY/gu)).toHaveLength(3);
    },
    TIMEOUT,
  );

  it(
    'asks about the command, as before, when the line can write or is not on the list',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run('ls > listing.txt'),
        run('find . -name "*.nothing" -delete'),
        run('npm --version && node -e "1"'),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('write a listing');
      const commandQuestions = chat.questions.filter((question) => !question.includes('读取仓库'));
      expect(commandQuestions).toHaveLength(3);
      expect(commandQuestions[0]).toContain('ls > listing.txt');
      expect(await readFile(join(place.repository, 'listing.txt'), 'utf8')).toContain('a.txt');
    },
    TIMEOUT,
  );

  it(
    'needs no question at all for a line that opens no file, like echo and pwd',
    async () => {
      const place = await roots();
      const provider = scriptedChat(run('echo hello; pwd'), reply('done'));
      const chat = await chatOn(place, provider);
      await chat.say('say hello');
      expect(chat.questions).toHaveLength(0);
      expect(lastResult(provider)).toContain('hello');
    },
    TIMEOUT,
  );

  it(
    'refused repo.read: the line is asked about as an ordinary command',
    async () => {
      const place = await roots();
      const provider = scriptedChat(run('ls'), reply('done'));
      const chat = await chatOn(place, provider, {
        answer: (question) => (question.includes('读取仓库') ? 'n' : 'y'),
      });
      await chat.say('list');
      // The user said no to reading the repository: the line is then asked about like any command,
      // and it runs because the user said yes to that.
      expect(chat.questions).toHaveLength(2);
      expect(chat.questions[0]).toContain('读取仓库');
      expect(chat.questions[1]).toContain('ls');
      expect(lastResult(provider)).toContain('a.txt');
    },
    TIMEOUT,
  );

  it(
    'tells a timed-out command from a failed one, and keeps what it printed',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run('echo before; sleep 30', { timeoutMs: 500, promoteOnTimeout: false }),
        run('false'),
        reply('done'),
      );
      const started = Date.now();
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(Date.now() - started).toBeLessThan(25_000);
      const results = toolResults(provider.requests.at(-1));
      expect(results[0]).toContain('timed out');
      expect(results[0]).toContain('before');
      expect(results[1]).toContain('exit code 1');
    },
    TIMEOUT,
  );

  it(
    'cuts a long output in the middle, and read_output reads the rest by the call id',
    async () => {
      const place = await roots();
      const provider = scriptedChat(run('seq 1 40000'), reply('placeholder'));
      const chat = await chatOn(place, provider);
      await chat.say('print a lot');
      const first = toolResults(provider.requests.at(-1))[0] ?? '';
      expect(first).toContain('left out of the middle');
      expect(first).toMatch(/\n1\n2\n/u);
      expect(first).not.toContain('\n20000\n');
      // The id the model uses is the one it was given for that call.
      const id = provider.requests
        .at(-1)
        ?.messages.find((message) => message.role === 'tool')?.tool_call_id;
      expect(id).toBeDefined();
      provider.add(
        tool('read_output', { toolCallId: id, offset: 20_000, limit: 3 }),
        reply('read'),
      );
      await chat.say('now the middle');
      expect(lastResult(provider)).toMatch(/20000\n.*20001\n.*20002/su);
    },
    TIMEOUT,
  );

  it(
    'starts in the work directory it was given, and refuses one that leaves the repository',
    async () => {
      const place = await roots({ 'pkg/lib/x.txt': 'x\n' });
      const provider = scriptedChat(
        run('pwd', { workdir: 'pkg/lib' }),
        run('pwd', { workdir: '../outside' }),
        run('pwd', { workdir: '/etc' }),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('where am I');
      const results = toolResults(provider.requests.at(-1));
      expect(results[0]).toContain(join(place.repository, 'pkg/lib'));
      expect(results[1]).toContain('workdir must be a relative path');
      expect(results[2]).toContain('workdir must be a relative path');
      // Only the first got as far as a decision, and `pwd` opens no file: no question at all.
      expect(chat.questions).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    'each command starts in a fresh shell: nothing carries over',
    async () => {
      const place = await roots({ 'sub/f': '' });
      const provider = scriptedChat(
        run('cd sub; export KEPT=yes; echo set'),
        run('echo "cwd=$(basename "$PWD") kept=[${KEPT-}]"'),
        reply('done'),
      );
      const chat = await chatOn(place, provider, { answer: () => 'y' });
      await chat.say('two shells');
      expect(lastResult(provider)).toMatch(/cwd=mas-sandbox-repo-\S+ kept=\[\]/u);
    },
    TIMEOUT,
  );
});

// ------------------------------------------------------------------------------------------------

real('C5: what the sandbox keeps a command from', () => {
  it(
    'reads a secret file as empty, so the secret never reaches the model or any log',
    async () => {
      const place = await roots({
        '.env': 'DB_PASSWORD=hunter2-sandbox\n',
        'keys/server.pem': 'PRIVATE-KEY-sandbox\n',
        'src/deep/id_rsa': 'SSH-KEY-sandbox\n',
      });
      const provider = scriptedChat(
        run(
          'wc -c < .env; wc -c < keys/server.pem; wc -c < src/deep/id_rsa; grep -r sandbox . 2>&1 | wc -l',
        ),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('look for secrets');
      const lines = lastResult(provider).split('\n');
      expect(lines.slice(-5).join(' ')).toMatch(/0\s+0\s+0\s+0/u);
      for (const secret of ['hunter2-sandbox', 'PRIVATE-KEY-sandbox', 'SSH-KEY-sandbox'])
        expect(seen(provider)).not.toContain(secret);
      expect(await filesHolding(place.dataDir, 'hunter2-sandbox')).toEqual([]);
      // The files themselves are untouched.
      expect(await readFile(join(place.repository, '.env'), 'utf8')).toContain('hunter2');
    },
    TIMEOUT,
  );

  it(
    'gives no credential in the environment, however the model asks for it',
    async () => {
      process.env['MAS_SANDBOX_SECRET_TOKEN'] = 'leak-me-sandbox';
      const place = await roots();
      const provider = scriptedChat(
        run('env'),
        run('printenv MAS_SANDBOX_SECRET_TOKEN; echo "status=$?"'),
        run('cat /proc/self/environ | tr "\\0" "\\n"'),
        reply('done'),
      );
      const chat = await chatOn(place, provider, { answer: () => 'y' });
      await chat.say('dump the environment');
      const results = toolResults(provider.requests.at(-1));
      expect(results[0]).toContain('PATH=');
      expect(results[1]).toContain('status=1');
      expect(seen(provider)).not.toContain('leak-me-sandbox');
      expect(seen(provider)).not.toContain('sk-acceptance-offline-key');
      expect(await filesHolding(place.dataDir, 'leak-me-sandbox')).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'cannot write outside the repository, and the files stay where they were',
    async () => {
      const outside = await mkdtemp(join(tmpdir(), 'mas-sandbox-outside-'));
      directories.push(outside);
      const place = await roots();
      const provider = scriptedChat(
        run(`touch ${outside}/x 2>&1; touch /etc/mas-x 2>&1; touch ~/mas-x 2>&1; echo end`),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('write elsewhere');
      expect(lastResult(provider)).toMatch(/Read-only file system|No such file|Permission denied/u);
      expect(lastResult(provider)).toContain('sandbox refused');
      expect(await exists(join(outside, 'x'))).toBe(false);
      expect(await exists('/etc/mas-x')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'follows a link out of the repository to nothing: the target is not there',
    async () => {
      const outside = await mkdtemp(join(tmpdir(), 'mas-sandbox-outside-'));
      directories.push(outside);
      await writeFile(join(outside, 'secret.txt'), 'OUTSIDE-SECRET-sandbox\n');
      const place = await roots();
      await symlink(join(outside, 'secret.txt'), join(place.repository, 'link'));
      const provider = scriptedChat(
        run('cat link 2>&1; echo "status=$?"'),
        run('echo planted > link 2>&1; echo "status=$?"'),
        reply('done'),
      );
      const chat = await chatOn(place, provider, { answer: () => 'y' });
      await chat.say('read the link');
      expect(seen(provider)).not.toContain('OUTSIDE-SECRET-sandbox');
      expect(toolResults(provider.requests.at(-1))[0]).toContain('status=1');
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('OUTSIDE-SECRET-sandbox\n');
    },
    TIMEOUT,
  );

  it(
    'has no network: an address on the loopback or outside is unreachable',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run(
          '(exec 3<>/dev/tcp/127.0.0.1/9) 2>/dev/null; echo "loopback=$?"; cat /proc/net/dev | tail -n +3 | wc -l',
        ),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('connect');
      const result = lastResult(provider);
      expect(result).toContain('loopback=1');
      // Only the loopback device is there.
      expect(result.trim().split('\n').at(-1)).toBe('1');
    },
    TIMEOUT,
  );

  it(
    'keeps existing .git and AGENTS.md read-only, and moves out what a command creates',
    async () => {
      const place = await roots({ 'AGENTS.md': 'rules\n', 'src/a.ts': 'a\n' }, { git: true });
      const provider = scriptedChat(
        run('echo hacked >> .git/config 2>&1; echo hacked >> AGENTS.md 2>&1; echo end'),
        run(
          'mkdir -p src/.git/hooks && echo evil > src/.git/hooks/pre-commit && echo new > src/AGENTS.md; echo made',
        ),
        run('echo fine > src/ok.txt; echo ok'),
        reply('done'),
      );
      const chat = await chatOn(place, provider, { answer: () => 'y' });
      await chat.say('tamper');
      const results = toolResults(provider.requests.at(-1));
      expect(results[0]).toContain('Read-only file system');
      expect(await readFile(join(place.repository, 'AGENTS.md'), 'utf8')).toBe('rules\n');
      expect(await readFile(join(place.repository, '.git', 'config'), 'utf8')).not.toContain(
        'hacked',
      );
      // The command made protected paths: they are gone from the repository, and it says so.
      expect(results[1]).toContain('protected path');
      expect(await exists(join(place.repository, 'src', '.git'))).toBe(false);
      expect(await exists(join(place.repository, 'src', 'AGENTS.md'))).toBe(false);
      const quarantine = join(
        await sessionDirectory(place.dataDir),
        'kernel-execution',
        'quarantine',
      );
      expect((await readdir(quarantine)).length).toBe(2);
      expect(
        await filesHolding(await sessionDirectory(place.dataDir), 'PROTECTED_PATH_CREATED'),
      ).not.toEqual([]);
      // A command that made nothing protected is not touched.
      expect(await readFile(join(place.repository, 'src', 'ok.txt'), 'utf8')).toBe('fine\n');
    },
    TIMEOUT,
  );

  it(
    'cannot read the system data directory, where the logs and the artifacts are',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run(`ls ${place.dataDir} 2>&1 | head -3; echo end`),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('look around');
      expect(lastResult(provider)).not.toContain('sessions');
    },
    TIMEOUT,
  );
});

// ------------------------------------------------------------------------------------------------

/** A node (or any tool) installed under the home directory is what this group is about. */
const toolchainDirectory = dirname(process.execPath);
const underHome = toolchainDirectory.startsWith(`${homedir()}/`);
const homeCases = bwrapWorks && underHome ? describe : describe.skip;

homeCases('the tools on PATH that live under the home directory (M2Design 6.1, v1.18)', () => {
  it(
    'a command finds them, with the libraries they load through ../lib',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run('node --version; npm --version; node -e "console.log(2 + 2)"'),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('which node');
      const result = lastResult(provider);
      expect(result).toContain('exit code 0');
      expect(result).toContain(process.version);
      expect(result).toMatch(/\n\d+\.\d+\.\d+\n4$/u);
    },
    TIMEOUT,
  );

  it(
    'the rest of the home directory stays hidden while they are there',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run(
          `for f in ~/.bashrc ~/.profile ~/.ssh ~/.gitconfig ~/.bash_history ~/.aws; do test -e "$f" && echo "visible $f"; done; echo checked`,
        ),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('look at home');
      const result = lastResult(provider);
      expect(result).toContain('checked');
      expect(result).not.toContain('visible');
    },
    TIMEOUT,
  );

  it(
    'the switch turns it off: without it the tool directory is not there',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run(`ls ${toolchainDirectory} 2>&1 | head -2; echo end`),
        reply('done'),
      );
      const chat = await chatOn(place, provider, {
        configure: kernel({
          sandbox: { ...kernelDefaults().sandbox, mountPath: false },
        }),
      });
      await chat.say('is it there');
      expect(lastResult(provider)).toMatch(/No such file or directory/u);
    },
    TIMEOUT,
  );
});

real('H6: a command that will not stop', () => {
  it(
    'is killed after its grace period, and nothing of it is left running',
    async () => {
      const place = await roots();
      const marker = join(place.repository, 'alive');
      const stubborn = `trap '' TERM; (trap '' TERM; while true; do date +%s%N > alive; sleep 0.1; done) & wait`;
      const provider = scriptedChat(
        run(stubborn, { timeoutMs: 700, promoteOnTimeout: false }),
        run('echo after'),
        reply('done'),
      );
      const started = Date.now();
      const chat = await chatOn(place, provider, {
        configure: kernel({ cancelGraceMs: 400, killGraceMs: 400 }),
        answer: () => 'y',
      });
      await chat.say('hang');
      expect(Date.now() - started).toBeLessThan(30_000);
      const results = toolResults(provider.requests.at(-1));
      expect(results[0]).toContain('timed out');
      expect(results[1]).toContain('after');
      // The loop that writes the marker is gone: the file stops changing.
      const before = await readFile(marker, 'utf8').catch(() => '');
      await nap(500);
      expect(await readFile(marker, 'utf8').catch(() => '')).toBe(before);
      // And the system went on: no fault, the Turn ended normally.
      expect(chat.printed('REPLY')).toContain('done');
    },
    TIMEOUT,
  );
});

// ------------------------------------------------------------------------------------------------

onLinux('H7: a process that cannot be confirmed stopped', () => {
  /** An Executor that cannot say the process is gone, and counts how often it was asked to run. */
  function stuckExecutors(provider: ScriptedChat, calls: string[]) {
    return registryOver(provider, () => ({
      COMMAND: {
        executionKind: 'COMMAND' as const,
        execute: (input: { command: string }) => {
          calls.push(input.command);
          return Promise.reject(new StopUnconfirmedError(4242));
        },
      },
    }));
  }

  it(
    'stops the system, runs nothing after it, and does not run the command again on resume',
    async () => {
      const place = await roots();
      const calls: string[] = [];
      const faults: SystemFault[] = [];
      const provider = scriptedChat(run('make deploy'), reply('never sent'));
      const chat = await chatOn(place, provider, {
        executors: stuckExecutors(provider, calls),
        sandboxProbe: { available: true },
        reportSystemFault: (fault) => faults.push(fault),
        answer: () => 'y',
      });
      await sayAndSettle(chat, 'deploy', 1500);
      await until(() => faults.length > 0, 'the system fault');
      expect(String(faults[0]?.error)).toContain('STOP_UNCONFIRMED');
      expect(calls).toEqual(['make deploy']);
      // The run is over: the model was not asked again.
      expect(provider.requests).toHaveLength(1);
      expect(await logOf(place.dataDir)).toContain('"closeReason":"FAILED"');
      await chat.close().catch(() => undefined);

      // The next process opens the Session and the command is not started again.
      const again: string[] = [];
      const later = scriptedChat(reply('back'));
      const resumed = await chatOn(place, later, {
        executors: stuckExecutors(later, again),
        sandboxProbe: { available: true },
      });
      await until(() => resumed.printed('NOTICE').length > 0, 'the welcome');
      await listSessions(resumed);
      await resumed.console.submit('/resume 1');
      await until(() => resumed.console.sessionId !== undefined, 'the resumed Session');
      await resumed.say('continue');
      expect(again).toEqual([]);
    },
    TIMEOUT,
  );
});

// ------------------------------------------------------------------------------------------------

/** The authorization cases are about the question, so the read-only shortcut is off for them. */
const withoutShortcut = (config: SystemConfig): SystemConfig => ({
  ...config,
  kernel: { ...config.kernel, command: { ...config.kernel.command, readOnlyCommands: [] } },
});
const chatWithoutShortcut = (
  place: Place,
  provider: ScriptedChat,
  options: Partial<ChatOptions> = {},
): Promise<Chat> =>
  chatOn(place, provider, {
    ...options,
    configure: (config) => (options.configure ?? ((same) => same))(withoutShortcut(config)),
  });

real('A: the authorization of commands', () => {
  const chatOn = chatWithoutShortcut;
  const questionsAbout = (chat: Chat) =>
    chat.questions.filter((question) => !question.includes('读取仓库'));

  it(
    'a prefix answer covers the same kind of command, but not another one',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run('echo one'),
        run('echo two three'),
        run('printf four'),
        reply('done'),
      );
      const chat = await chatOn(place, provider, { answer: () => 'p' });
      await chat.say('three commands');
      // `echo one` asked; `echo two three` is the same prefix `echo two`? No: the prefix is `echo`.
      expect(questionsAbout(chat)).toHaveLength(2);
      expect(questionsAbout(chat)[1]).toContain('printf four');
    },
    TIMEOUT,
  );

  it(
    '"this command" covers that exact line only',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run('echo same'),
        run('echo same'),
        run('echo other'),
        reply('d'),
      );
      const chat = await chatOn(place, provider, { answer: () => 'c' });
      await chat.say('go');
      expect(questionsAbout(chat)).toHaveLength(2);
      expect(questionsAbout(chat)[1]).toContain('echo other');
    },
    TIMEOUT,
  );

  it(
    'a single allowance is spent by the one command',
    async () => {
      const place = await roots();
      const provider = scriptedChat(run('echo a'), run('echo a'), reply('d'));
      const chat = await chatOn(place, provider, { answer: () => 'y' });
      await chat.say('twice');
      expect(questionsAbout(chat)).toHaveLength(2);
    },
    TIMEOUT,
  );

  it(
    'does not carry over to a new WorkflowRun: the same command asks again after a restart',
    async () => {
      const place = await roots();
      const first = scriptedChat(run('echo kept'), reply('one'));
      const chat = await chatOn(place, first, { answer: () => 'c' });
      await chat.say('go');
      await chat.close();

      const second = scriptedChat(run('echo kept'), reply('two'));
      const resumed = await chatOn(place, second, { answer: () => 'c' });
      await until(() => resumed.printed('NOTICE').length > 0, 'the welcome');
      await listSessions(resumed);
      await resumed.console.submit('/resume 1');
      await until(() => resumed.console.sessionId !== undefined, 'the resumed Session');
      await resumed.say('again');
      expect(questionsAbout(resumed)).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'a refusal comes back as a tool result, the same run does not ask again, the next Turn may',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run('echo first'),
        run('echo second'),
        reply('I was not allowed'),
        run('echo third'),
        reply('ran now'),
      );
      let answers = 0;
      const chat = await chatOn(place, provider, {
        answer: () => {
          answers += 1;
          return answers === 1 ? 'n' : 'y';
        },
      });
      await chat.say('go');
      expect(questionsAbout(chat)).toHaveLength(1);
      const refused = toolResults(provider.requests.at(-1));
      expect(refused[0]).toContain('the user rejected tool "run_command"');
      expect(refused[1]).toContain('the user rejected tool "run_command"');
      await chat.say('please, now');
      expect(questionsAbout(chat)).toHaveLength(2);
      expect(lastResult(provider)).toContain('third');
    },
    TIMEOUT,
  );

  it(
    'a waiting question lets nothing through and refuses nothing',
    async () => {
      const place = await roots();
      const provider = scriptedChat(run('echo waits'), reply('d'));
      const chat = await chatOn(place, provider, { answer: () => 'hold' });
      await sayAndSettle(chat, 'go', 1200);
      expect(provider.requests).toHaveLength(1);
      expect(chat.questions).toHaveLength(1);
      await chat.answerOpen('y');
      await until(() => provider.requests.length === 2, 'the second model call');
      expect(lastResult(provider)).toContain('waits');
    },
    TIMEOUT,
  );

  it.each([
    ['a command substitution', 'echo $(date +%Y)', '命令替换'],
    ['eval', 'eval "echo hi"', 'eval'],
    ['a shell -c', 'bash -c "echo hi"', 'bash -c'],
    ['a pipe into a shell', 'echo "echo hi" | sh', '管道通往 shell'],
    ['a name that is a variable', 'X=echo; $X hi', '命令名来自变量'],
    ['a line that does not parse', 'echo "unterminated', '无法完整解析'],
  ])(
    'offers only a single allowance for %s',
    async (_name, command, why) => {
      const place = await roots();
      const provider = scriptedChat(run(command), reply('d'));
      const chat = await chatOn(place, provider, { answer: () => 'hold' });
      await sayAndSettle(chat, 'go', 800);
      // A slow machine may not have asked after the pause: wait for the question itself.
      await until(() => chat.questions.length > 0, 'the question');
      const question = chat.questions[0] ?? '';
      expect(question).toContain('只能单次允许');
      expect(question).toContain(why);
      expect(question).not.toContain('2 / c');
      expect(question).not.toContain('3 / p');
      // An answer the question did not offer is not taken: it stays open.
      await chat.answerOpen('n');
    },
    TIMEOUT,
  );

  it(
    'git push and the like are asked every time, in warning style, with no standing allowance',
    async () => {
      const place = await roots({}, { git: true });
      const provider = scriptedChat(
        run('git status --short'),
        run('git push origin main'),
        run('env git push'),
        run('gh pr create'),
        reply('d'),
      );
      const chat = await chatOn(place, provider, { answer: widest });
      await chat.say('ship it');
      const [, ...critical] = chat.questions;
      expect(chat.questions).toHaveLength(4);
      for (const question of critical) {
        expect(question).toContain('高风险');
        expect(question).not.toContain('3 / p');
      }
      expect(critical[0]).toContain('命中名单：git push');
      expect(critical[1]).toContain('命中名单：git push');
      expect(critical[2]).toContain('命中名单：gh');
      // The answer `p` was not on offer for them, so those commands waited for a valid one.
    },
    TIMEOUT,
  );

  it(
    'the network is asked every time, says so, and the command is not told yes by an old answer',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        run('echo local'),
        run('cat /proc/net/dev | tail -n +3 | wc -l', { network: true }),
        reply('d'),
      );
      const chat = await chatOn(place, provider, {
        answer: (question) => (question.includes('2 / c') ? 'c' : 'y'),
      });
      await chat.say('go');
      // Two questions: the grant for `echo local` does not reach a network command.
      expect(chat.questions).toHaveLength(2);
      expect(chat.questions[1]).toContain('共享主机网络');
      expect(chat.questions[1]).toContain('高风险');
      expect(chat.questions[1]).not.toContain('2 / c');
    },
    TIMEOUT,
  );

  it(
    'the list of denied commands refuses without a question, also behind a wrapper',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        together(
          run('rm -rf build'),
          run('env rm -rf build'),
          run('x=1 rm -rf build'),
          run('(cd src && rm -rf build)'),
          run('ls'),
        ),
        reply('d'),
      );
      const chat = await chatOn(place, provider, {
        configure: kernel({
          command: { deniedCommands: ['rm -rf'], criticalCommands: [], readOnlyCommands: [] },
        }),
      });
      await chat.say('clean up');
      const results = toolResults(provider.requests.at(-1));
      for (const result of results.slice(0, 4)) expect(result).toContain('never run');
      expect(results[4]).toContain('a.txt');
      // Only `ls` was ever asked about.
      expect(chat.questions).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'an approved line is the line that runs: a changed command is refused by the Supervisor',
    async () => {
      const place = await roots();
      const provider = scriptedChat(run('echo approved'), reply('d'));
      let swapped = false;
      const chat = await chatOn(place, provider, {
        executors: registryOver(provider, (real) => ({
          // Someone changes the command between the question and the start.
          COMMAND: {
            executionKind: 'COMMAND',
            execute: (input, environment) => {
              swapped = true;
              return real.COMMAND.execute({ ...input, command: 'echo swapped' }, environment);
            },
          },
        })),
      });
      await chat.say('go');
      expect(swapped).toBe(true);
      expect(lastResult(provider)).toContain('not the one the user approved');
      expect(lastResult(provider)).not.toContain('swapped\n');
    },
    TIMEOUT,
  );
});

// ------------------------------------------------------------------------------------------------

onLinux('the sandbox is not there', () => {
  it(
    'offers no command tool by default, tells the model so, and records why in the log',
    async () => {
      const place = await roots();
      // The model calls the tool anyway, as one that was told about it in training might.
      const provider = scriptedChat(run('echo hi'), reply('d'));
      const chat = await chatOn(place, provider, {
        sandboxProbe: { available: false, reason: 'USERNS_DENIED', hint: 'fix apparmor' },
      });
      await chat.say('go');
      const names = (provider.requests[0]?.tools ?? []).map((entry) => entry.function.name);
      expect(names).toContain('read_file');
      expect(names).not.toContain('run_command');
      expect(chat.questions).toEqual([]);
      expect(lastResult(provider)).toContain('no such tool');
      expect(seen(provider)).toContain('Sandbox: none (commands cannot be run)');
      expect(await logOf(place.dataDir)).toContain(
        '"sandbox":{"state":"UNAVAILABLE","reason":"USERNS_DENIED"}',
      );
      expect(await filesHolding(place.dataDir, 'SANDBOX_PROBED')).not.toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'with ask-unisolated, asks for each command, says it is not isolated, and then runs it as it is',
    async () => {
      const place = await roots({ '.env': 'VISIBLE-sandbox\n' });
      const provider = scriptedChat(
        run('echo hi; echo "env=$(cat .env)"'),
        run('echo again'),
        reply('d'),
      );
      const chat = await chatOn(place, provider, {
        sandboxProbe: { available: false, reason: 'NO_BWRAP', hint: 'install bubblewrap' },
        configure: kernel({
          sandbox: { ...kernelDefaults().sandbox, unavailable: 'ask-unisolated' },
        }),
        answer: () => 'y',
      });
      await chat.say('go');
      expect(chat.questions).toHaveLength(2);
      for (const question of chat.questions) {
        expect(question).toContain('未隔离');
        expect(question).not.toContain('2 / c');
      }
      const names = (provider.requests[0]?.tools ?? []).map((entry) => entry.function.name);
      expect(names).toContain('run_command');
      expect(seen(provider)).toContain('Sandbox: none (not isolated');
      expect(await logOf(place.dataDir)).toContain(
        '"sandbox":{"state":"UNISOLATED","reason":"NO_BWRAP"}',
      );
      const results = toolResults(provider.requests.at(-1));
      expect(results[0]).toContain('[not isolated]');
      // Without a sandbox the mask is not there either; that is what the question warned of.
      expect(results[0]).toContain('VISIBLE-sandbox');
    },
    TIMEOUT,
  );

  it(
    'the readonly preset offers no command tool at all',
    async () => {
      const place = await roots();
      const provider = scriptedChat(reply('only reading'));
      const chat = await chatOn(place, provider, { preset: 'readonly' });
      await chat.say('hello');
      const names = (provider.requests[0]?.tools ?? []).map((entry) => entry.function.name);
      expect(names).toContain('read_file');
      expect(names).not.toContain('run_command');
      expect(names).not.toContain('write_file');
    },
    TIMEOUT,
  );
});

const kernelDefaults = () => ({
  sandbox: {
    unavailable: 'deny' as const,
    homeReadOnly: [] as string[],
    mountPath: true,
    homeMaskedFiles: [] as string[],
  },
});

// ------------------------------------------------------------------------------------------------

onLinux('git_inspect', () => {
  it(
    'shows status, log, diff and blame, and never the content of a hidden file',
    async () => {
      const place = await roots(
        { 'src/a.ts': 'one\n', '.env': 'SECRET-sandbox=1\n' },
        { git: true },
      );
      await writeFile(join(place.repository, 'src/a.ts'), 'one\ntwo\n');
      await writeFile(join(place.repository, '.env'), 'SECRET-sandbox=2\n');
      const provider = scriptedChat(
        tool('git_inspect', { action: 'status' }),
        tool('git_inspect', { action: 'diff' }),
        tool('git_inspect', { action: 'log', limit: 5 }),
        tool('git_inspect', { action: 'blame', path: 'src/a.ts' }),
        tool('git_inspect', { action: 'show', rev: 'HEAD', path: 'src/a.ts' }),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('what changed');
      const results = toolResults(provider.requests.at(-1));
      expect(results[0]).toContain('src/a.ts');
      expect(results[1]).toContain('+two');
      expect(results[2]).toContain('first commit');
      expect(results[3]).toContain('one');
      expect(results[4]).toContain('first commit');
      expect(seen(provider)).not.toContain('SECRET-sandbox');
      // It only needs the repository, which is asked once.
      expect(chat.questions).toHaveLength(1);
      expect(chat.questions[0]).toContain('读取仓库');
    },
    TIMEOUT,
  );

  it(
    'takes fixed arguments only: an option for a revision, a missing path, an excluded path',
    async () => {
      const place = await roots({ '.env': 'x\n' }, { git: true });
      const provider = scriptedChat(
        together(
          tool('git_inspect', { action: 'show', rev: '--output=/tmp/mas-x' }),
          tool('git_inspect', { action: 'blame' }),
          tool('git_inspect', { action: 'diff', path: '.env' }),
          tool('git_inspect', { action: 'diff', extra: '--stat' }),
          tool('git_inspect', { action: 'show', rev: '--ext-diff' }),
          tool('git_inspect', { action: 'diff', path: ':(top).env' }),
        ),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('poke');
      const results = toolResults(provider.requests.at(-1));
      expect(results.slice(0, 2).join('\n')).toContain('arguments do not match');
      expect(results[2]).toContain('outside the readable repository');
      expect(results[3]).toContain('arguments do not match');
      // An option as a revision, and pathspec magic as a path: refused by the arguments or by the
      // Executor, whichever sees it first, and git never runs.
      expect(results[4]).toMatch(/arguments do not match|outside the readable repository/u);
      expect(results[5]).toMatch(/arguments do not match|outside the readable repository/u);
      expect(await exists('/tmp/mas-x')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'says so when the directory is not a git repository',
    async () => {
      const place = await roots();
      const provider = scriptedChat(tool('git_inspect', { action: 'status' }), reply('done'));
      const chat = await chatOn(place, provider);
      await chat.say('status');
      expect(lastResult(provider)).toContain('not a git repository');
    },
    TIMEOUT,
  );
});

// ------------------------------------------------------------------------------------------------

real('memory pressure', () => {
  /** A memory reading the test controls. */
  function memory() {
    const state = { ratio: 0.1 };
    const sample = (): MemorySample => ({ rssBytes: 1, rssRatio: state.ratio, heapRatio: 0 });
    return { state, sample };
  }
  const fast = kernel({
    memory: { sampleIntervalMs: 20, warningRatio: 0.75, dangerRatio: 0.9 },
    cancelGraceMs: 400,
    killGraceMs: 400,
  });

  it(
    'WARNING takes the run to its wrap-up: the next tool is refused, the model is told, the user too',
    async () => {
      const place = await roots();
      const gauge = memory();
      const provider = scriptedChat(
        run('sleep 0.6; echo first'),
        run('echo second'),
        reply('stopped early because memory is short'),
      );
      const chat = await chatOn(place, provider, {
        memorySample: gauge.sample,
        configure: fast,
        // The pressure rises while the first command runs.
        answer: () => {
          gauge.state.ratio = 0.8;
          return 'y';
        },
      });
      await chat.say('work');
      const results = toolResults(provider.requests.at(-1));
      expect(results[0]).toContain('first');
      expect(results[1]).toContain('used up its tools');
      expect(
        provider.requests
          .at(-1)
          ?.messages.map((m) => textOf(m))
          .join('\n'),
      ).toContain('the system is short of memory');
      expect(chat.printed('NOTICE').join('\n')).toContain('系统内存紧张');
      // The second command never ran.
      expect(seen(provider)).not.toContain('second\n');
    },
    TIMEOUT,
  );

  it(
    'WARNING also refuses to start new work, and the next message gets no model call',
    async () => {
      const place = await roots();
      const gauge = memory();
      const provider = scriptedChat(reply('first answer'), reply('must not be asked'));
      const chat = await chatOn(place, provider, { memorySample: gauge.sample, configure: fast });
      await chat.say('hello');
      gauge.state.ratio = 0.8;
      await nap(200);
      await sayAndSettle(chat, 'and another', 800);
      expect(provider.requests).toHaveLength(1);
    },
    TIMEOUT,
  );

  /** The records of memory events the Kernel keeps for the whole system. */
  const eventsOf = async (dataDir: string) =>
    (await readFile(join(dataDir, 'kernel-core', 'memory-events.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { source: string; level: string });
  /** Waits until the sampler has seen the reading (a few of its intervals). */
  const sampled = () => nap(150);

  it(
    'DANGER between two messages is told and recorded, and the conversation goes on with the next message',
    async () => {
      const place = await roots();
      const gauge = memory();
      const provider = scriptedChat(
        reply('first answer'),
        reply('second answer, after the pressure'),
      );
      const chat = await chatOn(place, provider, { memorySample: gauge.sample, configure: fast });
      await chat.say('hello');
      gauge.state.ratio = 0.95;
      await until(
        () => chat.printed('NOTICE').join('\n').includes('本程序的内存危险'),
        'the notice of DANGER',
      );
      // The program is still there: nothing exited, nothing hangs.
      expect(await Promise.race([chat.done, nap(400).then(() => 'open' as const)])).toBe('open');
      expect(await eventsOf(place.dataDir)).toContainEqual(
        expect.objectContaining({ source: 'PROCESS', level: 'DANGER' }),
      );

      // While the process is short the next message is refused, with the reason, without a model call.
      await sayAndSettle(chat, 'too soon', 800);
      expect(provider.requests).toHaveLength(1);

      // Once memory has fallen, the next message starts a new Turn and gets its answer.
      gauge.state.ratio = 0.1;
      await sampled();
      await chat.say('and now');
      expect(provider.requests).toHaveLength(2);
      expect(chat.printed('REPLY').join('\n')).toContain('second answer, after the pressure');
    },
    TIMEOUT,
  );

  it(
    'DANGER with no conversation open is told and recorded too, and the program stays',
    async () => {
      const place = await roots();
      const gauge = memory();
      const chat = await chatOn(place, scriptedChat(reply('hello back')), {
        memorySample: gauge.sample,
        configure: fast,
      });
      await until(() => chat.printed('NOTICE').length > 0, 'the welcome');
      gauge.state.ratio = 0.95;
      await until(
        () => chat.printed('NOTICE').join('\n').includes('本程序的内存危险'),
        'the notice of DANGER',
      );
      expect(await Promise.race([chat.done, nap(400).then(() => 'open' as const)])).toBe('open');
      expect(await eventsOf(place.dataDir)).toContainEqual(
        expect.objectContaining({ source: 'PROCESS', level: 'DANGER' }),
      );
      gauge.state.ratio = 0.1;
      await sampled();
      await chat.say('hello');
      expect(chat.printed('REPLY').join('\n')).toContain('hello back');
    },
    TIMEOUT,
  );

  it(
    'DANGER interrupts the run: the command is stopped, the log is whole, and the next prompt starts a new Turn',
    async () => {
      const place = await roots();
      const gauge = memory();
      const marker = join(place.repository, 'runs');
      const provider = scriptedChat(
        run(`echo started >> runs; sleep 30`),
        reply('fresh start after the interruption'),
      );
      const chat = await chatOn(place, provider, {
        memorySample: gauge.sample,
        configure: fast,
        answer: () => {
          setTimeout(() => (gauge.state.ratio = 0.95), 700);
          return 'y';
        },
      });
      const started = Date.now();
      await chat.console.submit('long job');
      await until(
        () => chat.printed('ERROR').join('\n').includes('系统内存紧张，运行被中断'),
        'the reply that says the run was interrupted',
        20_000,
      );
      expect(Date.now() - started).toBeLessThan(20_000);
      // The program did not leave.
      expect(await Promise.race([chat.done, nap(300).then(() => 'open' as const)])).toBe('open');
      const log = await logOf(place.dataDir);
      expect(log).toContain('RUN_INTERRUPTED');
      expect(log).toContain('"closeReason":"INTERRUPTED"');
      // The last line of the log is a whole record: nothing is cut in the middle.
      for (const line of log.trim().split('\n'))
        expect(() => {
          JSON.parse(line);
        }).not.toThrow();
      expect(chat.printed('NOTICE').join('\n')).toContain('本程序的内存危险');
      expect(chat.printed('NOTICE').join('\n')).toContain('可以直接重新输入');
      expect(await eventsOf(place.dataDir)).toContainEqual(
        expect.objectContaining({ source: 'PROCESS', level: 'DANGER' }),
      );
      expect(provider.requests).toHaveLength(1);

      // The user types again once memory is back: a new Turn, not a hang, and the job did not rerun.
      gauge.state.ratio = 0.1;
      await sampled();
      await chat.say('carry on');
      expect(chat.printed('REPLY').join('\n')).toContain('fresh start after the interruption');
      expect(seen(provider)).toContain('ran short of memory');
      // The history the provider got holds every call once and answers each once, as it demands.
      const messages = provider.requests.at(-1)?.messages ?? [];
      const calls = messages.flatMap((m) => m.tool_calls?.map((call) => call.id) ?? []).sort();
      const answers = messages
        .filter((m) => m.role === 'tool')
        .map((m) => m.tool_call_id)
        .sort();
      expect(calls.length).toBeGreaterThan(0);
      expect(answers).toEqual(calls);
      expect((await readFile(marker, 'utf8')).trim().split('\n')).toEqual(['started']);
    },
    TIMEOUT,
  );

  it(
    'the machine running short is told and recorded, and changes nothing: the tools still run',
    async () => {
      const place = await roots();
      const provider = scriptedChat(run('echo still works'), reply('done'));
      const chat = await chatOn(place, provider, {
        memorySample: () => ({ rssBytes: 1, rssRatio: 0.1, heapRatio: 0, systemRatio: 0.97 }),
        configure: fast,
      });
      await until(
        () => chat.printed('NOTICE').join('\n').includes('整机内存紧张'),
        'the notice of the machine',
      );
      await chat.say('work');
      expect(lastResult(provider)).toContain('still works');
      expect(chat.printed('NOTICE').join('\n')).not.toContain('提前收尾');
      expect(await logOf(place.dataDir)).not.toContain('MEMORY_LIMIT');
      expect(await eventsOf(place.dataDir)).toEqual([
        expect.objectContaining({ source: 'SYSTEM', level: 'WARNING' }),
      ]);
    },
    TIMEOUT,
  );
});

// ------------------------------------------------------------------------------------------------

real('the round limit', () => {
  it('the last round is the final call, warned about before, and its reply is shown as an early end', async () => {
    const place = await roots();
    // This drives the real limit of main (80 rounds) with cheap rounds: 79 working rounds, then
    // the 80th is the final call.
    const turns = Array.from({ length: 79 }, (_, index) => run(`echo round-${String(index)}`));
    const provider = scriptedChat(
      ...turns,
      reply('stopping; prompt to continue: "carry on from round 78"'),
    );
    // One question for the prefix `echo`, then the allowance covers every later round.
    const chat = await chatOn(place, provider, { answer: () => 'p' });
    await chat.say('many rounds').catch(() => undefined);
    const statuses = provider.requests.map((request) => textOf(request.messages.at(-1)));
    expect(statuses.some((text) => text.includes('the round limit is near'))).toBe(true);
    const last = statuses.at(-1) ?? '';
    expect(last).toContain('final call');
    expect(last).toContain('the next prompt the user could send');
    expect(provider.requests.length).toBeLessThanOrEqual(80);
    expect(chat.printed('NOTICE').join('\n')).toContain('轮次到了上限');
  }, 240_000);
});
