import { spawn } from 'node:child_process';
import type { SubprocessRunner } from '@multiagentos/contracts';

type RunResult = Awaited<ReturnType<SubprocessRunner['run']>>;
const NOT_RUN: RunResult = { exitCode: null, signal: null, stdout: '', truncated: false };

/**
 * The only place that starts a child process (docs/M1/M1TechStack.md 9): a thin wrapper of
 * `child_process.spawn` that runs `rg` and nothing else, with an argument array and no shell.
 * It never throws: a binary that is missing or cannot start resolves with `exitCode: null`.
 * The child is killed when `signal` fires or when its output passes `maxOutputBytes`, in which
 * case `truncated` is true and `stdout` holds what was read up to the limit.
 */
export function createSubprocessRunner(): SubprocessRunner {
  return {
    run: (command, args, { cwd, signal, maxOutputBytes }) =>
      new Promise<RunResult>((resolve) => {
        if (command !== 'rg' || signal.aborted) {
          resolve(NOT_RUN);
          return;
        }
        const child = spawn('rg', [...args], {
          cwd,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let settled = false;
        const kill = () => child.kill('SIGKILL');
        const finish = (exitCode: number | null, exitSignal: string | null) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', kill);
          resolve({
            exitCode,
            signal: exitSignal,
            stdout: Buffer.concat(chunks).toString('utf8'),
            truncated,
          });
        };
        signal.addEventListener('abort', kill);
        child.stdout.on('data', (chunk: Buffer) => {
          const room = maxOutputBytes - size;
          if (chunk.byteLength > room) {
            truncated = true;
            if (room > 0) chunks.push(chunk.subarray(0, room));
            size = maxOutputBytes;
            kill();
            return;
          }
          chunks.push(chunk);
          size += chunk.byteLength;
        });
        child.on('error', () => finish(null, null));
        child.on('close', (exitCode, exitSignal) => finish(exitCode, exitSignal));
      }),
  };
}
