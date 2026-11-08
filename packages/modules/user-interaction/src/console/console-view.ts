/**
 * What the console needs from a terminal (Module/UserInteraction 6). `apps/cli` draws it with Ink;
 * a line-by-line adapter serves a terminal that is not a TTY. The module never touches either.
 */

/** Written once into the transcript and never redrawn. */
export type TranscriptRecord =
  | { readonly kind: 'USER'; readonly text: string }
  | { readonly kind: 'REPLY'; readonly agentLabel: string; readonly text: string }
  | { readonly kind: 'REPORT'; readonly text: string }
  | { readonly kind: 'STEP'; readonly text: string }
  | { readonly kind: 'NOTICE'; readonly text: string }
  /** What the model thought: a one-line summary of an older Turn, or a block `/think` asked for. */
  | { readonly kind: 'THINKING'; readonly text: string }
  | { readonly kind: 'ERROR'; readonly text: string };

export interface ActivityLine {
  readonly agentRunId: string;
  readonly label: string;
  /** The AgentRun that started this one, when it is a SubAgent. */
  readonly parentAgentRunId?: string;
  /** The tree branch in front of the label (`├─ `), empty for a line without a parent. */
  readonly branch?: string;
  readonly phase: string;
  /** The run waits for the user (a question, a pause): the view shows no running seconds. */
  readonly waitsForUser?: boolean;
  /** When this phase began, so the view can count seconds by itself. */
  readonly since: string;
  readonly tool?: string;
  /** Present while a technical retry waits; the view counts down to `retryAt`. */
  readonly retry?: { readonly attempt: number; readonly retryAt: string };
}

/** The one item the input area asks about; the rest wait behind it in arrival order. */
export type PendingItem =
  | {
      readonly kind: 'AUTHORIZATION';
      readonly once: boolean;
      /** A command is answered with one of these (Kernel/Core 5b); otherwise y or n. */
      readonly options?: readonly ('ONCE' | 'COMMAND' | 'PREFIX' | 'DENY')[];
      readonly questionId: string;
      readonly text: string;
      /** The whole command, when the question shows only its head; `v` prints it. */
      readonly detail?: string;
    }
  | { readonly kind: 'UNDO'; readonly undoId: string; readonly text: string }
  /**
   * A question an agent put to the user (`ask_user`, M2Design 4.2): it blocks only that agent. With
   * fields the user answers them one after another, `next` being the one asked now.
   */
  | {
      readonly kind: 'QUESTION';
      readonly humanRequestId: string;
      readonly question: 'ask' | 'confirm' | 'review';
      readonly fields: readonly QuestionField[];
      readonly next: number;
      readonly values: Readonly<Record<string, string | boolean | readonly string[]>>;
      /** What was asked, and who asked it; the prompt of the field in turn follows it. */
      readonly body: string;
      readonly text: string;
    }
  | { readonly kind: 'CONTINUE'; readonly text: string };

export interface QuestionField {
  readonly name: string;
  readonly type: 'text' | 'textarea' | 'select' | 'multiselect' | 'confirm';
  readonly label: string;
  readonly options?: readonly string[];
  readonly required?: boolean;
}

/**
 * One piece of the model's thinking: one model call. Every block is passed; the view shows the
 * latest two open, among the records they stand between, and leaves a line for each older one.
 */
export interface ThinkingView {
  readonly id: string;
  /** 1 for the first block of the Session in view; `/think <number>` shows it whole. */
  readonly number: number;
  readonly label: string;
  readonly state: 'OPEN' | 'DONE' | 'ABORTED';
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly text: string;
}

/**
 * The text an agent is writing for the user, shown as it is written (a reply is a tool call whose
 * text argument is read while it grows). It goes when the message is published, or the run moves on.
 */
export interface WritingView {
  readonly id: string;
  readonly label: string;
  readonly state: 'OPEN' | 'DONE';
  readonly text: string;
}

/** Everything that changes in place: redrawn whenever it changes. */
export interface LiveState {
  readonly status: string;
  readonly activity: readonly ActivityLine[];
  readonly pending?: PendingItem;
  readonly waiting: number;
  readonly queued: readonly string[];
  readonly hint?: string;
  /** Every block the console keeps, oldest first. */
  readonly thinking?: readonly ThinkingView[];
  /** What agents are writing for the user right now. */
  readonly writing?: readonly WritingView[];
}

export interface ConsoleView {
  print(record: TranscriptRecord): void;
  update(live: LiveState): void;
  /** Puts messages back into the input box, for the user to send or drop. */
  restoreInput(messages: readonly string[]): void;
}
