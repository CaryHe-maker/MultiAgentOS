/**
 * What UserInteraction needs from a terminal. The CLI adapter in `apps/cli` implements it, so
 * the Module itself never touches stdin, stdout or process signals.
 */
export interface TerminalPort {
  write(text: string): void;
  /**
   * Asks a yes/no question. Resolves with undefined when `signal` fires first: the question
   * ends without an answer and reading stops, so Inbox handling is never blocked on the user.
   */
  askYesNo(question: string, signal: AbortSignal): Promise<'YES' | 'NO' | undefined>;
  /** Calls `handler` when the user interrupts (Ctrl+C). Returns a function that removes it. */
  onInterrupt(handler: () => void): () => void;
}
