/**
 * Runs one task once (docs/M2/Evaluation.md 3): builds the repository, starts the whole product,
 * drives it the way the task says, reads the Session log, and judges. A task with a scripted
 * provider runs offline; one without runs against the real model and spends the request budget.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
    const log = await readLog(dataDir);
    const opened = chat;
    const observation: Observation = {
      repository,
      dataDir,
      printed: (kind) => opened.printed(kind as 'REPLY'),
      questions: opened.questions,
      requests: provider.requests.map((request) => ({
        messages: request.messages.map((message) => textOf(message)),
        tools: (request.tools ?? []).map((tool) => tool.function.name),
      })),
      log,
      ...(error === undefined ? {} : { error }),
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
      authorizationQuestions: opened.questions.length,
    });
    return {
      schema: 1,
      taskId: spec.id,
      mode: spec.mode,
      tags: spec.tags,
      run,
      at: new Date(started).toISOString(),
      version: env.version,
      model: env.model.id,
      provider: scripted === undefined ? 'real' : 'scripted',
      ok: error === undefined && checks.every((check) => check.ok),
      checks,
      metrics,
      elapsedMs: Date.now() - started,
      ...(error === undefined ? {} : { error }),
    };
  } finally {
    await chat?.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
    await rm(`${repository}-other`, { recursive: true, force: true });
  }
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
