import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { CLI_MESSAGES, parserErrorMessage } from '../presentation/cli-messages.js';

/** The template `mas run` uses when only a goal is given. */
const DEFAULT_TEMPLATE = 'mission';

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
    }
  | {
      /** Reads a Session log and prints it; starts no module and takes no lock. */
      readonly kind: 'LOG';
      readonly repo?: string;
      /** A number from the list, a Session id or the start of one; absent means the latest. */
      readonly session?: string;
      readonly turn?: number;
      readonly full: boolean;
      readonly json: boolean;
      readonly list: boolean;
    };

/** The commands that run a conversation or a template, as opposed to reading a log. */
export type RunningCommand = Exclude<MasCommand, { readonly kind: 'LOG' }>;

export type CliParseResult =
  | { readonly ok: true; readonly command: MasCommand }
  | { readonly ok: false; readonly exitCode: number };

/** Exit code of a command line that could not be parsed. */
export const EXIT_CODE_USAGE = 64;

interface CommonOptions {
  readonly repo?: string;
  readonly readonly: boolean;
}

interface LogOptions {
  readonly repo?: string;
  readonly turn?: number;
  readonly full: boolean;
  readonly json: boolean;
  readonly list: boolean;
}

function positiveInteger(value: string): number {
  if (!/^[1-9]\d{0,5}$/u.test(value)) throw new InvalidArgumentError('');
  return Number(value);
}

/** Parses the command line before the composition root starts any module. */
export async function parseCli(
  argv: readonly string[],
  write: (text: string) => void,
): Promise<CliParseResult> {
  let command: MasCommand | undefined;
  const program = new Command('mas')
    .exitOverride()
    // Without this the program takes `--repo` and `--readonly` from anywhere on the line, also
    // after a subcommand, and the subcommand never sees them.
    .enablePositionalOptions()
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
    .argument('[goal]', CLI_MESSAGES.goal)
    .action((first: string, second: string | undefined, options: CommonOptions) => {
      // `mas run "<goal>"` is a long task of the built-in template mission (Orchestration 10.1).
      const [template, goal] = second === undefined ? [DEFAULT_TEMPLATE, first] : [first, second];
      command = { kind: 'RUN', template, goal, readonly: options.readonly, ...repoOf(options) };
    });
  program
    .command('log')
    .description(CLI_MESSAGES.log)
    .option('--repo <path>', CLI_MESSAGES.repository)
    .option('--turn <n>', CLI_MESSAGES.logTurn, positiveInteger)
    .option('--full', CLI_MESSAGES.logFull, false)
    .option('--json', CLI_MESSAGES.logJson, false)
    .option('--list', CLI_MESSAGES.logList, false)
    .argument('[session]', CLI_MESSAGES.logSession)
    .action((session: string | undefined, options: LogOptions) => {
      command = {
        kind: 'LOG',
        full: options.full,
        json: options.json,
        list: options.list,
        ...repoOf(options),
        ...(session === undefined ? {} : { session }),
        ...(options.turn === undefined ? {} : { turn: options.turn }),
      };
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

const repoOf = (options: { readonly repo?: string }) =>
  options.repo === undefined ? {} : { repo: options.repo };
