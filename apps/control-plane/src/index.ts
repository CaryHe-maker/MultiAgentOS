/**
 * Composition root and process entry (docs/M1/Infrastructure/ModuleHost.md 2). `config/` loads
 * and validates the system configuration; `bootstrap/` builds every module, the Fabric clients
 * and the Port stubs. `main` starts the Supervisor only and exits with the code UserInteraction
 * recorded.
 */
import { createNodeTerminal, runCli } from '@multiagentos/cli';
import dotenv from 'dotenv';
import { composeSystem } from './bootstrap/compose-system.js';
import { loadSystemConfig } from './config/system-config.js';

export {
  PRODUCT_PARTS,
  composeSystem,
  type ComposeOptions,
  type System,
  type SystemParts,
} from './bootstrap/compose-system.js';
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
 * Runs one command line to its end and resolves with the process exit code. For local
 * development it first loads `.env` from the working directory of MultiAgentOS itself, never
 * from the repository under analysis.
 */
export async function main(argv: readonly string[]): Promise<number> {
  dotenv.config({ quiet: true });
  const terminal = createNodeTerminal();
  const system = await composeSystem({
    config: await loadSystemConfig(process.env),
    terminal,
    credentials: credentialsFrom(process.env),
  });
  await system.start();
  const exitCode = await runCli(argv, system.userInteraction, terminal);
  await system.whenStopped();
  return exitCode;
}
