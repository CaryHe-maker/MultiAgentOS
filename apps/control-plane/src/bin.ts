#!/usr/bin/env -S node --max-old-space-size=4096
// V8's default heap limit is a quarter of the memory up to a few GB (2.2 GB on a 7.5 GB machine); a
// long session reaches it and the process dies without a word. The flag cannot be set after start.
/**
 * The process entry: runs one command line through
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
