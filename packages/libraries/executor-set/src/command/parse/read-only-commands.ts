import { DEFAULT_READ_ONLY_COMMANDS } from '@multiagentos/contracts';
import type { ParsedCommand, SubCommand } from './command-parser.js';

/**
 * The read-only list (M2Design 5.2): commands that only read. A line made of nothing else runs
 * without a question once the user has allowed `repo.read`, as `read_file` does, and runs in a
 * sandbox that cannot write and has no network. The list is a courtesy, not the protection: what
 * is wrong in it cannot write, it can only fail. It is kept apart from the lists that forbid, and
 * `command.readOnlyCommands` replaces it. The default is in the configuration.
 */
export { DEFAULT_READ_ONLY_COMMANDS };

/** `git <subcommand>` that only reads. */
export const READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = Object.freeze([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'cat-file',
  'shortlog',
  'describe',
  'grep',
]);

/** These touch no file of the repository: a line of them needs no `repo.read` either. */
const NO_REPOSITORY_ACCESS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'true',
  'false',
  ':',
  'pwd',
  'cd',
  'type',
  'which',
  'command',
]);

/** Arguments that make an otherwise reading command write (it would only fail in the sandbox). */
const WRITING_ARGUMENTS: Readonly<Record<string, RegExp>> = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/u,
  sort: /^(-[a-zA-Z]*o[a-zA-Z]*|--output(=.*)?)$/u,
  tree: /^-[a-zA-Z]*o[a-zA-Z]*$/u,
  rg: /^--(pre|pre-glob|hostname-bin)(=.*)?$/u,
};

/** Programs print their version without reading or writing anything. */
const VERSION_PROBES: ReadonlySet<string> = new Set(['--version', '-V', '-v', 'version']);

const GIT_WRITING_ARGUMENT = /^--(output|ext-diff)(=.*)?$/u;

function isReadOnlyCommand(command: SubCommand, names: ReadonlySet<string>): boolean {
  const { name, args } = command;
  // The name must be a literal word, and no path: a file of the repository is not on the list.
  if (name === undefined || name.includes('/')) return false;
  // `git` and `command` on the list stand for their reading subcommands and options only.
  if (name === 'command')
    return names.has('command') && (args[0] === '-v' || args[0] === '-V') && args.length >= 2;
  if (name === 'git') {
    if (!names.has('git')) return false;
    const [subcommand, ...rest] = args;
    if (subcommand === undefined || !READ_ONLY_GIT_SUBCOMMANDS.includes(subcommand)) return false;
    return !rest.some((argument) => GIT_WRITING_ARGUMENT.test(argument));
  }
  if (names.has(name)) {
    const writing = WRITING_ARGUMENTS[name];
    return writing === undefined || !args.some((argument) => writing.test(argument));
  }
  // An empty list switches the shortcut off, the version probes with it.
  return names.size > 0 && args.length === 1 && VERSION_PROBES.has(args[0] ?? '');
}

/** True when a command of the line can read a file of the repository (the line is read-only). */
export function readsRepository(parsed: ParsedCommand): boolean {
  return parsed.subcommands.some(({ name, args }) => {
    if (name === undefined) return true;
    if (NO_REPOSITORY_ACCESS.has(name)) return false;
    // `node --version` opens no file of the repository.
    return !(args.length === 1 && VERSION_PROBES.has(args[0] ?? ''));
  });
}

/**
 * True when every simple command of the line reads only, and nothing in the line writes a file,
 * substitutes a command or hides a name. A line the parser is not sure about is not read-only.
 */
export function isReadOnlyLine(
  parsed: ParsedCommand,
  names: readonly string[] = DEFAULT_READ_ONLY_COMMANDS,
): boolean {
  if (parsed.unreusable.length > 0 || parsed.writesFiles) return false;
  if (parsed.subcommands.length === 0) return false;
  const known = new Set(names);
  return parsed.subcommands.every((command) => isReadOnlyCommand(command, known));
}
