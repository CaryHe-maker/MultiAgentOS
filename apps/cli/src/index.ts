/**
 * CLI adapter of UserInteraction (docs/M1/Module/UserInteraction.md 3): parses
 * `multiagentos analyze` with Commander under `commands/`, talks to the terminal under
 * `presentation/`, and calls only the public entry of `@multiagentos/user-interaction`.
 */
export { runCli, type CliTarget } from './commands/run-cli.js';
export { createNodeTerminal } from './presentation/node-terminal.js';
