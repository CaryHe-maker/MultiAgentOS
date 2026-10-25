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
      new Promise((resolve, reject) => {
        if (signal.aborted) {
          resolve(undefined);
          return;
        }
        const inputError = 'errored' in input ? input.errored : undefined;
        if (inputError !== undefined && inputError !== null) {
          reject(
            inputError instanceof Error
              ? inputError
              : new Error('Terminal input failed', { cause: inputError }),
          );
          return;
        }
        if (!input.readable) {
          resolve(undefined);
          return;
        }
        if (!output.writable) {
          reject(new Error('Terminal output is not writable'));
          return;
        }
        const reader = createInterface({ input, output });
        let isSettled = false;
        const finish = (answer: 'YES' | 'NO' | undefined) => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          resolve(answer);
        };
        const cleanup = () => {
          signal.removeEventListener('abort', onAbort);
          reader.off('close', onClose);
          reader.off('error', onError);
          input.off('close', onClose);
          output.off('error', onError);
          output.off('close', onOutputClose);
          output.off('finish', onOutputClose);
          reader.close();
        };
        const onAbort = () => finish(undefined);
        const onClose = () => finish(undefined);
        const onError = (error: unknown) => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          reject(
            error instanceof Error
              ? error
              : new Error('Terminal question failed', { cause: error }),
          );
        };
        const onOutputClose = () => onError(new Error('Terminal output closed during input'));
        reader.once('close', onClose);
        reader.once('error', onError);
        input.once('close', onClose);
        output.once('error', onError);
        output.once('close', onOutputClose);
        output.once('finish', onOutputClose);
        signal.addEventListener('abort', onAbort);
        const ask = () => {
          try {
            reader.question(`${question} [y/n] `, (line) => {
              const answer = line.trim().toLowerCase();
              if (answer === 'y' || answer === 'yes') finish('YES');
              else if (answer === 'n' || answer === 'no') finish('NO');
              else ask();
            });
          } catch (error) {
            onError(error);
          }
        };
        ask();
      }),
    onInterrupt: (handler) => {
      process.on('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
  };
}
