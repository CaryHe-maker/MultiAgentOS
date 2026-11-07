/**
 * Test-only child-process entry for the exit paths of the composition root. It runs the real
 * composition, SystemControl and process guards on a copy of the `bookshelf` fixture; only the
 * provider's HTTP API is scripted, and one mode replaces an Executor's verdict.
 */
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseCli, runCommand } from '@multiagentos/cli';
import type { ExecutorRegistry } from '@multiagentos/contracts';
import { createExecutorRegistry } from '@multiagentos/executor-set';
import { createSubprocessRunner } from '@multiagentos/kernel';
import { composeSystem, type System } from '../src/bootstrap/compose-system.js';
import { createDeferredFaultReporter } from '../src/bootstrap/deferred-fault-reporter.js';
import { installProcessGuards } from '../src/bootstrap/process-guards.js';
import { defaultSystemConfig } from '../src/config/system-config.js';
import { answeringTerminal, prepareRepository } from './system/analyze-template/harness.js';
import { scriptedProvider } from './system/analyze-template/scripted-provider.js';
import { TASKS } from './system/analyze-template/tasks.js';

const mode = process.argv[2] ?? 'normal';
const dataDir = process.env['ENTRY_DATA_DIR'] ?? join(tmpdir(), 'multiagentos-entry');
const repository = join(process.env['ENTRY_REPO'] ?? dataDir, 'repo');
const subprocess = createSubprocessRunner();
const faults = createDeferredFaultReporter(() => undefined);
const removeGuards = installProcessGuards({ killSubprocesses: () => subprocess.killAll() });

/** Modes that run `mas run analyze` to its end; the others run a command of their own. */
const RUNS = new Set(['normal', 'failed', 'violation']);

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
          void system.console.shutdown().then(
            () => resolve(130),
            () => resolve(130),
          );
        });
        // READY comes before the command runs; a signal sent on READY could beat this handler.
        process.stdout.write('HANDLER_INSTALLED\n');
      });
    }
    default:
      await system.console.shutdown();
      return mode === 'cancelled' ? 130 : 0;
  }
}

/** `violation` makes every read look like a path escape; the Kernel converges the run. */
function executors(): ExecutorRegistry {
  const registry = createExecutorRegistry();
  if (mode !== 'violation') return registry;
  return {
    ...registry,
    FILE_READ: {
      executionKind: 'FILE_READ',
      execute: () => Promise.resolve({ outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' }),
    },
  };
}

/** The F1 script; `failed` answers every model request with an authentication error. */
function provider(): typeof globalThis.fetch {
  const task = TASKS.find((each) => each.id === 'F1');
  if (task === undefined) throw new Error('the F1 task is missing');
  if (mode !== 'failed') return scriptedProvider(task.script).fetch;
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }),
    );
}

try {
  await prepareRepository('bookshelf', repository);
  globalThis.fetch = provider();
  const terminal = answeringTerminal();
  const system = await composeSystem({
    config: { ...defaultSystemConfig(), dataDir },
    repositoryRoot: await realpath(repository),
    preset: 'standard',
    view: terminal.view,
    credentials: { apiKeyFor: () => 'offline-process-fixture' },
    executors: executors(),
    log: () => undefined,
    subprocess,
    reportSystemFault: faults.report,
  });
  faults.bind((fault) => system.reportFault(fault));
  await system.start();
  process.stdout.write('READY\n');
  if (RUNS.has(mode)) {
    const parsed = await parseCli(['run', 'analyze', 'process fixture'], () => undefined);
    if (!parsed.ok) throw new Error('the fixture command line is invalid');
    const template = system.templateRef('analyze');
    process.exitCode = await system.run((console) =>
      runCommand(parsed.command, console, terminal, template),
    );
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
