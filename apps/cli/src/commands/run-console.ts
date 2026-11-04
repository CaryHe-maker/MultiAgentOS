import type { Console, ConsoleView } from '@multiagentos/user-interaction';
import { createInkConsole } from '../presentation/ink-console.js';
import { createLineConsoleView, readLines } from '../presentation/line-console.js';
import type { MasCommand } from './parse-cli.js';

type ConsoleInput = Pick<Console, 'submit' | 'interrupt' | 'withdrawLast'>;

/** The terminal side of the console: a view to build the Console with, then its input. */
export interface Terminal {
  readonly view: ConsoleView;
  /** Starts reading input for the console; the result stops it. */
  attach(input: ConsoleInput): () => void;
}

/** Ink on a TTY; plain lines otherwise (Module/UserInteraction 6). */
export function createTerminal(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): Terminal {
  if (stdin.isTTY && stdout.isTTY) {
    const ink = createInkConsole(stdin, stdout);
    return {
      view: ink.store,
      attach: (input) => {
        const instance = ink.mount(input);
        return () => {
          instance.unmount();
        };
      },
    };
  }
  return {
    view: createLineConsoleView(stdout),
    attach: (input) => readLines(input, stdin),
  };
}

/**
 * Runs one parsed command against a started system and resolves with the exit code once the
 * user left (interactive) or the run finished and the system was asked to shut down (`mas run`).
 */
export async function runCommand(
  command: MasCommand,
  console: Console,
  terminal: Terminal,
  template?: { readonly id: string; readonly version: string },
): Promise<number> {
  const detach = terminal.attach(console);
  try {
    if (command.kind === 'INTERACTIVE') {
      const exited = console.exited();
      await console.start();
      await exited;
      return console.exitCode;
    }
    if (template === undefined) throw new Error('A run needs the template it starts');
    const code = await console.run(template, command.goal);
    await console.shutdown();
    return code;
  } finally {
    detach();
  }
}
