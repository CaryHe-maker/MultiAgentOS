import type { ModelProgressEvent } from '@multiagentos/contracts';
import { JsonStringField } from './json-string-field.js';

/** The argument that names the file a tool works on. */
const TARGET_FIELD = 'path';
/** What of a path goes to the screen. */
const TARGET_MAX = 200;

/** The thinking a streamed chunk carries; the OpenAI adapter does not read DeepSeek's field. */
export function reasoningDeltaOf(raw: unknown): string | undefined {
  const delta = (raw as { choices?: { delta?: { reasoning_content?: unknown } }[] } | null)
    ?.choices?.[0]?.delta?.reasoning_content;
  return typeof delta === 'string' && delta.length > 0 ? delta : undefined;
}

interface ToolCallDelta {
  readonly index?: number;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface ChunkDelta {
  readonly content?: unknown;
  readonly reasoning_content?: unknown;
  readonly tool_calls?: readonly ToolCallDelta[];
}

/**
 * Reads the server-sent events of a streamed answer as their bytes arrive, and tells what is in
 * them for the person watching: the thinking, and the moment the model begins its answer for the
 * user: the call of an answer tool, the reply (`answerTools`: their names). Plain text that comes
 * with other tool calls is not an answer, and the text itself is not passed on: it is shown when
 * it is published. For any other tool call it tells the tool as soon as its name is written and,
 * once its `path` argument is complete, the file it names. It stands on
 * the network side of the provider SDK on purpose: the SDK reads ahead until the first piece of the
 * answer proper before it passes the stream on, and the thinking comes first, so through the SDK
 * nothing would reach the screen until the thinking is over. Anything it cannot read is skipped;
 * the SDK reads the same bytes for the result.
 */
export function streamTap(
  tell: (event: ModelProgressEvent) => void,
  answerTools: ReadonlySet<string> = new Set(),
): (bytes: Uint8Array) => void {
  const decoder = new TextDecoder();
  let pending = '';
  let answering = false;
  /** Per tool call of the answer: its name and the reader of the file it names. */
  const calls = new Map<number, { name: string; reader: JsonStringField; path: string }>();

  const onDelta = (delta: ChunkDelta): void => {
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0)
      tell({ kind: 'REASONING', delta: delta.reasoning_content });
    for (const piece of delta.tool_calls ?? []) {
      const name = piece.function?.name ?? '';
      if (answerTools.has(name)) {
        if (!answering) {
          answering = true;
          tell({ kind: 'ANSWER' });
        }
        continue;
      }
      const index = piece.index ?? 0;
      let call = calls.get(index);
      if (call === undefined && name.length > 0) {
        call = { name, reader: new JsonStringField(TARGET_FIELD), path: '' };
        calls.set(index, call);
        tell({ kind: 'TOOL', name });
      }
      const written = piece.function?.arguments;
      if (call === undefined || call.reader.done || typeof written !== 'string') continue;
      call.path += call.reader.feed(written);
      if (call.reader.done && call.path.length > 0)
        tell({ kind: 'TOOL', name: call.name, target: call.path.slice(0, TARGET_MAX) });
    }
  };

  return (bytes) => {
    pending += decoder.decode(bytes, { stream: true });
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end).replace(/\r$/u, '');
      pending = pending.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (data.length === 0 || data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data) as { choices?: { delta?: ChunkDelta }[] } | null;
        const delta = chunk?.choices?.[0]?.delta;
        if (delta !== undefined) onDelta(delta);
      } catch {
        // Not JSON, or not a chunk of ours: nothing to show.
      }
    }
  };
}
