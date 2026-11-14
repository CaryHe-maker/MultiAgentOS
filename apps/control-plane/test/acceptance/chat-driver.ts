/**
 * Drives the whole product in Turn-chat for the deterministic acceptance cases: the
 * real composition, Kernel, Workflow, console and ExecutorSet, with only the provider's HTTP API
 * replaced. It stands where the user stands: it types lines and reads what the console shows.
 */
import { realpath } from 'node:fs/promises';
import type { ExecutorRegistry, SystemConfig, SystemFaultReporter } from '@multiagentos/contracts';
import { createExecutorRegistry, type WebOptions } from '@multiagentos/executor-set';
import { streamedIfAsked } from '@multiagentos/testing';
import type { MemorySample, SandboxProbe, TrackedSubprocessRunner } from '@multiagentos/kernel';
import type {
  Console,
  ConsoleView,
  LiveState,
  TranscriptRecord,
} from '@multiagentos/user-interaction';
import { composeSystem, type System } from '../../src/bootstrap/compose-system.js';
import { defaultSystemConfig } from '../../src/config/system-config.js';
import {
  agentOfTools,
  completionResponse,
  type ScriptedAgent,
  type ScriptedCall,
  type ScriptedTurn,
} from '../support/scripted-model.js';

export type ChatCall = ScriptedCall;

/** One provider answer: tool calls, or text, or a raw response such as a rate limit. */
export type ProviderTurn = ScriptedTurn | { readonly response: () => Response | Promise<Response> };

export const reply = (text: string): ProviderTurn => ({
  calls: [{ name: 'reply', arguments: { text } }],
});
export const tool = (name: string, args: unknown = {}): ProviderTurn => ({
  calls: [{ name, arguments: args }],
});

export interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_calls?: readonly {
    readonly id?: string;
    readonly function: { readonly name: string };
  }[];
  readonly tool_call_id?: string;
}
export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly { readonly function: { readonly name: string } }[];
}

export interface ScriptedChat {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: ChatRequest[];
  /** Asks for the answers after the given ones; a request beyond the script is a failure. */
  add(...turns: readonly ProviderTurn[]): void;
}

let calls = 0;

/** A provider that answers each request with the next turn, and refuses to go off script. */
export function scriptedChat(...turns: readonly ProviderTurn[]): ScriptedChat {
  const queue = [...turns];
  const requests: ChatRequest[] = [];
  return {
    requests,
    add: (...more) => void queue.push(...more),
    fetch: async (_input, init) => {
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ChatRequest);
      const turn = queue.shift();
      if (turn === undefined) throw new Error('a request beyond the script');
      // The product asks for a stream; the script is written once, as whole answers.
      if ('response' in turn) return streamedIfAsked(init, await turn.response());
      calls += 1;
      return streamedIfAsked(init, completionResponse(turn, String(calls)));
    },
  };
}

export const textOf = (message: ChatMessage | undefined): string =>
  typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');

export async function until(condition: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** What the user answers to one question; `hold` leaves it open. */
export type Answer = 'y' | 'n' | 'hold' | '1' | '2' | '3' | 'c' | 'p';

export interface ChatOptions {
  readonly dataDir: string;
  readonly repository: string;
  readonly provider: ScriptedChat;
  readonly answer?: (question: string) => Answer;
  readonly now?: () => Date;
  /** Changes the defaults, for a limit a case must reach. */
  readonly configure?: (config: SystemConfig) => SystemConfig;
  readonly subprocess?: TrackedSubprocessRunner;
  readonly preset?: 'standard' | 'readonly';
  /** Replaces Executors, for a case that needs an Executor to fail in a way a real one cannot. */
  readonly executors?: ExecutorRegistry;
  /** What the web tools reach: a stand-in for DeepSeek's interface and for DNS. */
  readonly web?: WebOptions;
  readonly sandboxProbe?: SandboxProbe;
  readonly memorySample?: () => MemorySample;
  readonly reportSystemFault?: SystemFaultReporter;
  /** A real run's key; scripted runs use a key that goes nowhere. */
  readonly credentials?: { apiKeyFor(provider: string): string | undefined };
}

export interface Chat {
  readonly system: System;
  readonly console: Console;
  readonly records: readonly TranscriptRecord[];
  readonly questions: readonly string[];
  readonly lives: readonly LiveState[];
  readonly restored: readonly (readonly string[])[];
  /** Everything the terminal printed of `kind`. */
  printed(kind: TranscriptRecord['kind']): readonly string[];
  /** Types the answer to the question that is open now. */
  answerOpen(answer: 'y' | 'n'): Promise<void>;
  /** Sends a message and waits for the next reply of the agent. */
  say(text: string): Promise<void>;
  close(): Promise<number>;
  /** The exit code, once the console ended by itself (an interrupt) or was closed. */
  readonly done: Promise<number>;
}

const OFFLINE_KEY = 'sk-acceptance-offline-key-0000';

/** Starts the product on `dataDir`, as `mas` does in an interactive terminal. */
export async function openChat(options: ChatOptions): Promise<Chat> {
  const records: TranscriptRecord[] = [];
  const questions: string[] = [];
  const lives: LiveState[] = [];
  const restored: (readonly string[])[] = [];
  const attached: { console?: Console } = {};
  let asked: string | undefined;
  const view: ConsoleView = {
    print: (record) => void records.push(record),
    update: (live) => {
      lives.push(live);
      const question = live.pending?.kind === 'AUTHORIZATION' ? live.pending.text : undefined;
      if (question !== undefined && question !== asked) {
        questions.push(question);
        const answer = options.answer?.(question) ?? 'y';
        if (answer !== 'hold') queueMicrotask(() => void attached.console?.submit(answer));
      }
      asked = question;
    },
    restoreInput: (messages) => void restored.push(messages),
  };
  // The model-call Executor takes `fetch` when the registry is built (ExecutorSet 7).
  const original = globalThis.fetch;
  globalThis.fetch = options.provider.fetch;
  let system: System;
  try {
    const config = (options.configure ?? ((each) => each))({
      ...defaultSystemConfig(),
      dataDir: options.dataDir,
    });
    system = await composeSystem({
      config,
      repositoryRoot: await realpath(options.repository),
      preset: options.preset ?? 'standard',
      view,
      credentials: options.credentials ?? { apiKeyFor: () => OFFLINE_KEY },
      log: () => undefined,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.subprocess === undefined ? {} : { subprocess: options.subprocess }),
      ...(options.executors !== undefined
        ? { executors: options.executors }
        : options.web === undefined
          ? {}
          : // Built here, while `fetch` is the provider's stand-in: the model-call Executor keeps it.
            {
              executors: createExecutorRegistry({
                web: { config: config.kernel.web, ...options.web },
              }),
            }),
      ...(options.sandboxProbe === undefined ? {} : { sandboxProbe: options.sandboxProbe }),
      ...(options.memorySample === undefined ? {} : { memorySample: options.memorySample }),
      ...(options.reportSystemFault === undefined
        ? {}
        : { reportSystemFault: options.reportSystemFault }),
    });
  } finally {
    globalThis.fetch = original;
  }
  await system.start();
  attached.console = system.console;
  const console = system.console;
  const done = system.run(async (running) => {
    const exited = running.exited();
    await running.start();
    await exited;
    return running.exitCode;
  });
  const replies = () => records.filter((record) => record.kind === 'REPLY').length;
  return {
    system,
    console,
    records,
    questions,
    lives,
    restored,
    printed: (kind) => records.filter((record) => record.kind === kind).map((r) => r.text),
    answerOpen: (answer) => console.submit(answer),
    say: async (text) => {
      const before = replies();
      await console.submit(text);
      await until(() => replies() > before, `a reply to "${text}"`);
    },
    done,
    close: async () => {
      await console.submit('/exit');
      return done;
    },
  };
}

/** Which Agent a request is for, from the tools it offers (M2Design 3.9). */
export function agentOfRequest(request: ChatRequest): ScriptedAgent {
  return agentOfTools(new Set((request.tools ?? []).map((each) => each.function.name)));
}

/**
 * Asks for the list of Sessions and waits until the console has shown it: `/resume <n>` and
 * `/delete <n>` refer to that list, so they must not be typed before it is there.
 */
export async function listSessions(chat: Chat): Promise<void> {
  const before = chat.printed('NOTICE').length;
  await chat.console.submit('/sessions');
  await until(() => chat.printed('NOTICE').length > before, 'the list of Sessions');
}

/** A turn that is answered only after `wait` has settled: two Agents can be made to overlap. */
export type RoutedTurn =
  ProviderTurn | { readonly wait: Promise<unknown>; readonly then: ProviderTurn };

/**
 * A provider with one script per Agent, for runs where several AgentRuns ask at once: a request
 * is answered from the queue of the Agent it is for, so the order between Agents does not matter.
 */
export function scriptedAgents(
  scripts: Readonly<
    Partial<Record<'main' | 'lead' | 'explorer' | 'worker' | 'summary', readonly RoutedTurn[]>>
  >,
  /** Worker scripts by task, for a case where two workers say different things. */
  tasks: Readonly<Record<string, readonly RoutedTurn[]>> = {},
): ScriptedChat {
  const queues = new Map(
    Object.entries(scripts).map(([agent, turns]) => [agent, [...(turns ?? [])]]),
  );
  const byTask = new Map(Object.entries(tasks).map(([task, turns]) => [task, [...turns]]));
  const requests: ChatRequest[] = [];
  const inner = scriptedChat();
  return {
    requests,
    add: (...more) => void queues.get('main')?.push(...more),
    fetch: async (input, init) => {
      const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ChatRequest;
      requests.push(request);
      // A request for a summary of the history (a compaction) has its own queue, when there is one.
      // In prefix form the instruction ends the history, in text form it is inside the transcript.
      const asksSummary = request.messages.some((message) =>
        textOf(message).includes('Use exactly these sections'),
      );
      const agent = asksSummary && queues.has('summary') ? 'summary' : agentOfRequest(request);
      // A task is known by the first user message that carries its name.
      const first = textOf(request.messages.find((message) => message.role === 'user'));
      // A task that inherits a context (D35) is told who it is by the answer to the call that
      // started it, after the history of the task it comes from.
      const all = request.messages.map((message) => textOf(message)).join('\n');
      const task =
        [...byTask.keys()].find((name) => all.includes(`you are a different task: "${name}"`)) ??
        [...byTask.keys()].find((name) => first.includes(`Your task (${name},`));
      const key = task ?? agent;
      const turn = (task === undefined ? queues.get(agent) : byTask.get(task))?.shift();
      if (turn === undefined) throw new Error(`a request beyond the script of ${key}`);
      // A call the Kernel cancels (a pause, an abort) stops waiting, like a real request would.
      // Like a real fetch, a signal that is already aborted rejects at once.
      const cancelled = new Promise<never>((_, reject) => {
        if (init?.signal?.aborted === true) reject(new DOMException('aborted', 'AbortError'));
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      const answer =
        'then' in turn ? (await Promise.race([turn.wait, cancelled]), turn.then) : turn;
      inner.add(answer);
      return inner.fetch(input, init);
    },
  };
}

/** Lets `size` callers wait for each other: the one who comes last frees all. */
export function barrier(size: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= size) release();
    return open;
  };
}
