import { Command, CommanderError } from 'commander';
import { CLI_MESSAGES, parserErrorMessage } from '../presentation/cli-messages.js';

/** What the process was asked to do (Module/UserInteraction 4). */
export type MasCommand =
  | {
      readonly kind: 'INTERACTIVE';
      /** As given; the composition root takes its realpath. Absent means the working directory. */
      readonly repo?: string;
      readonly readonly: boolean;
    }
  | {
      readonly kind: 'RUN';
      readonly repo?: string;
      readonly readonly: boolean;
      readonly template: string;
      readonly goal: string;
    };

export type CliParseResult =
  | { readonly ok: true; readonly command: MasCommand }
  | { readonly ok: false; readonly exitCode: number };

/** Exit code of a command line that could not be parsed. */
export const EXIT_CODE_USAGE = 64;

interface CommonOptions {
  readonly repo?: string;
  readonly readonly: boolean;
}

/** Parses the command line before the composition root starts any module. */
export async function parseCli(
  argv: readonly string[],
  write: (text: string) => void,
): Promise<CliParseResult> {
  let command: MasCommand | undefined;
  const program = new Command('mas')
    .exitOverride()
    .configureHelp({ formatHelp: () => CLI_MESSAGES.help })
    .showSuggestionAfterError(false)
    .configureOutput({
      writeOut: write,
      // Commander messages are developer diagnostics; the catch boundary renders user text.
      writeErr: () => {},
    })
    .option('--repo <path>', CLI_MESSAGES.repository)
    .option('--readonly', CLI_MESSAGES.readonly, false)
    .action((options: CommonOptions) => {
      command = { kind: 'INTERACTIVE', readonly: options.readonly, ...repoOf(options) };
    });
  program
    .command('run')
    .description(CLI_MESSAGES.run)
    .option('--repo <path>', CLI_MESSAGES.repository)
    .option('--readonly', CLI_MESSAGES.readonly, false)
    .argument('<template>', CLI_MESSAGES.template)
    .argument('<goal>', CLI_MESSAGES.goal)
    .action((template: string, goal: string, options: CommonOptions) => {
      command = { kind: 'RUN', template, goal, readonly: options.readonly, ...repoOf(options) };
    });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) write(`${parserErrorMessage(error.code)}\n${CLI_MESSAGES.help}`);
      return { ok: false, exitCode: error.exitCode === 0 ? 0 : EXIT_CODE_USAGE };
    }
    throw error;
  }
  if (command === undefined) return { ok: false, exitCode: EXIT_CODE_USAGE };
  return { ok: true, command };
}

const repoOf = (options: CommonOptions) =>
  options.repo === undefined ? {} : { repo: options.repo };
