import type { TerminalPort } from '@multiagentos/user-interaction';

/** Terminal that records what was written and answers every question the same way. */
export function createFakeTerminal(
  answer: 'YES' | 'NO' | undefined = undefined,
): TerminalPort & { readonly written: string[]; interrupt(): void } {
  const written: string[] = [];
  const handlers = new Set<() => void>();
  return {
    written,
    write: (text) => {
      written.push(text);
    },
    askYesNo: () => Promise.resolve(answer),
    onInterrupt: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    interrupt: () => {
      for (const handler of handlers) handler();
    },
  };
}
