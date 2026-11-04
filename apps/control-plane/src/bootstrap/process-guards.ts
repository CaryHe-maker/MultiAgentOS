import { EXIT_CODE_SYSTEM_FAULT } from './system-control.js';

/** The part of `process` the guards use; a test passes its own. */
export interface GuardedProcess {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): void;
  on(event: 'exit', listener: () => void): void;
  off(event: string, listener: (...args: never[]) => void): void;
  exit(code: number): void;
}

export interface ProcessGuardOptions {
  readonly killSubprocesses: () => void;
  readonly log?: (line: string) => void;
  readonly target?: GuardedProcess;
}

/**
 * The last line of defence. An uncaught exception or
 * an unhandled rejection means no in-process state can be trusted, so nothing converges here:
 * the child processes are killed synchronously and the process exits non-zero. A hung event
 * loop or a crash is beyond this and needs whoever started the process. Returns the uninstall.
 *
 * Ctrl+C is not handled here: the console turns two presses into a normal shutdown, which
 * converges the run with SHUTDOWN (Module/UserInteraction 5.3).
 */
export function installProcessGuards(options: ProcessGuardOptions): () => void {
  const target = options.target ?? (process as unknown as GuardedProcess);
  const log = options.log ?? ((line: string) => void process.stderr.write(line));
  const fatal = (error: unknown): void => {
    try {
      log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    } catch {
      // Diagnostics must not prevent the last-resort exit.
    }
    try {
      options.killSubprocesses();
    } catch {
      // Child cleanup failure must not prevent the last-resort exit.
    }
    target.exit(EXIT_CODE_SYSTEM_FAULT);
  };
  const onExit = (): void => {
    try {
      options.killSubprocesses();
    } catch {
      // The process is already leaving; nothing else can be done.
    }
  };
  target.on('uncaughtException', fatal);
  target.on('unhandledRejection', fatal);
  target.on('exit', onExit);
  return () => {
    target.off('uncaughtException', fatal);
    target.off('unhandledRejection', fatal);
    target.off('exit', onExit);
  };
}
