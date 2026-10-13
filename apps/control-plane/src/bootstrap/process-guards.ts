import { EXIT_CODE_SYSTEM_FAULT } from './system-control.js';

/** Exit code of a process the user forced to end with a second Ctrl+C; same as CANCELLED. */
export const EXIT_CODE_INTERRUPTED = 130;

/** The part of `process` the guards use; a test passes its own. */
export interface GuardedProcess {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): void;
  on(event: 'exit' | 'SIGINT', listener: () => void): void;
  off(event: string, listener: (...args: never[]) => void): void;
  exit(code: number): void;
}

export interface ProcessGuardOptions {
  readonly killSubprocesses: () => void;
  readonly log?: (line: string) => void;
  readonly target?: GuardedProcess;
}

/**
 * The last line of defence (docs/M1/SystemFaultHandling.md 2, level L3). An uncaught exception or
 * an unhandled rejection means no in-process state can be trusted, so nothing converges here:
 * the child processes are killed synchronously and the process exits non-zero. A hung event
 * loop or a crash is beyond this and needs whoever started the process. Returns the uninstall.
 *
 * It also owns the second Ctrl+C. The first interrupt belongs to UserInteraction, which cancels
 * the run through `TerminalPort.onInterrupt` and lets it converge; the guard only counts it. A
 * second interrupt means the user will not wait: the child processes are killed and the
 * process exits with `EXIT_CODE_INTERRUPTED`, again without asking any module.
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
  let interrupts = 0;
  const onInterrupt = (): void => {
    interrupts += 1;
    if (interrupts < 2) return;
    log('interrupted again: exiting without waiting for the run to end\n');
    options.killSubprocesses();
    target.exit(EXIT_CODE_INTERRUPTED);
  };
  target.on('uncaughtException', fatal);
  target.on('unhandledRejection', fatal);
  target.on('exit', onExit);
  target.on('SIGINT', onInterrupt);
  return () => {
    target.off('uncaughtException', fatal);
    target.off('unhandledRejection', fatal);
    target.off('exit', onExit);
    target.off('SIGINT', onInterrupt);
  };
}
