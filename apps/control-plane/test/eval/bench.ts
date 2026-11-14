/**
 * Runs one instruction on the real model in an existing folder, the way a task of a public test
 * set is run (docs/M2/Phase1TaskSet.md): the folder is the workspace, nobody answers for the
 * user except the harness, which allows every question of authorization and tells the Agent that
 * nobody is there to answer its own.
 *
 *   tsx apps/control-plane/test/eval/bench.ts --repo <dir> --instruction-file <file> --out <file>
 *       [--task <id>] [--timeout-sec 900] [--model deepseek-flash] [--budget 400] [--log-dir <dir>]
 *       [--mode chat|mission]
 *
 * `--mode mission` runs the instruction as `mas run "<instruction>"` (the built-in template
 * mission) instead of one message of a conversation; questions are answered the same way.
 *
 * One line of JSON is appended to `--out`: how it ended, the time, and the figures of the log. The
 * key comes from `DEEPSEEK_API_KEY` or the file named by `MAO_ENV_FILE`, and is never written down.
 */
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import dotenv from 'dotenv';
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
} from '@multiagentos/agent-tool-pool';
import { parseCli, runCommand } from '@multiagentos/cli';
import type { SystemConfig } from '@multiagentos/contracts';
import type { ConsoleView } from '@multiagentos/user-interaction';
import { composeSystem } from '../../src/bootstrap/compose-system.js';
import { defaultSystemConfig } from '../../src/config/system-config.js';
import { openChat, until, type ChatRequest, type ScriptedChat } from '../acceptance/chat-driver.js';
import { metricsOf } from './metrics.js';
import { versionOf } from './runner.js';

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
};
const need = (name: string): string => {
  const value = arg(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

/** What the harness says when the Agent asks the user something: nobody is there. */
const NOBODY =
  'Nobody is available to answer. Decide yourself with the information you have and carry on.';

const realFetch = globalThis.fetch;

/** One line per model request: where the characters of the prompt are (not the content itself). */
function profileOf(request: ChatRequest, index: number): string {
  const body = request as unknown as {
    messages?: {
      role: string;
      content?: unknown;
      reasoning_content?: string;
      tool_call_id?: string;
      tool_calls?: { id: string; function?: { name?: string } }[];
    }[];
    tools?: unknown;
  };
  const size = (value: unknown): number =>
    typeof value === 'string'
      ? value.length
      : value === undefined
        ? 0
        : JSON.stringify(value).length;
  const names = new Map<string, string>();
  const byRole: Record<string, number> = {};
  let reasoning = 0;
  const results: { tool: string; chars: number }[] = [];
  for (const message of body.messages ?? []) {
    byRole[message.role] = (byRole[message.role] ?? 0) + size(message.content);
    reasoning += size(message.reasoning_content);
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function?.name ?? '?');
    if (message.role === 'tool')
      results.push({
        tool: names.get(message.tool_call_id ?? '') ?? '?',
        chars: size(message.content),
      });
  }
  results.sort((a, b) => b.chars - a.chars);
  const toolByName: Record<string, number> = {};
  for (const result of results)
    toolByName[result.tool] = (toolByName[result.tool] ?? 0) + result.chars;
  return JSON.stringify({
    toolByName,
    i: index,
    messages: body.messages?.length ?? 0,
    toolsChars: size(body.tools),
    byRole,
    reasoningChars: reasoning,
    toolResultTop: results.slice(0, 3),
  });
}

/** What a run left on the screen: the questions it asked and the lines it printed. */
interface Seen {
  readonly questions: readonly string[];
  printed(kind: string): readonly string[];
}

/**
 * `mas run "<instruction>"` as the CLI starts it: authorization and the offer to continue are
 * answered yes, a question of the Agent with `NOBODY`; waited for until the run ends.
 */
async function runMission(
  options: {
    readonly dataDir: string;
    readonly repository: string;
    readonly provider: ScriptedChat;
    readonly apiKey: string;
    readonly configure: (config: SystemConfig) => SystemConfig;
    readonly instruction: string;
  },
  timeoutMs: number,
  onNobody: () => void,
): Promise<Seen & { readonly error?: string }> {
  const records: { kind: string; text: string }[] = [];
  const questions: string[] = [];
  let submit: ((text: string) => Promise<void>) | undefined;
  let asked: string | undefined;
  const view: ConsoleView = {
    print: (record) => void records.push({ kind: record.kind, text: record.text }),
    update: (live) => {
      const pending = live.pending;
      const text = pending?.text;
      if (pending !== undefined && text !== asked && submit !== undefined) {
        if (pending.kind === 'QUESTION') {
          onNobody();
          void submit(NOBODY);
        } else {
          if (pending.kind === 'AUTHORIZATION') questions.push(text ?? '');
          void submit('y');
        }
      }
      asked = text;
    },
    restoreInput: () => undefined,
  };
  const terminal = {
    view,
    attach: (input: { submit(text: string): Promise<void> }) => {
      submit = (text) => input.submit(text);
      return () => {
        submit = undefined;
      };
    },
  };
  const seen = {
    questions,
    printed: (kind: string) =>
      records.filter((each) => each.kind === kind).map((each) => each.text),
  };
  const parsed = await parseCli(
    ['run', '--repo', options.repository, options.instruction],
    () => undefined,
  );
  if (!parsed.ok || parsed.command.kind !== 'RUN')
    return { ...seen, error: 'the CLI refused the run' };
  const original = globalThis.fetch;
  globalThis.fetch = options.provider.fetch;
  let system: Awaited<ReturnType<typeof composeSystem>>;
  try {
    system = await composeSystem({
      config: options.configure({ ...defaultSystemConfig(), dataDir: options.dataDir }),
      repositoryRoot: await realpath(options.repository),
      preset: 'standard',
      view,
      credentials: { apiKeyFor: () => options.apiKey },
      log: () => undefined,
    });
  } finally {
    globalThis.fetch = original;
  }
  await system.start();
  const template = system.templateRef('mission');
  const { command } = parsed;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'TIMEOUT'>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout('TIMEOUT'), timeoutMs);
  });
  const finished = system.run((console) => runCommand(command, console, terminal, template));
  const ended = await Promise.race([finished, timedOut]);
  clearTimeout(timer);
  if (ended === 'TIMEOUT') {
    await system.shutdown().catch(() => undefined);
    await finished.catch(() => undefined);
    return { ...seen, error: `timed out after ${String(timeoutMs / 1000)} s` };
  }
  return ended === 0 ? seen : { ...seen, error: `mas run exited ${String(ended)}` };
}

async function main(): Promise<void> {
  const repository = resolve(need('--repo'));
  const instruction = await readFile(need('--instruction-file'), 'utf8');
  const out = need('--out');
  const timeoutMs = Number(arg('--timeout-sec', '900')) * 1000;
  const budgetLimit = Number(arg('--budget', '600'));
  const modelId = arg('--model', 'deepseek-flash') ?? 'deepseek-flash';
  // `MAS_MODE` lets scripts/taskset/agentrun.mjs, which passes MAS_* variables on, choose it too.
  const mode = arg('--mode', process.env['MAS_MODE'] ?? 'chat') === 'mission' ? 'mission' : 'chat';
  dotenv.config({ path: process.env['MAO_ENV_FILE'] ?? '.env', quiet: true });
  const apiKey = (process.env['DEEPSEEK_API_KEY'] ?? '').trim();
  if (apiKey === '') throw new Error('DEEPSEEK_API_KEY is not set');

  const catalog = await DefinitionCatalog.load(
    new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
  );
  const definition = catalog.latest('MODEL', modelId);
  const pricing = definition?.kind === 'MODEL' ? definition.pricing : undefined;
  const version = await versionOf(resolve('.'), DEFAULT_DEFINITIONS_DIRECTORY);

  // Experiment overrides (docs/M2/experiments.md writes down which one a run used).
  const numberEnv = (name: string): number | undefined => {
    const value = process.env[name];
    return value === undefined || value === '' ? undefined : Number(value);
  };
  const previewBytes = numberEnv('MAS_COMMAND_PREVIEW_BYTES');
  const previewLines = numberEnv('MAS_COMMAND_PREVIEW_LINES');
  const overrides = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith('MAS_')),
  );

  let remaining = budgetLimit;
  const requests: ChatRequest[] = [];
  const provider: ScriptedChat = {
    requests,
    add: () => undefined,
    fetch: (input, init) => {
      if (remaining <= 0) throw new Error('the request budget is spent');
      remaining -= 1;
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ChatRequest);
      return realFetch(input, init);
    },
  };

  const dataDir = await mkdtemp(join(tmpdir(), 'mas-bench-data-'));
  const started = Date.now();
  let error: string | undefined;
  let outcome: 'DONE' | 'TIMEOUT' | 'ERROR' = 'DONE';
  let nobodyAnswered = 0;
  // Containers have no user namespaces for bubblewrap: the container is the isolation, so a command
  // runs after the question of authorization (which the harness allows), as it is.
  const configure = (config: SystemConfig): SystemConfig => ({
    ...config,
    kernel: {
      ...config.kernel,
      sandbox: { ...config.kernel.sandbox, unavailable: 'ask-unisolated' },
      ...(previewBytes === undefined && previewLines === undefined
        ? {}
        : {
            executionLimits: {
              ...config.kernel.executionLimits,
              COMMAND: {
                ...config.kernel.executionLimits.COMMAND,
                ...(previewBytes === undefined ? {} : { previewMaxBytes: previewBytes }),
                ...(previewLines === undefined ? {} : { previewMaxLines: previewLines }),
              },
            },
          }),
    },
  });
  let seen: Seen;
  if (mode === 'mission') {
    const mission = await runMission(
      { dataDir, repository, provider, apiKey, configure, instruction },
      timeoutMs,
      () => (nobodyAnswered += 1),
    );
    seen = mission;
    if (mission.error !== undefined) {
      outcome = mission.error.startsWith('timed out') ? 'TIMEOUT' : 'ERROR';
      error = mission.error;
    }
  } else {
    const chat = await openChat({
      dataDir,
      repository,
      provider,
      credentials: { apiKeyFor: () => apiKey },
      configure,
    });
    seen = chat;
    try {
      const before = chat.printed('REPLY').length;
      await chat.console.submit(instruction);
      let continued = 0;
      await until(
        () => {
          const live = chat.lives.at(-1);
          const pending = live?.pending;
          if (pending?.kind === 'QUESTION') {
            nobodyAnswered += 1;
            void chat.console.submit(NOBODY);
          } else if (pending?.kind === 'CONTINUE' && continued < 3) {
            continued += 1;
            void chat.console.submit('y');
          }
          return (
            chat.printed('REPLY').length > before &&
            live?.status.includes('等待输入') === true &&
            pending === undefined
          );
        },
        'the run to finish',
        timeoutMs,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'unknown error';
      outcome = message.startsWith('timed out') ? 'TIMEOUT' : 'ERROR';
      error = message;
    }
  }
  const [sessionId] = await readdir(join(dataDir, 'sessions')).catch(() => [] as string[]);
  const logFile =
    sessionId === undefined
      ? undefined
      : join(dataDir, 'sessions', sessionId, 'workflow', 'log.v1.jsonl');
  const log = (await readFile(logFile ?? '', 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const metrics = metricsOf(log, {
    ...(pricing === undefined ? {} : { model: { pricing } }),
    authorizationQuestions: seen.questions.length,
  });
  const record = {
    schema: 1,
    system: 'mas',
    task: arg('--task', repository),
    at: new Date(started).toISOString(),
    version,
    model: modelId,
    overrides,
    outcome,
    elapsedMs: Date.now() - started,
    timeoutMs,
    requests: requests.length,
    nobodyAnswered,
    mode,
    replies: seen.printed('REPLY').slice(-1),
    errorsPrinted: seen.printed('ERROR').slice(0, 5),
    metrics,
    ...(error === undefined ? {} : { error }),
  };
  await mkdir(dirname(out), { recursive: true });
  await appendFile(out, `${JSON.stringify(record)}\n`);
  const logDir = arg('--log-dir');
  if (logDir !== undefined) {
    await mkdir(logDir, { recursive: true });
    await writeFile(
      join(logDir, 'request-profile.jsonl'),
      requests.map(profileOf).join('\n') + '\n',
    );
  }
  if (logDir !== undefined && logFile !== undefined) {
    await copyFile(logFile, join(logDir, 'session-log.jsonl')).catch(() => undefined);
  }
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}

await main().catch((caught: unknown) => {
  process.stderr.write(`${caught instanceof Error ? caught.message : String(caught)}\n`);
  process.exit(1);
});
