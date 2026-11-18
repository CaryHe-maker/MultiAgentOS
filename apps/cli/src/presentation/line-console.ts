import { createInterface } from 'node:readline';
import type {
  Console,
  ConsoleView,
  LiveState,
  TranscriptRecord,
} from '@multiagentos/user-interaction';

/**
 * The console for a terminal that is not a TTY (Module/UserInteraction 9): the transcript and each
 * new question as plain lines, input line by line. Activity is not drawn, because it only redraws.
 */
export function createLineConsoleView(output: NodeJS.WritableStream = process.stdout): ConsoleView {
  let asked: string | undefined;
  const line = (text: string) => output.write(`${text}\n`);
  return {
    print: (record: TranscriptRecord) => {
      if (record.kind === 'USER') line(`> ${record.text}`);
      else if (record.kind === 'REPLY') line(`${record.agentLabel}: ${record.text}`);
      else line(record.text);
    },
    update: (live: LiveState) => {
      const question = live.pending?.text;
      if (question !== undefined && question !== asked) line(question);
      asked = question;
    },
    restoreInput: () => undefined,
  };
}

/** Feeds each input line to the console and turns SIGINT into its interrupt. */
export function readLines(
  input: Pick<Console, 'submit' | 'interrupt'>,
  stdin: NodeJS.ReadableStream = process.stdin,
): () => void {
  const reader = createInterface({ input: stdin });
  reader.on('line', (text) => void input.submit(text));
  const onInterrupt = () => void input.interrupt();
  process.on('SIGINT', onInterrupt);
  return () => {
    process.off('SIGINT', onInterrupt);
    reader.close();
  };
}
