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
  | { readonly kind: 'ERROR'; readonly text: string };

export interface ActivityLine {
  readonly agentRunId: string;
  readonly label: string;
  readonly phase: string;
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
      readonly questionId: string;
      readonly text: string;
    }
  | { readonly kind: 'CONTINUE'; readonly text: string };

/** Everything that changes in place: redrawn whenever it changes. */
export interface LiveState {
  readonly status: string;
  readonly activity: readonly ActivityLine[];
  readonly pending?: PendingItem;
  readonly waiting: number;
  readonly queued: readonly string[];
  readonly hint?: string;
}

export interface ConsoleView {
  print(record: TranscriptRecord): void;
  update(live: LiveState): void;
  /** Puts messages back into the input box, for the user to send or drop. */
  restoreInput(messages: readonly string[]): void;
}
