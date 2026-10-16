import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFakeExecutorRegistry,
  createFakeGateway,
  createFakeKernelCore,
  createFakeSupervisor,
  createFakeTerminal,
  createFakeUserInteraction,
  createFakeWorkflow,
  type FakeWorkflowModule,
} from '@multiagentos/testing';
import type { SystemFaultReporter } from '@multiagentos/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSystemConfig } from '../config/system-config.js';
import { composeSystem, type ComposeOptions, type System } from './compose-system.js';
import {
  EXIT_CODE_INTERRUPTED,
  installProcessGuards,
  type GuardedProcess,
} from './process-guards.js';
import { EXIT_CODE_SYSTEM_FAULT } from './system-control.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const command = { goal: 'Explain the README.', repositoryPath: tmpdir(), details: false };

interface Fixture {
  readonly system: System;
  readonly workflow: FakeWorkflowModule;
  readonly log: string[];
  /** Called when the first Unit is submitted, that is, while the run is RUNNING. */
  onRunning: () => void;
}

/** The fake vertical chain, with a hook in the middle of the run and replaceable parts. */
async function fixture(
  parts: NonNullable<ComposeOptions['parts']> = {},
  timeouts: ComposeOptions['timeouts'] = {},
): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-'));
  roots.push(dataDir);
  const log: string[] = [];
  let workflow: FakeWorkflowModule | undefined;
  let fired = false;
  const result = {
    log,
    onRunning: () => undefined,
  } as { system: System; workflow: FakeWorkflowModule; log: string[]; onRunning: () => void };
  result.system = await composeSystem({
    config: { ...defaultSystemConfig(), dataDir },
    terminal: createFakeTerminal(),
    credentials: { apiKeyFor: () => 'offline-fake-placeholder' },
    log: (line) => log.push(line),
    timeouts,
    parts: {
      createGateway: createFakeGateway(),
      createKernelCore: createFakeKernelCore({
        unitScript: () => {
          if (!fired) {
            fired = true;
            result.onRunning();
          }
          return undefined;
        },
      }),
      createSupervisor: createFakeSupervisor(),
      createExecutorRegistry: () => createFakeExecutorRegistry(),
      createWorkflow: (deps) => (workflow = createFakeWorkflow()(deps)),
      createUserInteraction: createFakeUserInteraction(),
      ...parts,
    },
  });
  if (workflow !== undefined) result.workflow = workflow;
  return result;
}

const states = async (system: System) =>
  Object.fromEntries(
    (await system.shutdown()).modules.map((entry) => [entry.moduleId, entry.state]),
  );

describe('system control', () => {
  it('returns the exit code of a normal run and reports a requested shutdown', async () => {
    const { system, log } = await fixture();
    await system.start();
    expect(await system.run((interaction) => interaction.analyze(command))).toBe(0);
    const report = await system.shutdown();
    expect(report.intent).toBe('REQUESTED');
    expect(report.faults).toEqual([]);
    expect(new Set(report.modules.map((entry) => entry.state))).toEqual(new Set(['STOPPED']));
    expect(log).toEqual([]);
  });

  it('converges the run as a Kernel fault and stops every module when the command throws', async () => {
    const context = await fixture();
    const { system, workflow } = context;
    await system.start();
    const exitCode = await system.run(
      (interaction) =>
        new Promise<number>((_, reject) => {
          context.onRunning = () => reject(new Error('cli crashed'));
          void interaction.analyze(command).catch(() => undefined);
        }),
    );
    expect(exitCode).toBe(EXIT_CODE_SYSTEM_FAULT);
    const report = await system.shutdown();
    expect(report.intent).toBe('FAULT');
    expect(report.faults[0]).toMatchObject({ source: 'entry', phase: 'RUN' });
    expect(workflow.events.at(-1)).toMatchObject({
      type: 'RunClosed',
      closeReason: 'FAILED',
      failure: { code: 'KERNEL_INTERNAL', source: 'KERNEL', detail: report.faults[0]?.faultId },
    });
    expect(new Set(report.modules.map((entry) => entry.state))).toEqual(new Set(['STOPPED']));
  });

  it('never exits 0 after a reported fault and keeps one fault id for the shutdown', async () => {
    const context = await fixture();
    const { system, log } = context;
    await system.start();
    context.onRunning = () => {
      system.reportFault({ source: 'user-interaction', phase: 'RUN', error: new Error('first') });
      system.reportFault({ source: 'workflow', phase: 'RUN', error: new Error('second') });
    };
    const exitCode = await system.run((interaction) => interaction.analyze(command));
    // 1 when UserInteraction still showed the FAILED run, 70 when it could not.
    expect([1, EXIT_CODE_SYSTEM_FAULT]).toContain(exitCode);
    const { faults } = await system.shutdown();
    expect(faults.length).toBeGreaterThanOrEqual(2);
    expect(new Set(faults.map((fault) => fault.faultId)).size).toBe(1);
    expect(log[0]).toContain('user-interaction: Error: first');
  });

  it('hands Workflow and UserInteraction the system fault entry', async () => {
    const reporters: Record<string, SystemFaultReporter | undefined> = {};
    const context = await fixture({
      createWorkflow: (deps) => {
        reporters.workflow = deps.reportSystemFault;
        return createFakeWorkflow()(deps);
      },
      createUserInteraction: (deps) => {
        reporters['user-interaction'] = deps.reportSystemFault;
        return createFakeUserInteraction()(deps);
      },
    });
    const { system, log } = context;
    await system.start();
    context.onRunning = () => {
      for (const [source, report] of Object.entries(reporters))
        report?.({ source, phase: 'RUN', error: new Error(`${source} inbox failed`) });
    };
    const exitCode = await system.run((interaction) => interaction.analyze(command));
    expect([1, EXIT_CODE_SYSTEM_FAULT]).toContain(exitCode);
    const report = await system.shutdown();
    expect(report.intent).toBe('FAULT');
    expect(report.faults.map((fault) => fault.source)).toEqual(
      expect.arrayContaining(['workflow', 'user-interaction']),
    );
    expect(new Set(report.faults.map((fault) => fault.faultId)).size).toBe(1);
    expect(log[0]).toContain('workflow: Error: workflow inbox failed');
  });

  it('stops the modules past a Kernel core that does not converge in time', async () => {
    const context = await fixture(
      {
        createKernelCore: (deps) =>
          Object.assign(
            createFakeKernelCore({
              unitScript: () => {
                context.onRunning();
                context.onRunning = () => undefined;
                return undefined;
              },
            })(deps),
            { abortAllRuns: () => new Promise<void>(() => undefined) },
          ),
      },
      { abortRunsMs: 20 },
    );
    const { system } = context;
    await system.start();
    context.onRunning = () =>
      system.reportFault({ source: 'workflow', phase: 'RUN', error: new Error('inbox failed') });
    expect(await system.run((interaction) => interaction.analyze(command))).toBe(
      EXIT_CODE_SYSTEM_FAULT,
    );
    const report = await system.shutdown();
    expect(report.faults.map((fault) => fault.source)).toEqual(['workflow', 'kernel-core']);
    expect(new Set(report.modules.map((entry) => entry.state))).toEqual(new Set(['STOPPED']));
  });

  it('exits non-zero when a module fails to stop after a completed run', async () => {
    const { system } = await fixture({
      createWorkflow: (deps) => {
        const workflow = createFakeWorkflow()(deps);
        const stop = workflow.stop.bind(workflow);
        return Object.assign(workflow, {
          stop: async () => {
            await stop();
            throw new Error('workflow stop failed');
          },
        });
      },
    });
    await system.start();
    expect(await system.run((interaction) => interaction.analyze(command))).toBe(
      EXIT_CODE_SYSTEM_FAULT,
    );
    const report = await system.shutdown();
    expect(report.intent).toBe('FAULT');
    expect(report.faults[0]).toMatchObject({ source: 'supervisor', phase: 'SHUTDOWN' });
    expect(await states(system)).toMatchObject({ workflow: 'STOP_FAILED', fabric: 'STOPPED' });
  });

  it('stops what had started, the failed module included, when the boot fails', async () => {
    const stopped: string[] = [];
    const { system } = await fixture({
      createWorkflow: (deps) =>
        Object.assign(createFakeWorkflow()(deps), {
          start: () => Promise.reject(new Error('workflow start failed')),
          stop: () => {
            stopped.push('workflow');
            return Promise.resolve();
          },
        }),
    });
    await expect(system.start()).rejects.toThrow('workflow start failed');
    expect(stopped).toEqual(['workflow']);
    const report = await system.shutdown();
    expect(report.faults[0]).toMatchObject({ source: 'supervisor', phase: 'BOOT' });
    expect(await states(system)).toMatchObject({
      fabric: 'STOPPED',
      'kernel-core': 'STOPPED',
      workflow: 'STOPPED',
      'user-interaction': 'REGISTERED',
    });
  });
});

describe('process guards', () => {
  it('kills the child processes and exits non-zero on an uncaught error', () => {
    const listeners = new Map<string, (error?: unknown) => void>();
    const calls: string[] = [];
    const target: GuardedProcess = {
      on: (event: string, listener: (error?: unknown) => void) =>
        void listeners.set(event, listener),
      off: (event) => void listeners.delete(event),
      exit: (code) => void calls.push(`exit ${code}`),
    };
    const remove = installProcessGuards({
      killSubprocesses: () => calls.push('kill'),
      log: (line) => calls.push(line.split('\n')[0] ?? ''),
      target,
    });
    listeners.get('unhandledRejection')?.('lost promise');
    expect(calls).toEqual(['fatal: lost promise', 'kill', `exit ${EXIT_CODE_SYSTEM_FAULT}`]);
    listeners.get('exit')?.();
    expect(calls.at(-1)).toBe('kill');
    remove();
    expect(listeners.size).toBe(0);
  });

  it('leaves the first interrupt to UserInteraction and forces the exit on the second', () => {
    const listeners = new Map<string, (error?: unknown) => void>();
    const calls: string[] = [];
    const target: GuardedProcess = {
      on: (event: string, listener: (error?: unknown) => void) =>
        void listeners.set(event, listener),
      off: (event) => void listeners.delete(event),
      exit: (code) => void calls.push(`exit ${code}`),
    };
    const remove = installProcessGuards({
      killSubprocesses: () => calls.push('kill'),
      log: () => calls.push('log'),
      target,
    });
    listeners.get('SIGINT')?.();
    expect(calls).toEqual([]);
    listeners.get('SIGINT')?.();
    expect(calls).toEqual(['log', 'kill', `exit ${EXIT_CODE_INTERRUPTED}`]);
    remove();
    expect(listeners.size).toBe(0);
  });
});
