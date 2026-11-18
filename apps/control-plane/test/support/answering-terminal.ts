import type { Terminal } from '@multiagentos/cli';
import type { Console, ConsoleView } from '@multiagentos/user-interaction';

/**
 * A terminal that writes the transcript to `written` and answers every question the console
 * asks with yes, as a user who allows the repository and trusts its instructions would.
 */
export function answeringTerminal(): Terminal & { readonly written: string[] } {
  const written: string[] = [];
  let console: Pick<Console, 'submit'> | undefined;
  let asked: string | undefined;
  const view: ConsoleView = {
    print: (record) => {
      written.push(`${record.kind}: ${record.text}\n`);
    },
    update: (live) => {
      const question = live.pending?.text;
      if (question !== undefined && question !== asked && console !== undefined) {
        written.push(`QUESTION: ${question}\n`);
        void console.submit('y');
      }
      asked = question;
    },
    restoreInput: () => undefined,
  };
  return {
    view,
    written,
    attach: (input) => {
      console = input;
      return () => {
        console = undefined;
      };
    },
  };
}
