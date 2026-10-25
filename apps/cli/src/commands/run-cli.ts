import { isAbsolute } from 'node:path';
import type { AnalyzeCommand, TerminalPort } from '@multiagentos/user-interaction';
import { Command, CommanderError } from 'commander';
import { CLI_MESSAGES, parserErrorMessage } from '../presentation/cli-messages.js';

/** The part of UserInteraction the CLI drives. */
export interface CliTarget {
  analyze(command: AnalyzeCommand): Promise<number>;
}

export type CliParseResult =
  | { readonly ok: true; readonly command: AnalyzeCommand }
  | { readonly ok: false; readonly exitCode: number };

/** Exit code of a command line that could not be parsed. */
const EXIT_CODE_USAGE = 64;

/** Parses and validates the command before the composition root starts any module. */
export async function parseCli(
  argv: readonly string[],
  terminal: Pick<TerminalPort, 'write'>,
): Promise<CliParseResult> {
  let command: AnalyzeCommand | undefined;
  const program = new Command('multiagentos')
    .exitOverride()
    .configureHelp({ formatHelp: () => CLI_MESSAGES.help })
    .showSuggestionAfterError(false)
    .configureOutput({
      writeOut: (text) => terminal.write(text),
      // Commander messages are developer diagnostics; the catch boundary renders user text.
      writeErr: () => {},
    });
  program
    .command('analyze')
    .description(CLI_MESSAGES.analyze)
    .requiredOption('--repo <path>', CLI_MESSAGES.repository)
    .option('--details', CLI_MESSAGES.details, false)
    .argument('<goal>', CLI_MESSAGES.goal)
    .action((goal: string, options: { repo: string; details: boolean }) => {
      command = { goal, repositoryPath: options.repo, details: options.details };
    });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0)
        terminal.write(parserErrorMessage(error.code) + '\n' + CLI_MESSAGES.help);
      return { ok: false, exitCode: error.exitCode === 0 ? 0 : EXIT_CODE_USAGE };
    }
    throw error;
  }
  if (command === undefined) return { ok: false, exitCode: EXIT_CODE_USAGE };
  if (!isAbsolute(command.repositoryPath)) {
    terminal.write(CLI_MESSAGES.absolutePath + '\n');
    return { ok: false, exitCode: EXIT_CODE_USAGE };
  }
  return { ok: true, command };
}

/** Runs a command already validated by the CLI adapter. */
export function runParsedCli(command: AnalyzeCommand, target: CliTarget): Promise<number> {
  return target.analyze(command);
}

/** Convenience entry for callers that do not need to separate parsing from startup. */
export async function runCli(
  argv: readonly string[],
  target: CliTarget,
  terminal: Pick<TerminalPort, 'write'>,
): Promise<number> {
  const parsed = await parseCli(argv, terminal);
  return parsed.ok ? runParsedCli(parsed.command, target) : parsed.exitCode;
}
