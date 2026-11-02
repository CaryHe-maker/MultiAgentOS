/**
 * CLI adapter of UserInteraction (Module/UserInteraction 4 and 6): parses `mas` and `mas run`
 * with Commander under `commands/`, and draws the console with Ink, or as plain lines when the
 * terminal is not a TTY, under `presentation/`. It calls only the public entry of
 * `@multiagentos/user-interaction`.
 */
export {
  EXIT_CODE_USAGE,
  parseCli,
  type CliParseResult,
  type MasCommand,
} from './commands/parse-cli.js';
export { createTerminal, runCommand, type Terminal } from './commands/run-console.js';
export { CLI_MESSAGES } from './presentation/cli-messages.js';
