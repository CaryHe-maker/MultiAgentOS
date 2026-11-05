import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';
import { commandPrefix } from './arity.js';

/**
 * Splits a shell command line into its simple commands with tree-sitter-bash (M2Design 5.2).
 * Quoting, escapes and variable prefixes are read from the syntax tree, never from the text.
 * Whatever cannot be read with certainty is marked: such a command can only be allowed once.
 */

/** One simple command of the line: `git push origin main`, with quotes taken off. */
export interface SubCommand {
  /** The command name, or undefined when it is not a literal (`$CMD`, `$(...)`). */
  readonly name: string | undefined;
  /** The literal words after the name; a word that is not literal keeps its source text. */
  readonly args: readonly string[];
  /** The source text of the command, whitespace-normalised for display and keys. */
  readonly text: string;
  /** True when the name or an argument is not literal. */
  readonly dynamic: boolean;
}

export type UnreusableReason =
  | 'PARSE_ERROR'
  | 'DYNAMIC_COMMAND_NAME'
  | 'COMMAND_SUBSTITUTION'
  | 'PROCESS_SUBSTITUTION'
  | 'EVAL'
  | 'SHELL_C'
  | 'PIPE_TO_SHELL'
  | 'HEREDOC_TO_SHELL'
  | 'NO_COMMAND';

export interface ParsedCommand {
  readonly subcommands: readonly SubCommand[];
  /** Empty when "allow this command / this prefix from now on" may be offered. */
  readonly unreusable: readonly UnreusableReason[];
}

export interface CommandParser {
  parse(text: string): ParsedCommand;
}

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'fish']);

const normalise = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** The literal value of a word node, or undefined when it holds anything that expands. */
function literal(node: Node): string | undefined {
  switch (node.type) {
    case 'word':
    case 'number':
      return node.text.replace(/\\(.)/gsu, '$1');
    case 'raw_string':
      return node.text.slice(1, -1);
    case 'ansii_c_string':
    case 'ansi_c_string':
      return undefined;
    case 'string': {
      // A double-quoted string is literal only when it has nothing but plain content.
      const content = node.namedChildren.every((child) => child.type === 'string_content');
      return content ? node.text.slice(1, -1).replace(/\\(["\\$`])/gu, '$1') : undefined;
    }
    case 'concatenation': {
      const parts = node.namedChildren.map(literal);
      return parts.every((part): part is string => part !== undefined) ? parts.join('') : undefined;
    }
    default:
      return undefined;
  }
}

function subCommandOf(node: Node): SubCommand | undefined {
  if (node.type === 'declaration_command' || node.type === 'unset_command') {
    const name = node.text.split(/\s+/u)[0];
    return {
      name,
      args: node.text.split(/\s+/u).slice(1),
      text: normalise(node.text),
      dynamic: false,
    };
  }
  const nameNode = node.namedChildren.find((child) => child.type === 'command_name');
  const first = nameNode?.namedChildren[0];
  const name = first === undefined ? undefined : literal(first);
  const args: string[] = [];
  let dynamic = name === undefined;
  for (const child of node.namedChildren) {
    if (child.type === 'command_name' || child.type === 'variable_assignment') continue;
    if (child.type.endsWith('redirect')) continue;
    const value = literal(child);
    if (value === undefined) dynamic = true;
    args.push(value ?? child.text);
  }
  return { name, args, text: normalise(node.text), dynamic };
}

function reasonsOf(root: Node, subcommands: readonly SubCommand[]): UnreusableReason[] {
  const reasons = new Set<UnreusableReason>();
  if (root.hasError) reasons.add('PARSE_ERROR');
  if (subcommands.length === 0) reasons.add('NO_COMMAND');
  if (root.descendantsOfType(['command_substitution']).length > 0)
    reasons.add('COMMAND_SUBSTITUTION');
  if (root.descendantsOfType(['process_substitution']).length > 0)
    reasons.add('PROCESS_SUBSTITUTION');
  for (const command of subcommands) {
    if (command.name === undefined) {
      reasons.add('DYNAMIC_COMMAND_NAME');
      continue;
    }
    if (command.name === 'eval') reasons.add('EVAL');
    if (SHELLS.has(command.name) && command.args.some((arg) => /^-[a-z]*c/u.test(arg)))
      reasons.add('SHELL_C');
  }
  for (const pipeline of root.descendantsOfType(['pipeline'])) {
    const stages = pipeline.namedChildren.filter((child) => child.type === 'command');
    for (const stage of stages.slice(1)) {
      const name = subCommandOf(stage)?.name;
      if (name !== undefined && SHELLS.has(name)) reasons.add('PIPE_TO_SHELL');
    }
  }
  for (const statement of root.descendantsOfType(['redirected_statement'])) {
    const body = statement.namedChildren.find((child) => child.type === 'command');
    const hasHeredoc = statement.namedChildren.some((child) => child.type === 'heredoc_redirect');
    const name = body === undefined ? undefined : subCommandOf(body)?.name;
    if (hasHeredoc && name !== undefined && SHELLS.has(name)) reasons.add('HEREDOC_TO_SHELL');
  }
  return [...reasons];
}

let initialised: Promise<CommandParser> | undefined;

/** Loads the grammar once; the returned parser is synchronous. */
export function createCommandParser(): Promise<CommandParser> {
  initialised ??= (async () => {
    await Parser.init();
    const require = createRequire(import.meta.url);
    const wasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'));
    const language = await Language.load(wasm);
    const parser = new Parser();
    parser.setLanguage(language);
    return {
      parse(text: string): ParsedCommand {
        const tree = parser.parse(text);
        if (tree === null) return { subcommands: [], unreusable: ['PARSE_ERROR'] };
        try {
          const nodes = tree.rootNode.descendantsOfType([
            'command',
            'declaration_command',
            'unset_command',
          ]);
          const subcommands = nodes
            .map(subCommandOf)
            .filter((command): command is SubCommand => command !== undefined);
          return { subcommands, unreusable: reasonsOf(tree.rootNode, subcommands) };
        } finally {
          tree.delete();
        }
      },
    };
  })();
  return initialised;
}

/**
 * Commands that run the rest of their line as another command. Their prefix would stand for any
 * command at all (`env rm -rf x`, `timeout 5 sh x`), so none is offered; "this command" still is.
 */
const WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'xargs',
  'nohup',
  'timeout',
  'time',
  'nice',
  'ionice',
  'setsid',
  'sudo',
  'doas',
  'exec',
  'command',
  'builtin',
  'watch',
  'stdbuf',
  'chroot',
  'unshare',
  'strace',
  'ltrace',
  'script',
  'flock',
]);

/** The prefix a "this prefix from now on" entry would hold; undefined when none is safe to offer. */
export function prefixOf(command: SubCommand): string | undefined {
  if (command.name === undefined || command.dynamic || WRAPPERS.has(command.name)) return undefined;
  return commandPrefix([command.name, ...command.args]);
}
