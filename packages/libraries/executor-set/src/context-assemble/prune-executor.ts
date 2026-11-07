import {
  MEDIA_TYPES,
  canonicalJson,
  type Executor,
  type ExecutorOutcome,
  type PruneExecutorInput,
} from '@multiagentos/contracts';
import { completed, guarded, throwIfAborted } from '../outcome/outcomes.js';
import { retainBytes } from '../retention/retention.js';

/**
 * CONTEXT_PRUNE (ExecutorSet 6.4, M2Design 9.6 step 4.5): tool results cut to their head and their
 * tail, with a line in the middle that says how much was left out and how to read it back. It
 * needs no model and no clock, so the same input always gives the same bytes.
 */
export const PRUNED_MEDIA_TYPE = MEDIA_TYPES.json;

export interface PrunedText {
  readonly toolCallId: string;
  readonly text: string;
  readonly omittedBytes: number;
}

const note = (omitted: number, toolCallId: string): string =>
  `[${String(omitted)} bytes from the middle of this result were left out to make room. read_output with toolCallId ${toolCallId} reads the original.]`;

function pruned(
  item: PruneExecutorInput['items'][number],
  headBytes: number,
  tailBytes: number,
): PrunedText {
  const total = Buffer.byteLength(item.text, 'utf8');
  // A result that fits in the head and the tail is not cut: nothing would be gained.
  if (total <= headBytes + tailBytes) return { ...item, omittedBytes: 0 };
  const head = retainBytes(item.text, headBytes, 'HEAD').head;
  const tail = retainBytes(item.text, tailBytes, 'TAIL').tail;
  const omittedBytes = total - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
  return {
    toolCallId: item.toolCallId,
    text: `${head}\n\n${note(omittedBytes, item.toolCallId)}\n\n${tail}`,
    omittedBytes,
  };
}

export function createPruneExecutor(): Executor<'CONTEXT_PRUNE'> {
  return {
    executionKind: 'CONTEXT_PRUNE',
    execute: (input, environment) =>
      guarded(() => {
        throwIfAborted(environment.signal);
        const items = input.items.map((item) => pruned(item, input.headBytes, input.tailBytes));
        const outcome: ExecutorOutcome = completed({
          output: {
            items: items.filter((item) => item.omittedBytes > 0).length,
            omittedBytes: items.reduce((total, item) => total + item.omittedBytes, 0),
          },
          artifact: { mediaType: PRUNED_MEDIA_TYPE, text: canonicalJson({ items }) },
        });
        return Promise.resolve(outcome);
      }),
  };
}
