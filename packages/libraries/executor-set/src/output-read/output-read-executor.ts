import { MEDIA_TYPES, type Executor, type OutputReadExecutorInput } from '@multiagentos/contracts';
import { completed, guarded, rejected } from '../outcome/outcomes.js';
import { previewLimitsOf, retainItems, type PreviewLimits } from '../retention/retention.js';

export const DEFAULT_OUTPUT_READ_LINES = 2000;

interface NumberedLine {
  readonly number: number;
  readonly text: string;
}

function linesOf(content: string): readonly NumberedLine[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text, index) => ({ number: index + 1, text }));
}

function read(input: OutputReadExecutorInput, limits: PreviewLimits) {
  const { toolCallId, pattern } = input;
  const all = linesOf(input.content);
  const selected = pattern === undefined ? all : all.filter((l) => l.text.includes(pattern));
  const offset = input.offset ?? 1;
  const matched = pattern === undefined ? {} : { matchedLines: selected.length };
  // A pattern that matches nothing is an answer, and only a window past a real end is an error.
  if (offset > Math.max(selected.length, 1)) return undefined;
  const wanted = selected.slice(
    offset - 1,
    offset - 1 + (input.limit ?? DEFAULT_OUTPUT_READ_LINES),
  );
  const width = String(all.length).length;
  const { kept } = retainItems(
    wanted.map(({ number, text }) => `${String(number).padStart(width)} | ${text}`),
    limits,
  );
  const first = wanted[0];
  const last = wanted[kept.length - 1];
  const omittedLines = selected.length - (offset - 1) - kept.length;
  const range =
    first === undefined || last === undefined
      ? 'no lines'
      : `lines ${String(first.number)}-${String(last.number)}`;
  const header = `${toolCallId}: ${range} of ${String(all.length)}${
    pattern === undefined ? '' : `, ${String(selected.length)} containing the pattern`
  }`;
  const footer =
    omittedLines > 0
      ? [`${String(omittedLines)} more; continue with offset ${String(offset + kept.length)}`]
      : [];
  return {
    output: {
      toolCallId,
      totalLines: all.length,
      ...matched,
      startLine: first?.number ?? 1,
      endLine: last?.number ?? 0,
      omittedLines,
    },
    text: [header, ...kept, ...footer].join('\n'),
  };
}

/**
 * OUTPUT_READ (ExecutorSet 5a): one window of a full output Execution has already resolved. It
 * touches no store, file or network, and the same input gives the same bytes.
 */
export function createOutputReadExecutor(): Executor<'OUTPUT_READ'> {
  return {
    executionKind: 'OUTPUT_READ',
    execute: (input, environment) =>
      guarded(() => {
        const result = read(input, previewLimitsOf(environment));
        return Promise.resolve(
          result === undefined
            ? rejected('INVALID_RANGE')
            : completed({
                output: result.output,
                artifact: { mediaType: MEDIA_TYPES.fileText, text: result.text },
              }),
        );
      }),
  };
}
