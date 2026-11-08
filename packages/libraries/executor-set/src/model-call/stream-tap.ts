import type { ModelProgressEvent } from '@multiagentos/contracts';

/** The thinking a streamed chunk carries; the OpenAI adapter does not read DeepSeek's field. */
export function reasoningDeltaOf(raw: unknown): string | undefined {
  const delta = (raw as { choices?: { delta?: { reasoning_content?: unknown } }[] } | null)
    ?.choices?.[0]?.delta?.reasoning_content;
  return typeof delta === 'string' && delta.length > 0 ? delta : undefined;
}

interface ToolCallDelta {
  readonly function?: { readonly name?: string };
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
 * it is published. It stands on
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

  const onDelta = (delta: ChunkDelta): void => {
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0)
      tell({ kind: 'REASONING', delta: delta.reasoning_content });
    const writes = (delta.tool_calls ?? []).some((piece) =>
      answerTools.has(piece.function?.name ?? ''),
    );
    if (writes && !answering) {
      answering = true;
      tell({ kind: 'ANSWER' });
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
