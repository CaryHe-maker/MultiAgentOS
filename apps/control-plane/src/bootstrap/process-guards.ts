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
 * The last line of defence (docs/SystemFaultHandling.md 2, level L3). An uncaught exception or
 * an unhandled rejection means no in-process state can be trusted, so nothing converges here:
 * the child processes are killed synchronously and the process exits non-zero. A hung event
 * loop or a crash is beyond this and needs whoever started the process. Returns the uninstall.
 */
export function installProcessGuards(options: ProcessGuardOptions): () => void {
  const target = options.target ?? (process as unknown as GuardedProcess);
  const log = options.log ?? ((line: string) => void process.stderr.write(line));
  const fatal = (error: unknown): void => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    options.killSubprocesses();
    target.exit(EXIT_CODE_SYSTEM_FAULT);
  };
  const onExit = (): void => options.killSubprocesses();
  target.on('uncaughtException', fatal);
  target.on('unhandledRejection', fatal);
  target.on('exit', onExit);
  return () => {
    target.off('uncaughtException', fatal);
    target.off('unhandledRejection', fatal);
    target.off('exit', onExit);
  };
}
