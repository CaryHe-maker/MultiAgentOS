/**
 * Test-only child-process entry for Stage 6.3. It uses real composition, SystemControl and
 * process guards, but fake external modules, so the process can exercise exit paths without
 * implementing Workflow, UserInteraction or ExecutorSet.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubprocessRunner } from '@multiagentos/kernel';
import {
  createFakeExecutorRegistry,
  createFakeGateway,
  createFakeKernelCore,
  createFakeSupervisor,
  createFakeTerminal,
  createFakeUserInteraction,
  createFakeWorkflow,
  type FakeKernelOptions,
} from '@multiagentos/testing';
import { composeSystem, type System } from '../src/bootstrap/compose-system.js';
import { createDeferredFaultReporter } from '../src/bootstrap/deferred-fault-reporter.js';
import { installProcessGuards } from '../src/bootstrap/process-guards.js';
import { defaultSystemConfig } from '../src/config/system-config.js';

const mode = process.argv[2] ?? 'normal';
const dataDir = process.env['ENTRY_DATA_DIR'] ?? join(tmpdir(), 'multiagentos-entry');
const repository = process.env['ENTRY_REPO'] ?? dataDir;
const subprocess = createSubprocessRunner();
const faults = createDeferredFaultReporter(() => undefined);
const removeGuards = installProcessGuards({ killSubprocesses: () => subprocess.killAll() });

const normalCodes: Record<string, number> = {
  cancelled: 130,
};

const kernelOptions: Record<string, FakeKernelOptions> = {
  normal: {},
  failed: { summaryWriteFails: true },
  timeout: { unitScript: () => ({ end: 'RUN_TIMEOUT' }) },
  violation: { unitScript: () => ({ end: 'PATH_ESCAPE' }) },
};

function pending(): Promise<number> {
  setInterval(() => undefined, 1_000);
  return new Promise<number>(() => undefined);
}

async function command(system: System): Promise<number> {
  switch (mode) {
    case 'panic':
      system.reportFault({
        source: 'entry-fixture',
        phase: 'RUN',
        error: new Error('forced panic'),
      });
      return 0;
    case 'sync-throw':
      throw new Error('synchronous failure');
    case 'uncaught':
      setTimeout(() => {
        throw new Error('uncaught failure');
      }, 10);
      return pending();
    case 'unhandled':
      setTimeout(() => {
        void Promise.reject(new Error('unhandled rejection'));
      }, 10);
      return pending();
    case 'first-interrupt': {
      const timer = setInterval(() => undefined, 1_000);
      return new Promise<number>((resolve) => {
        process.once('SIGINT', () => {
          clearInterval(timer);
          void system.shutdown().then(
            () => resolve(130),
            () => resolve(130),
          );
        });
      });
    }
    case 'hang':
      return pending();
    default:
      await system.shutdown();
      return normalCodes[mode] ?? 0;
  }
}

try {
  const system = await composeSystem({
    config: { ...defaultSystemConfig(), dataDir },
    terminal: createFakeTerminal(),
    credentials: { apiKeyFor: () => 'offline-process-fixture' },
    log: () => undefined,
    subprocess,
    reportSystemFault: faults.report,
    parts: {
      createGateway: createFakeGateway(),
      createKernelCore: createFakeKernelCore(kernelOptions[mode] ?? {}),
      createSupervisor: createFakeSupervisor(),
      createExecutorRegistry: () => createFakeExecutorRegistry(),
      createWorkflow: createFakeWorkflow(),
      createUserInteraction: createFakeUserInteraction(),
    },
  });
  faults.bind((fault) => system.reportFault(fault));
  await system.start();
  process.stdout.write('READY\n');
  if (mode === 'normal' || mode === 'failed' || mode === 'timeout' || mode === 'violation') {
    process.exitCode = await system.userInteraction.analyze({
      goal: 'process fixture',
      repositoryPath: repository,
      details: false,
    });
  } else {
    process.exitCode = await system.run(() => command(system));
  }
} catch (error) {
  process.stderr.write(
    `entry failure: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 70;
} finally {
  removeGuards();
  try {
    subprocess.killAll();
  } catch {
    // The process is leaving; the exit code is already decided.
  }
}
