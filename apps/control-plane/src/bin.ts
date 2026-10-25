#!/usr/bin/env node
/**
 * The process entry (docs/M1/Infrastructure/ModuleHost.md 2): runs one command line through
 * `main` and ends the process with its exit code. `main` already installs the process guards
 * and stops every module, so nothing else belongs here. It sets `process.exitCode` instead of
 * calling `process.exit`, so that what was written to the terminal is flushed first.
 */
import { EXIT_CODE_SYSTEM_FAULT, main } from './index.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Composing failed (configuration, catalog or a factory): no module was started.
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = EXIT_CODE_SYSTEM_FAULT;
}
