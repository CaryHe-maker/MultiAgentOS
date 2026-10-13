/**
 * Composition root and process entry (docs/M1/Infrastructure/ModuleHost.md 2). `config/` loads
 * and validates the system configuration; `bootstrap/` builds every module, the Fabric clients
 * and the Port stubs. `main` starts the Supervisor only and exits with the code UserInteraction
 * recorded, or with `EXIT_CODE_SYSTEM_FAULT` when the system did not end on the normal path.
 */
import { createNodeTerminal, parseCli, runParsedCli } from '@multiagentos/cli';
import dotenv from 'dotenv';
import { composeSystem } from './bootstrap/compose-system.js';
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
  dotenv.config({ quiet: true });
  const system = await composeSystem({
    config: await loadSystemConfig(process.env),
    terminal,
    credentials: credentialsFrom(process.env),
  });
  const removeGuards = installProcessGuards({ killSubprocesses: () => system.killSubprocesses() });
  try {
    try {
      await system.start();
    } catch {
      // The control already stopped what had started and wrote the fault to stderr.
      return EXIT_CODE_SYSTEM_FAULT;
    }
    return await system.run((userInteraction) => runParsedCli(parsed.command, userInteraction));
  } finally {
    removeGuards();
  }
}
