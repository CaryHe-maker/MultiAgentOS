/**
 * Runs one instruction on the real model in an existing folder, the way a task of a public test
 * set is run (docs/M2/Phase1TaskSet.md): the folder is the workspace, nobody answers for the
 * user except the harness, which allows every question of authorization and tells the Agent that
 * nobody is there to answer its own.
 *
 *   tsx apps/control-plane/test/eval/bench.ts --repo <dir> --instruction-file <file> --out <file>
 *       [--task <id>] [--timeout-sec 900] [--model deepseek-flash] [--budget 400] [--log-dir <dir>]
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

async function main(): Promise<void> {
  const repository = resolve(need('--repo'));
  const instruction = await readFile(need('--instruction-file'), 'utf8');
  const out = need('--out');
  const timeoutMs = Number(arg('--timeout-sec', '900')) * 1000;
  const budgetLimit = Number(arg('--budget', '600'));
  const modelId = arg('--model', 'deepseek-flash') ?? 'deepseek-flash';
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
  const chat = await openChat({
    dataDir,
    repository,
    provider,
    credentials: { apiKeyFor: () => apiKey },
    configure: (config) => ({
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
    }),
  });
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
    authorizationQuestions: chat.questions.length,
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
    replies: chat.printed('REPLY').slice(-1),
    errorsPrinted: chat.printed('ERROR').slice(0, 5),
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
