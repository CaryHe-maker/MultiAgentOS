/**
 * The vocabulary of the evaluation system (docs/M2/Evaluation.md). A task says how to drive the
 * product and how to judge what came of it; it does not say how to measure, because every
 * measure is read from the Session log, the same for every task of every mode.
 */
import type { ChatOptions, Answer, ScriptedChat } from '../acceptance/chat-driver.js';

/** What a check is about. Cost and time are always measured; the others are judged. */
export type Angle = 'OUTCOME' | 'BEHAVIOR' | 'SAFETY' | 'CONTEXT';

export interface Check {
  readonly name: string;
  readonly angle: Angle;
  readonly ok: boolean;
  /** Why it failed, for the person reading the record. */
  readonly detail?: string;
}

/** One thing the user does. A driver of another mode may define its own steps. */
export type ChatStep =
  /** Types a message and waits for the reply of the agent. */
  | { readonly say: string }
  /** Types a line (a command, say) and returns at once. */
  | { readonly submit: string }
  /** Waits until the run asks for the next input. */
  | { readonly awaitInput: true }
  /** Waits until `until` holds, looking at what the console printed. */
  | { readonly waitFor: (look: Look) => boolean; readonly what: string }
  /** Mission mode only: `mas run "<goal>"` with a template, waited for until the run ends. */
  | { readonly run: string; readonly template?: string };

/** What a step may look at without reaching into the product. */
export interface Look {
  readonly printed: (kind: string) => readonly string[];
  readonly questions: readonly string[];
}

/** Everything a judge may look at once the steps are done. */
export interface Observation {
  readonly repository: string;
  readonly dataDir: string;
  /** What the console printed, by kind, in order. */
  readonly printed: (kind: string) => readonly string[];
  readonly questions: readonly string[];
  /** The requests the provider received (messages as text, and the tool names offered). */
  readonly requests: readonly {
    readonly messages: readonly string[];
    readonly tools: readonly string[];
  }[];
  /** The records of the Session log, in order. */
  readonly log: readonly Readonly<Record<string, unknown>>[];
  /** Set when the steps did not finish (a timeout, a request over budget). */
  readonly error?: string;
  /** Mission mode: the exit code of `mas run`. */
  readonly exitCode?: number;
}

export interface TaskSpec {
  /** Unique, stable: records of different versions are compared by it. */
  readonly id: string;
  /** `chat`: the interactive console; `mission`: `mas run` with a template, no conversation. */
  readonly mode: 'chat' | 'mission';
  /** Free labels for reports: `chat`, `write`, `safety`, ... */
  readonly tags: readonly string[];
  readonly description: string;
  /** Puts the files of the task into an empty repository. */
  readonly fixture: (repository: string) => Promise<void>;
  /** What the user does. */
  readonly steps: readonly ChatStep[];
  /** How the user answers a question of authorization; `y` by default. */
  readonly answer?: (question: string) => Answer;
  /** Changes of the product's setup for this task (config, preset). */
  readonly setup?: Pick<ChatOptions, 'configure' | 'preset'>;
  /**
   * A scripted provider for this task. A task that has one is deterministic and runs without a
   * key (the self-check tasks and the tests of the system itself); a task without one runs
   * against the real model.
   */
  readonly scripted?: () => ScriptedChat;
  /** Judges only what the product left behind; never another model. */
  readonly judge: (observation: Observation) => Promise<readonly Check[]> | readonly Check[];
}

/** What the log says of a run: the same set of figures for every task. */
export interface RunMetrics {
  /** From the first record of the log to the last. */
  readonly logWallMs: number;
  readonly turns: number;
  readonly modelRequests: number;
  readonly failedModelRequests: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheHit: number;
    /** Of the summary requests of compactions, apart from the above. */
    readonly compactionInput: number;
    readonly compactionOutput: number;
  };
  /** Share of the input tokens served from the cache, 0 to 1; null without any input. */
  readonly cacheHitRate: number | null;
  /** In US dollars, from the model's price list; null when the model is not priced. */
  readonly costUsd: number | null;
  /** How often the model asked for each tool. */
  readonly toolRequests: Readonly<Record<string, number>>;
  /** How each tool call ended: `<tool>:<status>` with the reason code of a refusal. */
  readonly toolOutcomes: Readonly<Record<string, number>>;
  readonly agentRuns: Readonly<Record<string, number>>;
  /** The most Units that were in flight at the same moment. */
  readonly maxParallelUnits: number;
  readonly compactions: { readonly summarised: number; readonly pruned: number };
  readonly authorizationQuestions: number;
  readonly humanRequests: number;
  readonly wrapUps: number;
}

/** One line of a records file. */
export interface RunRecord {
  readonly schema: 1;
  readonly taskId: string;
  readonly mode: TaskSpec['mode'];
  readonly tags: readonly string[];
  readonly run: number;
  readonly at: string;
  /** Where the product stood: the commit, and a digest of every definition (Agent, Prompt, Tool, ...). */
  readonly version: { readonly commit: string; readonly definitions: string };
  readonly model: string;
  readonly provider: 'real' | 'scripted';
  readonly ok: boolean;
  readonly checks: readonly Check[];
  readonly metrics: RunMetrics;
  readonly elapsedMs: number;
  readonly error?: string;
}
