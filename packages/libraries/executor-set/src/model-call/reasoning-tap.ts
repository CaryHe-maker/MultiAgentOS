import type { ModelProgressEvent } from '@multiagentos/contracts';

/** The thinking a streamed chunk carries; the OpenAI adapter does not read DeepSeek's field. */
export function reasoningDeltaOf(raw: unknown): string | undefined {
  const delta = (raw as { choices?: { delta?: { reasoning_content?: unknown } }[] } | null)
    ?.choices?.[0]?.delta?.reasoning_content;
  return typeof delta === 'string' && delta.length > 0 ? delta : undefined;
}

/**
 * Reads the server-sent events of a streamed answer as their bytes arrive, and tells the thinking
 * in them. It stands on the network side of the provider SDK on purpose: the SDK reads ahead until
 * the first piece of the answer proper (text or a tool call) before it passes the stream on, and
 * thinking comes first, so through the SDK it would reach the screen only when it is over.
 * Anything it cannot read is skipped; the SDK still reads the same bytes for the result.
 */
export function reasoningTap(
  tell: (event: ModelProgressEvent) => void,
): (bytes: Uint8Array) => void {
  const decoder = new TextDecoder();
  let pending = '';
  return (bytes) => {
    pending += decoder.decode(bytes, { stream: true });
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end).replace(/\r$/u, '');
      pending = pending.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (data.length === 0 || data === '[DONE]') continue;
      try {
        const delta = reasoningDeltaOf(JSON.parse(data));
        if (delta !== undefined) tell({ kind: 'REASONING', delta });
      } catch {
        // Not JSON, or not a chunk of ours: nothing to show.
      }
    }
  };
}
