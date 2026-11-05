import { firstMatchingPattern } from './parse/command-match.js';
import { prefixOf, type CommandParser } from './parse/command-parser.js';
import {
  DEFAULT_READ_ONLY_COMMANDS,
  isReadOnlyLine,
  readsRepository,
} from './parse/read-only-commands.js';

/** Appended to by `command.criticalCommands`, never removed from (M2Design 5.2). */
export const DEFAULT_CRITICAL_COMMANDS: readonly string[] = Object.freeze([
  'git push',
  'git remote',
  'npm publish',
  'pnpm publish',
  'yarn publish',
  'cargo publish',
  'docker push',
  'gh',
]);

/** The shape Core decides on; it has no parser of its own (Kernel/Core 5b). */
export interface CommandAnalysisResult {
  readonly text: string;
  readonly subcommands: readonly {
    readonly text: string;
    readonly words: readonly string[];
    readonly prefix?: string;
  }[];
  readonly unreusable: ReturnType<CommandParser['parse']>['unreusable'];
  readonly denied?: string;
  readonly critical?: string;
  /** Every command of the line only reads (the read-only list); see read-only-commands.ts. */
  readonly readOnly: boolean;
  /** A command of a read-only line can read a file of the repository: `repo.read` is needed. */
  readonly readsRepository: boolean;
}

/**
 * The analysis Core asks for: the line split by the syntax tree, why it cannot be reused, and the
 * lists matched on the tree and the text together. `text` is the line as the model wrote it.
 */
export function createCommandAnalyzer(
  parser: CommandParser,
  lists: {
    readonly deniedCommands: readonly string[];
    readonly criticalCommands: readonly string[];
    /** The read-only list; the default one when not given. */
    readonly readOnlyCommands?: readonly string[];
  },
): (command: string) => CommandAnalysisResult {
  const critical = [...new Set([...DEFAULT_CRITICAL_COMMANDS, ...lists.criticalCommands])];
  return (command) => {
    const parsed = parser.parse(command);
    const denied = firstMatchingPattern(parsed, command, lists.deniedCommands);
    const matched = firstMatchingPattern(parsed, command, critical);
    return {
      text: command,
      subcommands: parsed.subcommands.map((sub) => {
        const prefix = prefixOf(sub);
        return {
          text: sub.text,
          words: sub.name === undefined ? sub.args : [sub.name, ...sub.args],
          ...(prefix === undefined ? {} : { prefix }),
        };
      }),
      unreusable: parsed.unreusable,
      // A line that a list forbids or calls critical is never read-only.
      readOnly:
        denied === undefined &&
        matched === undefined &&
        isReadOnlyLine(parsed, lists.readOnlyCommands ?? DEFAULT_READ_ONLY_COMMANDS),
      readsRepository: readsRepository(parsed),
      ...(denied === undefined ? {} : { denied }),
      ...(matched === undefined ? {} : { critical: matched }),
    };
  };
}
