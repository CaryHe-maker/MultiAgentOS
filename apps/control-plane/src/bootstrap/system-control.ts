import { randomUUID } from 'node:crypto';
import type { SystemFault } from '@multiagentos/contracts';
import type { KernelCoreModule, SupervisorModule } from '@multiagentos/kernel';
import type { ModuleLedgerEntry } from '@multiagentos/module-host';

/** Exit code of a process that ended on a system fault and has no non-zero run result. */
export const EXIT_CODE_SYSTEM_FAULT = 70;

export interface ShutdownTimeouts {
  /** How long a fault shutdown waits for the Kernel core to converge its runs. */
  readonly abortRunsMs: number;
  /** How long one attempt to stop every module may take. */
  readonly stopMs: number;
  /** After the run ended: how long the command and the normal shutdown may still take. */
  readonly settleMs: number;
}

export interface SystemFaultRecord extends SystemFault {
  /** One id for the whole shutdown: later faults are appended to the first one's record. */
  readonly faultId: string;
  readonly at: string;
}

export interface StopReport {
  /** `REQUESTED` only when the shutdown came through Gateway and Core and nothing failed. */
  readonly intent: 'REQUESTED' | 'FAULT';
  readonly faults: readonly SystemFaultRecord[];
  readonly modules: readonly ModuleLedgerEntry[];
}

export interface SystemControlDeps {
  readonly supervisor: SupervisorModule;
  readonly kernelCore: KernelCoreModule;
  readonly moduleHost: { stop(): Promise<void>; ledger(): readonly ModuleLedgerEntry[] };
  readonly killSubprocesses: () => void;
  readonly timeouts: ShutdownTimeouts;
  readonly now: () => Date;
  /** Local diagnostics only; the default is stderr. */
  readonly log: (line: string) => void;
}

export interface SystemControl {
  start(): Promise<void>;
  /** Runs the command to its end, makes sure everything stopped, and gives the exit code. */
  run(command: () => Promise<number>): Promise<number>;
  reportFault(fault: SystemFault): void;
  /** Idempotent. After a normal shutdown it only reports; otherwise it stops the system. */
  shutdown(): Promise<StopReport>;
}

type Settled<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'timeout' };

/** Never rejects: a deadline is the only way this process learns that a part is unusable. */
async function within<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value): Settled<T> => ({ status: 'ok', value }),
        (error: unknown): Settled<T> => ({ status: 'error', error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message} [${error.errors.map(describe).join('; ')}]`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The process-level control of the composition root (docs/SystemFaultHandling.md 3). It is not
 * a module: it has no Fabric identity, is not registered with ModuleHost and holds no run
 * state. It decides three things only: when the system shuts down, how long each step may
 * take, and the exit code. A fault shutdown asks the Kernel core to converge first and falls
 * back to stopping the modules when the deadline passes; nothing is retried.
 */
export function createSystemControl(deps: SystemControlDeps): SystemControl {
  const { supervisor, kernelCore, moduleHost, timeouts } = deps;
  const faults: SystemFaultRecord[] = [];
  let faultId: string | undefined;
  let booted = false;
  let supervisorSettled = false;
  let shutdownOp: Promise<StopReport> | undefined;
  let signalFault: () => void = () => undefined;
  const faulted = new Promise<void>((resolve) => (signalFault = resolve));

  const phase = (): SystemFault['phase'] =>
    !booted ? 'BOOT' : shutdownOp !== undefined || supervisorSettled ? 'SHUTDOWN' : 'RUN';

  const record = (fault: SystemFault): string => {
    faultId ??= `flt_${randomUUID()}`;
    if (faults.some((known) => known.error === fault.error)) return faultId;
    faults.push(Object.freeze({ ...fault, faultId, at: deps.now().toISOString() }));
    deps.log(
      `system fault ${faultId} [${fault.phase}] ${fault.source}: ${describe(fault.error)}\n`,
    );
    signalFault();
    return faultId;
  };

  const shutdown = (): Promise<StopReport> => {
    shutdownOp ??= (async () => {
      if (!supervisorSettled) {
        const id =
          faultId ??
          record({
            source: 'composition-root',
            phase: phase(),
            error: new Error('The system was stopped outside the normal shutdown path'),
          });
        if (booted) {
          const aborted = await within(
            kernelCore.abortAllRuns({ faultId: id, deadlineMs: timeouts.abortRunsMs }),
            timeouts.abortRunsMs,
          );
          if (aborted.status !== 'ok')
            record({
              source: 'kernel-core',
              phase: 'SHUTDOWN',
              error:
                aborted.status === 'error'
                  ? aborted.error
                  : new Error('The Kernel core did not converge its runs in time'),
            });
        }
        const stopped = await within(supervisor.stop(), timeouts.stopMs);
        if (stopped.status !== 'ok') {
          record({
            source: 'supervisor',
            phase: 'SHUTDOWN',
            error:
              stopped.status === 'error'
                ? stopped.error
                : new Error('The Supervisor did not stop the modules in time'),
          });
          // Past the Supervisor: the host shares one stop pass and keeps what already failed.
          const direct = await within(moduleHost.stop(), timeouts.stopMs);
          if (direct.status !== 'ok')
            record({
              source: 'module-host',
              phase: 'SHUTDOWN',
              error:
                direct.status === 'error'
                  ? direct.error
                  : new Error('ModuleHost did not stop the modules in time'),
            });
        }
      }
      deps.killSubprocesses();
      return Object.freeze({
        intent: faults.length === 0 ? 'REQUESTED' : 'FAULT',
        faults: [...faults],
        modules: moduleHost.ledger(),
      });
    })();
    return shutdownOp;
  };

  const reportFault = (fault: SystemFault): void => {
    record(fault);
    void shutdown();
  };

  const supervisorStopped = supervisor.whenStopped().then(
    () => {
      supervisorSettled = true;
    },
    (error: unknown) => {
      supervisorSettled = true;
      reportFault({ source: 'supervisor', phase: 'SHUTDOWN', error });
    },
  );

  return {
    start: async () => {
      try {
        await supervisor.start();
        booted = true;
      } catch (error) {
        record({ source: 'supervisor', phase: 'BOOT', error });
        await shutdown();
        throw error;
      }
    },
    run: async (command) => {
      const result = command();
      const ended = result.then(
        () => undefined,
        () => undefined,
      );
      await Promise.race([ended, faulted, supervisorStopped]);
      if (faults.length === 0) {
        // Normal end: the command returns its code and Core's shutdown request stops the rest.
        const settled = await within(Promise.all([result, supervisorStopped]), timeouts.settleMs);
        if (settled.status === 'error')
          record({ source: 'entry', phase: phase(), error: settled.error });
        if (settled.status === 'timeout')
          record({
            source: 'entry',
            phase: phase(),
            error: new Error('The command or the shutdown did not complete after the run ended'),
          });
      }
      const report = await shutdown();
      const code = await within(result, 0);
      const exitCode = code.status === 'ok' ? code.value : undefined;
      if (report.intent === 'REQUESTED' && exitCode !== undefined) return exitCode;
      // A fault never exits 0; a run that already ended non-zero keeps its own code.
      return exitCode !== undefined && exitCode !== 0 ? exitCode : EXIT_CODE_SYSTEM_FAULT;
    },
    reportFault,
    shutdown,
  };
}
