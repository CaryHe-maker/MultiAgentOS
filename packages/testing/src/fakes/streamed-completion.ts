/**
 * A fake provider that answers in one piece (an OpenAI chat-completions JSON body) can answer a
 * request that asked for a stream too: `streamedIfAsked` turns the same answer into the
 * server-sent events a real provider would send, cut into small pieces, with the thinking as
 * `reasoning_content` deltas the way DeepSeek sends it. Tests keep writing their answers once.
 */

interface CompletionMessage {
  readonly content?: string | null;
  readonly reasoning_content?: string | null;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
}

interface Completion {
  readonly id?: string;
  readonly created?: number;
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: CompletionMessage;
    readonly finish_reason?: string;
  }[];
  readonly usage?: unknown;
}

const PIECE = 7;

function pieces(text: string): string[] {
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += PIECE) parts.push(text.slice(at, at + PIECE));
  return parts;
}

/** The events of a streamed answer that says what `body` says. */
export function streamEventsOf(body: Completion): string[] {
  const choice = body.choices?.[0];
  const message = choice?.message ?? {};
  const base = {
    id: body.id ?? 'chatcmpl-streamed',
    object: 'chat.completion.chunk',
    created: body.created ?? 1_767_225_600,
    model: body.model ?? 'deepseek-flash',
  };
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const events = [chunk({ role: 'assistant', content: '' })];
  for (const part of pieces(message.reasoning_content ?? ''))
    events.push(chunk({ reasoning_content: part }));
  for (const part of pieces(message.content ?? '')) events.push(chunk({ content: part }));
  (message.tool_calls ?? []).forEach((call, index) => {
    events.push(
      chunk({
        tool_calls: [
          {
            index,
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: '' },
          },
        ],
      }),
    );
    for (const part of pieces(call.function.arguments))
      events.push(chunk({ tool_calls: [{ index, function: { arguments: part } }] }));
  });
  events.push(chunk({}, choice?.finish_reason ?? 'stop'));
  if (body.usage !== undefined)
    events.push(`data: ${JSON.stringify({ ...base, choices: [], usage: body.usage })}\n\n`);
  events.push('data: [DONE]\n\n');
  return events;
}

/** True when the request body asks for a stream. */
export function asksForStream(init: RequestInit | undefined): boolean {
  if (typeof init?.body !== 'string') return false;
  try {
    return (JSON.parse(init.body) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

/**
 * `response` as the stream the request asked for; a request that did not ask, an error status and
 * anything that is not a chat-completions body come back as they are.
 */
export async function streamedIfAsked(
  init: RequestInit | undefined,
  response: Response,
): Promise<Response> {
  if (!asksForStream(init) || !response.ok) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) return response;
  let body: Completion;
  try {
    body = (await response.clone().json()) as Completion;
  } catch {
    return response;
  }
  if (body.choices === undefined) return response;
  return new Response(streamEventsOf(body).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}
