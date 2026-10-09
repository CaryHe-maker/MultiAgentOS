import { createInterface } from 'node:readline';
import type { TerminalPort } from '@multiagentos/user-interaction';

/** TerminalPort on the process's own stdin, stdout and SIGINT. */
export function createNodeTerminal(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): TerminalPort {
  return {
    write: (text) => {
      output.write(text);
    },
    askYesNo: (question, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) {
          resolve(undefined);
          return;
        }
        const reader = createInterface({ input, output });
        const finish = (answer: 'YES' | 'NO' | undefined) => {
          signal.removeEventListener('abort', onAbort);
          reader.close();
          resolve(answer);
        };
        const onAbort = () => finish(undefined);
        signal.addEventListener('abort', onAbort);
        const ask = () =>
          reader.question(`${question} [y/n] `, (line) => {
            const answer = line.trim().toLowerCase();
            if (answer === 'y' || answer === 'yes') finish('YES');
            else if (answer === 'n' || answer === 'no') finish('NO');
            else ask();
          });
        ask();
      }),
    onInterrupt: (handler) => {
      process.on('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
  };
}
