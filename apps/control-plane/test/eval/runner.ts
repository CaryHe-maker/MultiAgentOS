/**
 * Runs one task once (docs/M2/Evaluation.md 3): builds the repository, starts the whole product,
 * drives it the way the task says, reads the Session log, and judges. A task with a scripted
 * provider runs offline; one without runs against the real model and spends the request budget.
 */
import { cp, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ModelDefinition } from '@multiagentos/contracts';
import {
  openChat,
  textOf,
  until,
  type Chat,
  type ChatRequest,
  type ScriptedChat,
} from '../acceptance/chat-driver.js';
import { parseCli, runCommand } from '@multiagentos/cli';
import { composeSystem } from '../../src/bootstrap/compose-system.js';
import { defaultSystemConfig } from '../../src/config/system-config.js';
import { answeringTerminal } from '../system/analyze-template/harness.js';
import { metricsOf } from './metrics.js';
import type { Check, ChatStep, Observation, RunRecord, TaskSpec } from './spec.js';

/** Requests the whole invocation may still send to the real provider. */
export interface RequestBudget {
  remaining: number;
}

export interface RunnerEnv {
  readonly version: RunRecord['version'];
  readonly model: { readonly id: string; readonly pricing?: ModelDefinition['pricing'] };
  /** The key of the real provider; a task without a scripted provider needs it. */
  readonly apiKey?: string;
  readonly budget?: RequestBudget;
  /** How long one step may take; real runs need minutes. */
  readonly stepTimeoutMs?: number;
}

const realFetch = globalThis.fetch;

function realProvider(env: RunnerEnv): ScriptedChat {
  const requests: ChatRequest[] = [];
  return {
    requests,
    add: () => undefined,
    fetch: (input, init) => {
      if (env.budget !== undefined) {
        if (env.budget.remaining <= 0) throw new Error('the request budget is spent');
        env.budget.remaining -= 1;
      }
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ChatRequest);
      return realFetch(input, init);
    },
  };
}

async function drive(
  chat: Chat,
  steps: readonly ChatStep[],
  timeoutMs: number,
  /** `{OTHER}` in what the user types is a folder next to the repository, outside it. */
  other: string,
): Promise<string | undefined> {
  const typed = (text: string) => text.replaceAll('{OTHER}', other);
  const awaiting = () => chat.lives.at(-1)?.status.includes('等待输入') === true;
  try {
    for (const step of steps) {
      if ('say' in step) {
        const before = chat.printed('REPLY').length;
        await chat.console.submit(typed(step.say));
        await until(
          () => chat.printed('REPLY').length > before,
          `a reply to "${step.say}"`,
          timeoutMs,
        );
      } else if ('submit' in step) {
        await chat.console.submit(typed(step.submit));
      } else if ('awaitInput' in step) {
        await until(awaiting, 'the run to wait for input', timeoutMs);
      } else if ('run' in step) {
        throw new Error('a run step belongs to a mission task');
      } else {
        await until(
          () =>
            step.waitFor({
              printed: (kind) => chat.printed(kind as 'REPLY'),
              questions: chat.questions,
            }),
          step.what,
          timeoutMs,
        );
      }
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'unknown error';
  }
}

interface MissionRun {
  readonly error?: string;
  readonly exitCode?: number;
  readonly printed: (kind: string) => readonly string[];
  readonly questions: readonly string[];
}

/**
 * Mission mode: `mas run "<goal>"` as the CLI starts it, every question of authorization answered
 * yes, waited for until the run ends or `timeoutMs` passes.
 */
async function runMission(
  spec: TaskSpec,
  provider: ScriptedChat,
  env: RunnerEnv,
  places: { readonly dataDir: string; readonly repository: string },
  timeoutMs: number,
  scripted: boolean,
): Promise<MissionRun> {
  const step = spec.steps.find((each): each is Extract<ChatStep, { run: string }> => 'run' in each);
  if (step === undefined) throw new Error(`mission task ${spec.id} has no run step`);
  const terminal = answeringTerminal();
  const lines = () => terminal.written.join('').split('\n');
  const printed = (kind: string) =>
    lines()
      .filter((line) => line.startsWith(`${kind}: `))
      .map((line) => line.slice(kind.length + 2));
  const questions = () => printed('QUESTION');
  const original = globalThis.fetch;
  globalThis.fetch = provider.fetch;
  let system: Awaited<ReturnType<typeof composeSystem>>;
  let command: Parameters<typeof runCommand>[0];
  try {
    const parsed = await parseCli(
      [
        'run',
        '--repo',
        places.repository,
        ...(step.template === undefined ? [] : [step.template]),
        step.run,
      ],
      (text) => void terminal.written.push(text),
    );
    if (!parsed.ok || parsed.command.kind !== 'RUN') throw new Error('the CLI refused the run');
    command = parsed.command;
    system = await composeSystem({
      config: (spec.setup?.configure ?? ((each) => each))({
        ...defaultSystemConfig(),
        dataDir: places.dataDir,
      }),
      repositoryRoot: await realpath(places.repository),
      preset: spec.setup?.preset ?? 'standard',
      view: terminal.view,
      credentials: scripted
        ? { apiKeyFor: () => 'sk-acceptance-offline-key-0000' }
        : { apiKeyFor: () => env.apiKey },
      log: (line) => void terminal.written.push(line),
    });
  } finally {
    globalThis.fetch = original;
  }
  await system.start();
  const template = system.templateRef(command.kind === 'RUN' ? command.template : 'mission');
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
  });
  const finished = system.run((console) => runCommand(command, console, terminal, template));
  const outcome = await Promise.race([finished, timedOut]);
  clearTimeout(timer);
  if (outcome === 'TIMEOUT') {
    await system.shutdown().catch(() => undefined);
    await finished.catch(() => undefined);
    return {
      error: `the run did not end within ${String(timeoutMs / 60_000)} minutes`,
      printed,
      questions: questions(),
    };
  }
  return { exitCode: outcome, printed, questions: questions() };
}

async function readLog(dataDir: string): Promise<Record<string, unknown>[]> {
  const [id] = await readdir(join(dataDir, 'sessions')).catch(() => [] as string[]);
  if (id === undefined) return [];
  const text = await readFile(
    join(dataDir, 'sessions', id, 'workflow', 'log.v1.jsonl'),
    'utf8',
  ).catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function runTask(spec: TaskSpec, run: number, env: RunnerEnv): Promise<RunRecord> {
  const scripted = spec.scripted?.();
  if (scripted === undefined && env.apiKey === undefined)
    throw new Error(`task ${spec.id} runs on the real model and needs a key`);
  const provider = scripted ?? realProvider(env);
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-eval-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-eval-repo-'));
  const started = Date.now();
  let chat: Chat | undefined;
  let error: string | undefined;
  try {
    await spec.fixture(repository);
    if (spec.mode === 'mission') {
      const ran = await runMission(
        spec,
        provider,
        env,
        { dataDir, repository },
        env.stepTimeoutMs ?? (scripted === undefined ? 2_400_000 : 60_000),
        scripted !== undefined,
      );
      return await recordOf(spec, run, env, started, scripted !== undefined, provider, {
        repository,
        dataDir,
        printed: ran.printed,
        questions: ran.questions,
        ...(ran.error === undefined ? {} : { error: ran.error }),
        ...(ran.exitCode === undefined ? {} : { exitCode: ran.exitCode }),
      });
    }
    chat = await openChat({
      dataDir,
      repository,
      provider,
      ...(spec.answer === undefined ? {} : { answer: spec.answer }),
      ...(spec.setup ?? {}),
      ...(scripted === undefined ? { credentials: { apiKeyFor: () => env.apiKey } } : {}),
    });
    error = await drive(
      chat,
      spec.steps,
      env.stepTimeoutMs ?? (scripted === undefined ? 300_000 : 15_000),
      `${repository}-other`,
    );
    const opened = chat;
    return await recordOf(spec, run, env, started, scripted !== undefined, provider, {
      repository,
      dataDir,
      printed: (kind) => opened.printed(kind as 'REPLY'),
      questions: opened.questions,
      ...(error === undefined ? {} : { error }),
    });
  } finally {
    await chat?.close().catch(() => undefined);
    // Kept for the person who reads a failure: the Session (its log) and the repository as left.
    const archive = process.env['EVAL_ARCHIVE'];
    if (archive !== undefined && archive !== '') {
      const into = join(archive, `${spec.id}-r${String(run)}-${String(started)}`);
      await cp(join(dataDir, 'sessions'), join(into, 'sessions'), { recursive: true }).catch(
        () => undefined,
      );
      // What the log points to: model outputs (messages, plans, tool arguments) and tool results.
      await cp(join(dataDir, 'artifacts'), join(into, 'artifacts'), { recursive: true }).catch(
        () => undefined,
      );
      await cp(repository, join(into, 'repository'), { recursive: true }).catch(() => undefined);
    }
    await rm(dataDir, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
    await rm(`${repository}-other`, { recursive: true, force: true });
  }
}

/** Reads the log, judges and measures: the same for every mode. */
async function recordOf(
  spec: TaskSpec,
  run: number,
  env: RunnerEnv,
  started: number,
  scripted: boolean,
  provider: ScriptedChat,
  seen: Omit<Observation, 'log' | 'requests'>,
): Promise<RunRecord> {
  const log = await readLog(seen.dataDir);
  const observation: Observation = {
    ...seen,
    requests: provider.requests.map((request) => ({
      messages: request.messages.map((message) => textOf(message)),
      tools: (request.tools ?? []).map((tool) => tool.function.name),
    })),
    log,
  };
  let checks: readonly Check[];
  try {
    checks = await spec.judge(observation);
  } catch (judged) {
    checks = [
      {
        name: 'the judge ran',
        angle: 'OUTCOME',
        ok: false,
        detail: judged instanceof Error ? judged.message : 'unknown error',
      },
    ];
  }
  const metrics = metricsOf(log, {
    ...(env.model.pricing === undefined ? {} : { model: { pricing: env.model.pricing } }),
    authorizationQuestions: seen.questions.length,
  });
  const { error } = seen;
  return {
    schema: 1,
    taskId: spec.id,
    mode: spec.mode,
    tags: spec.tags,
    run,
    at: new Date(started).toISOString(),
    version: env.version,
    model: env.model.id,
    provider: scripted ? 'scripted' : 'real',
    ok: error === undefined && checks.every((check) => check.ok),
    checks,
    metrics,
    elapsedMs: Date.now() - started,
    ...(error === undefined ? {} : { error }),
  };
}

/** A digest of the commit and of every definition file, so that two records say what they ran. */
export async function versionOf(
  repositoryRoot: string,
  definitionsDirectory: string,
): Promise<RunRecord['version']> {
  const head = (
    await readFile(join(repositoryRoot, '.git', 'HEAD'), 'utf8').catch(() => '')
  ).trim();
  let commit = head;
  if (head.startsWith('ref: ')) {
    commit = (
      await readFile(join(repositoryRoot, '.git', head.slice(5)), 'utf8').catch(async () => {
        const packed = await readFile(join(repositoryRoot, '.git', 'packed-refs'), 'utf8').catch(
          () => '',
        );
        return (
          packed
            .split('\n')
            .find((line) => line.endsWith(head.slice(5)))
            ?.split(' ')[0] ?? ''
        );
      })
    ).trim();
  }
  const hash = createHash('sha256');
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        hash.update(path.slice(definitionsDirectory.length).replaceAll('\\', '/'));
        hash.update(await readFile(path));
      }
    }
  };
  await walk(definitionsDirectory);
  return { commit: commit.slice(0, 12) || 'unknown', definitions: hash.digest('hex').slice(0, 16) };
}
