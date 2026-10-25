/**
 * An offline stand-in for the model provider's HTTP API (OpenAI chat completions, the protocol
 * of the DeepSeek models). It answers each request with the next scripted turn of the agent
 * that sent it, so the whole product chain, the provider SDK included, runs without network.
 */

/** One tool call the scripted model makes; `arguments` is sent as its JSON text. */
export interface ScriptedCall {
  readonly name: string;
  readonly arguments: unknown;
}

export interface ScriptedTurn {
  readonly calls: readonly ScriptedCall[];
  readonly text?: string;
}

/** The turns of each agent in order; the planner is told apart by its handoff tool. */
export interface ModelScript {
  readonly planner: readonly ScriptedTurn[];
  readonly codeViewer: readonly ScriptedTurn[];
  /** The code viewer repeats its last turn for ever, as a model stuck in a loop would. */
  readonly endless?: boolean;
}

/** What the provider saw; the harness checks it for secrets and for unused turns. */
export interface ProviderLog {
  readonly bodies: string[];
  readonly hosts: string[];
  readonly problems: string[];
  remainingTurns(): number;
}

const PROVIDER_HOSTS = new Set(['api.deepseek.com']);

const toolNamesOf = (body: unknown): string[] => {
  const tools = (body as { tools?: { function?: { name?: unknown } }[] }).tools ?? [];
  return tools.flatMap((tool) =>
    typeof tool.function?.name === 'string' ? [tool.function.name] : [],
  );
};

function completion(turn: ScriptedTurn, prefix: string): Response {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${prefix}`,
      object: 'chat.completion',
      created: 1_767_225_600,
      model: 'deepseek-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: turn.text ?? null,
            ...(turn.calls.length === 0
              ? {}
              : {
                  tool_calls: turn.calls.map((call, index) => ({
                    id: `call_${prefix}_${index}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  })),
                }),
          },
          finish_reason: turn.calls.length === 0 ? 'stop' : 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1_500, completion_tokens: 120, total_tokens: 1_620 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * A `fetch` that serves `script` for the provider host and refuses every other host, so an
 * offline run cannot reach the network by accident.
 */
export function scriptedProvider(
  script: ModelScript,
  trace?: (line: string) => void,
): {
  fetch: typeof globalThis.fetch;
  log: ProviderLog;
} {
  const queues = { planner: [...script.planner], codeViewer: [...script.codeViewer] };
  const counters = { planner: 0, codeViewer: 0 };
  const log: ProviderLog = {
    bodies: [],
    hosts: [],
    problems: [],
    remainingTurns: () =>
      queues.planner.length + Math.max(0, queues.codeViewer.length - (script.endless ? 1 : 0)),
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    log.hosts.push(url.host);
    if (!PROVIDER_HOSTS.has(url.host))
      return Promise.reject(new TypeError(`offline acceptance run: no network to ${url.host}`));
    const body = typeof init?.body === 'string' ? init.body : '';
    log.bodies.push(body);
    const agent = toolNamesOf(JSON.parse(body === '' ? '{}' : body)).includes(
      'handoff_to_code_viewer',
    )
      ? 'planner'
      : 'codeViewer';
    const repeating =
      agent === 'codeViewer' && script.endless === true && queues.codeViewer.length === 1;
    const turn = repeating ? queues.codeViewer[0] : queues[agent].shift();
    counters[agent] += 1;
    trace?.(
      `provider ${agent} turn ${counters[agent]}: ${turn === undefined ? 'beyond the script' : turn.calls.map((call) => call.name).join(', ') || 'text'}`,
    );
    if (turn === undefined) {
      log.problems.push(`the ${agent} asked for turn ${counters[agent]}, beyond the script`);
      return Promise.resolve(completion({ calls: [], text: 'Script exhausted.' }, 'exhausted'));
    }
    return Promise.resolve(completion(turn, `${agent}_${counters[agent]}`));
  };
  return { fetch, log };
}

/** Wraps the real `fetch` so that a real-model run is recorded the same way. */
export function recordingProvider(inner: typeof globalThis.fetch): {
  fetch: typeof globalThis.fetch;
  log: ProviderLog;
} {
  const log: ProviderLog = { bodies: [], hosts: [], problems: [], remainingTurns: () => 0 };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    log.hosts.push(url.host);
    if (typeof init?.body === 'string') log.bodies.push(init.body);
    return inner(input, init);
  };
  return { fetch, log };
}
