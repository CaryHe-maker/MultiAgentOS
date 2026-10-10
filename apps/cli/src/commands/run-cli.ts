import { isAbsolute } from 'node:path';
import type { AnalyzeCommand, TerminalPort } from '@multiagentos/user-interaction';
import { Command, CommanderError } from 'commander';

/** The part of UserInteraction the CLI drives. */
export interface CliTarget {
  analyze(command: AnalyzeCommand): Promise<number>;
}

/** Exit code of a command line that could not be parsed. */
const EXIT_CODE_USAGE = 64;

/**
 * Parses `multiagentos analyze --repo <absolute path> [--details] "<goal>"` and resolves with
 * the exit code. It never exits the process: the composition root does that after shutdown.
 */
export async function runCli(
  argv: readonly string[],
  target: CliTarget,
  terminal: Pick<TerminalPort, 'write'>,
): Promise<number> {
  let command: AnalyzeCommand | undefined;
  const program = new Command('multiagentos').exitOverride().configureOutput({
    writeOut: (text) => terminal.write(text),
    writeErr: (text) => terminal.write(text),
  });
  program
    .command('analyze')
    .description('Analyse a repository read-only and print a report with sources')
    .requiredOption('--repo <path>', 'absolute path of the repository')
    .option('--details', 'also show the run summary', false)
    .argument('<goal>', 'the question to answer')
    .action((goal: string, options: { repo: string; details: boolean }) => {
      command = { goal, repositoryPath: options.repo, details: options.details };
    });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : EXIT_CODE_USAGE;
    throw error;
  }
  if (command === undefined) return EXIT_CODE_USAGE;
  if (!isAbsolute(command.repositoryPath)) {
    terminal.write('--repo must be an absolute path\n');
    return EXIT_CODE_USAGE;
  }
  return await target.analyze(command);
}
