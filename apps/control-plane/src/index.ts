/**
 * Composition root and process entry (Infrastructure/ModuleHost 2). `config/` loads and checks
 * the system configuration; `bootstrap/` builds every module, the Fabric clients and the Port
 * stubs. `main` takes the instance lock, starts the Supervisor only, runs the parsed command and
 * exits with its code, or with `EXIT_CODE_SYSTEM_FAULT` when the system did not end normally.
 */
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CLI_MESSAGES, createTerminal, parseCli, runCommand } from '@multiagentos/cli';
import { createSubprocessRunner } from '@multiagentos/kernel';
import { FileInstanceLock } from '@multiagentos/persistence';
import dotenv from 'dotenv';
import { composeSystem, type System } from './bootstrap/compose-system.js';
import { createDeferredFaultReporter } from './bootstrap/deferred-fault-reporter.js';
import { installProcessGuards } from './bootstrap/process-guards.js';
import { EXIT_CODE_SYSTEM_FAULT } from './bootstrap/system-control.js';
import { loadSystemConfig } from './config/system-config.js';
import { runLogCommand } from './log-command.js';

export { composeSystem, type ComposeOptions, type System } from './bootstrap/compose-system.js';
export { installProcessGuards } from './bootstrap/process-guards.js';
export {
  EXIT_CODE_SYSTEM_FAULT,
  type ShutdownTimeouts,
  type StopReport,
  type SystemFaultRecord,
} from './bootstrap/system-control.js';
export {
  ConfigError,
  assertSystemConfig,
  defaultSystemConfig,
  loadSystemConfig,
  type SystemConfig,
} from './config/system-config.js';

/** The version the instance lock records for whoever finds it held. */
const VERSION = '0.2.0';

/** Secrets come from the environment only and reach nothing but the model-call Executor. */
export function credentialsFrom(env: Readonly<Record<string, string | undefined>>) {
  return { apiKeyFor: (provider: string) => env[`${provider.toUpperCase()}_API_KEY`] };
}

/**
 * Runs one command line to its end and resolves with the process exit code, after every
 * module stopped. For local development it first loads `.env` from the working directory of
 * MultiAgentOS itself, never from the repository the process works on.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const write = (text: string) => void process.stdout.write(text);
  const parsed = await parseCli(argv, write);
  if (!parsed.ok) return parsed.exitCode;
  const { command } = parsed;

  if (command.kind === 'LOG') {
    // Reads a log: no module, no lock, no model.
    try {
      dotenv.config({ quiet: true });
      const { dataDir } = await loadSystemConfig(process.env);
      return await runLogCommand(command, {
        dataDir,
        cwd: process.cwd(),
        write,
        writeError: (text) => void process.stderr.write(text),
      });
    } catch {
      process.stderr.write('配置有误，无法找到数据目录。\n');
      return EXIT_CODE_SYSTEM_FAULT;
    }
  }

  const subprocess = createSubprocessRunner();
  const faults = createDeferredFaultReporter();
  const removeGuards = installProcessGuards({ killSubprocesses: () => subprocess.killAll() });
  let releaseLock: () => Promise<void> = () => Promise.resolve();
  try {
    let system: System;
    const terminal = createTerminal();
    try {
      dotenv.config({ quiet: true });
      const config = await loadSystemConfig(process.env);
      // Before any module starts, and before the Supervisor empties tmp/ (ModuleHost 2).
      const lock = new FileInstanceLock(config.dataDir, { version: VERSION });
      const held = await lock.acquire();
      if (held.outcome === 'HELD') {
        const { pid, processStartedAt } = held.owner;
        const host = 'hostname' in held.owner ? `${held.owner.hostname} 上的` : '';
        process.stderr.write(
          `另一个 mas 进程正在使用 ${config.dataDir}：${host}进程 ${String(pid)}，启动于 ${processStartedAt}。\n`,
        );
        return EXIT_CODE_SYSTEM_FAULT;
      }
      releaseLock = () => held.release();
      system = await composeSystem({
        config,
        repositoryRoot: await realpath(resolve(command.repo ?? process.cwd())),
        preset: command.readonly ? 'readonly' : 'standard',
        view: terminal.view,
        credentials: credentialsFrom(process.env),
        subprocess,
        reportSystemFault: faults.report,
      });
    } catch (error) {
      // Configuration, lock, catalog, factory or assembly failure before a System exists.
      faults.report({ source: 'composition-root', phase: 'BOOT', error });
      return EXIT_CODE_SYSTEM_FAULT;
    }

    const template = command.kind === 'RUN' ? system.templateRef(command.template) : undefined;
    if (command.kind === 'RUN' && template === undefined) {
      write(`${CLI_MESSAGES.unknownTemplate(command.template)}\n`);
      return 64;
    }

    // The composition-time reporter buffers faults until the real panic entry exists.
    faults.bind((fault) => system.reportFault(fault));

    try {
      await system.start();
    } catch {
      // The control already wrote the fault and stopped what had started.
      return EXIT_CODE_SYSTEM_FAULT;
    }

    try {
      return await system.run((console) => runCommand(command, console, terminal, template));
    } catch (error) {
      system.reportFault({ source: 'entry', phase: 'RUN', error });
      await system.shutdown().catch(() => undefined);
      return EXIT_CODE_SYSTEM_FAULT;
    }
  } finally {
    removeGuards();
    try {
      subprocess.killAll();
    } catch {
      // The entry still has to return; a cleanup failure is reported by the control path.
    }
    await releaseLock().catch(() => undefined);
  }
}
