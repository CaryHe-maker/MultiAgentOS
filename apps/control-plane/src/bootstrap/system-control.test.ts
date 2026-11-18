import type { SessionKernelCoreModule, SupervisorModule } from '@multiagentos/kernel';
import type { ModuleLedgerEntry } from '@multiagentos/module-host';
import { describe, expect, it } from 'vitest';
import { installProcessGuards, type GuardedProcess } from './process-guards.js';
import {
  createSystemControl,
  EXIT_CODE_SYSTEM_FAULT,
  type ShutdownTimeouts,
} from './system-control.js';

const TIMEOUTS: ShutdownTimeouts = { bootMs: 100, abortRunsMs: 100, stopMs: 100, settleMs: 100 };

/**
 * A system as SystemControl sees it: a Supervisor whose `whenStopped` settles once the modules
 * stopped, a Kernel core that converges its runs, and a ModuleHost ledger.
 */
function fixture(
  options: {
    readonly start?: () => Promise<void>;
    readonly stop?: () => Promise<void>;
    readonly abortAllRuns?: () => Promise<void>;
    readonly moduleStop?: () => Promise<void>;
    readonly killSubprocesses?: () => void;
    readonly log?: (line: string) => void;
    readonly timeouts?: Partial<ShutdownTimeouts>;
  } = {},
) {
  const calls: string[] = [];
  let stopped!: () => void;
  let failed!: (error: unknown) => void;
  const whenStopped = new Promise<void>((resolve, reject) => {
    stopped = resolve;
    failed = reject;
  });
  // A caller may await whenStopped only after asking for the shutdown.
  whenStopped.catch(() => undefined);
  let modules: ModuleLedgerEntry['state'] = 'REGISTERED';
  const supervisor = {
    start: async () => {
      await (options.start ?? (() => Promise.resolve()))();
      modules = 'READY';
    },
    stop: async () => {
      calls.push('supervisor.stop');
      try {
        await (options.stop ?? (() => Promise.resolve()))();
      } catch (error) {
        failed(error);
        throw error;
      }
      modules = 'STOPPED';
      stopped();
    },
    whenStopped: () => whenStopped,
  } as unknown as SupervisorModule;
  const kernelCore = {
    abortAllRuns: () => {
      calls.push('abortAllRuns');
      return (options.abortAllRuns ?? (() => Promise.resolve()))();
    },
  } as unknown as SessionKernelCoreModule;
  const moduleHost = {
    stop: async () => {
      calls.push('moduleHost.stop');
      await (options.moduleStop ?? (() => Promise.resolve()))();
      modules = 'STOPPED';
    },
    ledger: (): readonly ModuleLedgerEntry[] =>
      [{ moduleId: 'workflow', state: modules }] as unknown as readonly ModuleLedgerEntry[],
  };
  const lines: string[] = [];
  const control = createSystemControl({
    supervisor,
    kernelCore,
    moduleHost,
    killSubprocesses: options.killSubprocesses ?? (() => calls.push('kill')),
    timeouts: { ...TIMEOUTS, ...options.timeouts },
    now: () => new Date('2026-11-03T00:00:00.000Z'),
    log: options.log ?? ((line) => lines.push(line)),
  });
  /** What Core does when the console asks to shut down: the Supervisor stops the modules. */
  const requestedShutdown = () => void supervisor.stop().catch(() => undefined);
  return { control, calls, lines, requestedShutdown };
}

describe('system control', () => {
  it('returns the exit code of a normal run and reports a requested shutdown', async () => {
    const { control, lines, requestedShutdown } = fixture();
    await control.start();
    const code = await control.run(() => {
      requestedShutdown();
      return Promise.resolve(0);
    });
    expect(code).toBe(0);
    const report = await control.shutdown();
    expect(report.intent).toBe('REQUESTED');
    expect(report.faults).toEqual([]);
    expect(report.modules.map((entry) => entry.state)).toEqual(['STOPPED']);
    expect(lines).toEqual([]);
  });

  it('converges the runs and stops every module when the command throws', async () => {
    const { control, calls } = fixture();
    await control.start();
    const code = await control.run(() => Promise.reject(new Error('cli crashed')));
    expect(code).toBe(EXIT_CODE_SYSTEM_FAULT);
    const report = await control.shutdown();
    expect(report.intent).toBe('FAULT');
    expect(calls.slice(0, 2)).toEqual(['abortAllRuns', 'supervisor.stop']);
  });

  it('never exits 0 after a reported fault and keeps one fault id for the shutdown', async () => {
    const { control, lines } = fixture();
    await control.start();
    const code = await control.run(() => {
      control.reportFault({ source: 'user-interaction', phase: 'RUN', error: new Error('first') });
      control.reportFault({ source: 'workflow', phase: 'RUN', error: new Error('second') });
      return Promise.resolve(0);
    });
    expect(code).toBe(EXIT_CODE_SYSTEM_FAULT);
    const { faults } = await control.shutdown();
    expect(faults.map((fault) => fault.source)).toEqual(['user-interaction', 'workflow']);
    expect(new Set(faults.map((fault) => fault.faultId)).size).toBe(1);
    expect(lines[0]).toContain('user-interaction: Error: first');
  });

  it('keeps a run that already ended non-zero at its own exit code', async () => {
    const { control } = fixture();
    await control.start();
    const code = await control.run(() => {
      control.reportFault({ source: 'workflow', phase: 'RUN', error: new Error('late') });
      return Promise.resolve(3);
    });
    expect(code).toBe(3);
  });

  it('stops the modules past a Kernel core that does not converge in time', async () => {
    const { control, calls } = fixture({
      abortAllRuns: () => new Promise<void>(() => undefined),
      timeouts: { abortRunsMs: 20 },
    });
    await control.start();
    control.reportFault({ source: 'workflow', phase: 'RUN', error: new Error('inbox failed') });
    const report = await control.shutdown();
    expect(report.faults.map((fault) => fault.source)).toEqual(['workflow', 'kernel-core']);
    expect(calls).toContain('supervisor.stop');
    expect(report.modules.map((entry) => entry.state)).toEqual(['STOPPED']);
  });

  it('exits non-zero when the modules fail to stop after a completed run', async () => {
    const { control, requestedShutdown } = fixture({
      stop: () => Promise.reject(new Error('workflow stop failed')),
    });
    await control.start();
    const code = await control.run(() => {
      requestedShutdown();
      return Promise.resolve(0);
    });
    expect(code).toBe(EXIT_CODE_SYSTEM_FAULT);
    const report = await control.shutdown();
    expect(report.intent).toBe('FAULT');
    expect(report.faults[0]).toMatchObject({ source: 'supervisor', phase: 'SHUTDOWN' });
  });

  it('stops what had started when the boot fails', async () => {
    const { control, calls } = fixture({
      start: () => Promise.reject(new Error('workflow start failed')),
    });
    await expect(control.start()).rejects.toThrow('workflow start failed');
    expect(calls).toContain('supervisor.stop');
    const report = await control.shutdown();
    expect(report.faults[0]).toMatchObject({ source: 'supervisor', phase: 'BOOT' });
  });

  it('bounds the Supervisor boot with bootMs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { control } = fixture({ start: () => gate, timeouts: { bootMs: 20 } });
    await expect(control.start()).rejects.toThrow('bootMs');
    release();
    const report = await control.shutdown();
    expect(report.intent).toBe('FAULT');
    expect(report.faults[0]).toMatchObject({ source: 'supervisor', phase: 'BOOT' });
  });

  it('continues when the diagnostic log throws', async () => {
    const { control } = fixture({
      log: () => {
        throw new Error('log failed');
      },
    });
    await control.start();
    control.reportFault({ source: 'workflow', phase: 'RUN', error: new Error('workflow failed') });
    const report = await control.shutdown();
    expect(report.intent).toBe('FAULT');
    expect(report.faults.map((fault) => fault.source)).toContain('workflow');
  });

  it('handles a command that throws synchronously', async () => {
    const { control } = fixture();
    await control.start();
    expect(
      await control.run(() => {
        throw new Error('synchronous command failure');
      }),
    ).toBe(EXIT_CODE_SYSTEM_FAULT);
    const report = await control.shutdown();
    expect(report.faults[0]).toMatchObject({ source: 'entry', phase: 'RUN' });
  });

  it('continues to StopReport when abortAllRuns or killSubprocesses throws', async () => {
    const { control } = fixture({
      abortAllRuns: () => {
        throw new Error('abort failed synchronously');
      },
      killSubprocesses: () => {
        throw new Error('kill failed');
      },
    });
    await control.start();
    control.reportFault({ source: 'workflow', phase: 'RUN', error: new Error('inbox failed') });
    const report = await control.shutdown();
    expect(report.intent).toBe('FAULT');
    expect(report.faults.map((fault) => fault.source)).toEqual(
      expect.arrayContaining(['workflow', 'kernel-core', 'composition-root']),
    );
  });

  it('falls back to ModuleHost when supervisor.stop fails', async () => {
    const { control, calls } = fixture({
      stop: () => Promise.reject(new Error('supervisor stop failed')),
    });
    await control.start();
    control.reportFault({ source: 'workflow', phase: 'RUN', error: new Error('inbox failed') });
    const report = await control.shutdown();
    expect(report.intent).toBe('FAULT');
    expect(report.faults.map((fault) => fault.source)).toContain('supervisor');
    expect(calls.filter((call) => call === 'moduleHost.stop')).toHaveLength(1);
  });
});

describe('process guards', () => {
  const guardedTarget = () => {
    const listeners = new Map<string, (error?: unknown) => void>();
    const calls: string[] = [];
    const target: GuardedProcess = {
      on: (event: string, listener: (error?: unknown) => void) =>
        void listeners.set(event, listener),
      off: (event) => void listeners.delete(event),
      exit: (code) => void calls.push(`exit ${code}`),
    };
    return { listeners, calls, target };
  };

  it('kills the child processes and exits non-zero on an uncaught error', () => {
    const { listeners, calls, target } = guardedTarget();
    const remove = installProcessGuards({
      killSubprocesses: () => calls.push('kill'),
      log: (line) => calls.push(line.split('\n')[0] ?? ''),
      target,
    });
    expect(listeners.has('SIGINT')).toBe(false);
    listeners.get('unhandledRejection')?.('lost promise');
    expect(calls).toEqual(['fatal: lost promise', 'kill', `exit ${EXIT_CODE_SYSTEM_FAULT}`]);
    listeners.get('exit')?.();
    expect(calls.at(-1)).toBe('kill');
    remove();
    expect(listeners.size).toBe(0);
  });

  it('still exits when diagnostics and child cleanup throw', () => {
    const { listeners, calls, target } = guardedTarget();
    installProcessGuards({
      killSubprocesses: () => {
        throw new Error('kill failed');
      },
      log: () => {
        throw new Error('log failed');
      },
      target,
    });
    expect(() => listeners.get('uncaughtException')?.(new Error('boom'))).not.toThrow();
    expect(calls).toEqual([`exit ${EXIT_CODE_SYSTEM_FAULT}`]);
  });
});
