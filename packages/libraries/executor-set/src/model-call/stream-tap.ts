import type { ModelProgressEvent } from '@multiagentos/contracts';
import { JsonStringField } from './json-string-field.js';

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
 * them for the person watching: the thinking, and the text the model writes for the user, which is
 * either plain text or the text argument of a tool call such as a reply (`liveText`: tool name to
 * the name of its argument). It stands on the network side of the provider SDK on purpose: the SDK
 * reads ahead until the first piece of the answer proper before it passes the stream on, and the
 * thinking comes first, so through the SDK nothing would reach the screen until the thinking is
 * over. Anything it cannot read is skipped; the SDK reads the same bytes for the result.
 */
export function streamTap(
  tell: (event: ModelProgressEvent) => void,
  liveText: ReadonlyMap<string, string> = new Map(),
): (bytes: Uint8Array) => void {
  const decoder = new TextDecoder();
  let pending = '';
  /** Per tool call of the answer: the tool it names and, for a live one, the reader of its text. */
  const calls = new Map<number, { name: string; reader: JsonStringField | undefined }>();

  const onDelta = (delta: ChunkDelta): void => {
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0)
      tell({ kind: 'REASONING', delta: delta.reasoning_content });
    if (typeof delta.content === 'string' && delta.content.length > 0)
      tell({ kind: 'TEXT', delta: delta.content });
    for (const piece of delta.tool_calls ?? []) {
      const index = piece.index ?? 0;
      let call = calls.get(index);
      const name = piece.function?.name;
      if (call === undefined || (name !== undefined && name.length > 0 && call.name === '')) {
        const field = name === undefined ? undefined : liveText.get(name);
        call = {
          name: name ?? '',
          reader: field === undefined ? undefined : new JsonStringField(field),
        };
        calls.set(index, call);
      }
      const written = piece.function?.arguments;
      if (call.reader === undefined || typeof written !== 'string') continue;
      const text = call.reader.feed(written);
      if (text.length > 0) tell({ kind: 'TEXT', delta: text });
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
