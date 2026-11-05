/**
 * Drives the whole product in Turn-chat for the deterministic cases of stage 1 (M2Plan 8.3): the
 * real composition, Kernel, Workflow, console and ExecutorSet, with only the provider's HTTP API
 * replaced. It stands where the user stands: it types lines and reads what the console shows.
 */
import { realpath } from 'node:fs/promises';
import type { ExecutorRegistry, SystemConfig, SystemFaultReporter } from '@multiagentos/contracts';
import type { MemorySample, SandboxProbe, TrackedSubprocessRunner } from '@multiagentos/kernel';
import type {
  Console,
  ConsoleView,
  LiveState,
  TranscriptRecord,
} from '@multiagentos/user-interaction';
import { composeSystem, type System } from '../../src/bootstrap/compose-system.js';
import { defaultSystemConfig } from '../../src/config/system-config.js';

export interface ChatCall {
  readonly name: string;
  readonly arguments: unknown;
}

/** One provider answer: tool calls, or text, or a raw response such as a rate limit. */
export type ProviderTurn =
  | { readonly calls: readonly ChatCall[]; readonly text?: string }
  | { readonly response: () => Response | Promise<Response> };

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
      if ('response' in turn) return turn.response();
      calls += 1;
      return new Response(
        JSON.stringify({
          id: `chatcmpl-${String(calls)}`,
          object: 'chat.completion',
          created: 1_767_225_600,
          model: 'deepseek-flash',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: turn.text ?? null,
                tool_calls: turn.calls.map((call, index) => ({
                  id: `call_${String(calls)}_${String(index)}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
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
    system = await composeSystem({
      config: (options.configure ?? ((config) => config))({
        ...defaultSystemConfig(),
        dataDir: options.dataDir,
      }),
      repositoryRoot: await realpath(options.repository),
      preset: options.preset ?? 'standard',
      view,
      credentials: options.credentials ?? { apiKeyFor: () => OFFLINE_KEY },
      log: () => undefined,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.subprocess === undefined ? {} : { subprocess: options.subprocess }),
      ...(options.executors === undefined ? {} : { executors: options.executors }),
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
export function agentOfRequest(request: ChatRequest): 'main' | 'explorer' | 'worker' | 'unknown' {
  const names = new Set((request.tools ?? []).map((each) => each.function.name));
  if (names.has('run_subagents')) return 'main';
  if (names.has('finish_subagent')) return names.has('write_file') ? 'worker' : 'explorer';
  return 'unknown';
}

/** A turn that is answered only after `wait` has settled: two Agents can be made to overlap. */
export type RoutedTurn =
  ProviderTurn | { readonly wait: Promise<unknown>; readonly then: ProviderTurn };

/**
 * A provider with one script per Agent, for runs where several AgentRuns ask at once: a request
 * is answered from the queue of the Agent it is for, so the order between Agents does not matter.
 */
export function scriptedAgents(
  scripts: Readonly<Partial<Record<'main' | 'explorer' | 'worker', readonly RoutedTurn[]>>>,
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
      const agent = agentOfRequest(request);
      // A task is known by the first user message that carries its name.
      const first = textOf(request.messages.find((message) => message.role === 'user'));
      const task = [...byTask.keys()].find((name) => first.includes(`Your task (${name},`));
      const key = task ?? agent;
      const turn = (task === undefined ? queues.get(agent) : byTask.get(task))?.shift();
      if (turn === undefined) throw new Error(`a request beyond the script of ${key}`);
      const answer = 'then' in turn ? (await turn.wait, turn.then) : turn;
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
