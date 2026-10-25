/**
 * Composition root and process entry (docs/M1/Infrastructure/ModuleHost.md 2). `config/` loads
 * and validates the system configuration; `bootstrap/` builds every module, the Fabric clients
 * and the Port stubs. `main` starts the Supervisor only and exits with the code UserInteraction
 * recorded, or with `EXIT_CODE_SYSTEM_FAULT` when the system did not end on the normal path.
 */
import { createNodeTerminal, parseCli, runParsedCli } from '@multiagentos/cli';
import { createSubprocessRunner } from '@multiagentos/kernel';
import dotenv from 'dotenv';
import { composeSystem, type System } from './bootstrap/compose-system.js';
import { createDeferredFaultReporter } from './bootstrap/deferred-fault-reporter.js';
import { installProcessGuards } from './bootstrap/process-guards.js';
import { EXIT_CODE_SYSTEM_FAULT } from './bootstrap/system-control.js';
import { loadSystemConfig } from './config/system-config.js';

export {
  PRODUCT_PARTS,
  composeSystem,
  type ComposeOptions,
  type System,
  type SystemParts,
} from './bootstrap/compose-system.js';
export { EXIT_CODE_INTERRUPTED, installProcessGuards } from './bootstrap/process-guards.js';
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

/** Secrets come from the environment only and reach nothing but the model-call Executor. */
export function credentialsFrom(env: Readonly<Record<string, string | undefined>>) {
  return { apiKeyFor: (provider: string) => env[`${provider.toUpperCase()}_API_KEY`] };
}

/**
 * Runs one command line to its end and resolves with the process exit code, after every
 * module stopped: the command throwing or a system fault cannot leave modules running. For local
 * development it first loads `.env` from the working directory of MultiAgentOS itself, never
 * from the repository under analysis.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const terminal = createNodeTerminal();
  const parsed = await parseCli(argv, terminal);
  if (!parsed.ok) return parsed.exitCode;

  const subprocess = createSubprocessRunner();
  const faults = createDeferredFaultReporter();
  const removeGuards = installProcessGuards({ killSubprocesses: () => subprocess.killAll() });
  try {
    let system: System;
    try {
      dotenv.config({ quiet: true });
      system = await composeSystem({
        config: await loadSystemConfig(process.env),
        terminal,
        credentials: credentialsFrom(process.env),
        subprocess,
        reportSystemFault: faults.report,
      });
    } catch (error) {
      // Configuration, Catalog, factory or assembly failure before a System exists.
      faults.report({ source: 'composition-root', phase: 'BOOT', error });
      return EXIT_CODE_SYSTEM_FAULT;
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
      return await system.run((userInteraction) => runParsedCli(parsed.command, userInteraction));
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
  }
}
