/**
 * What every scripted provider of the tests has in common: the shape of an answer of the
 * provider's chat API (OpenAI chat completions, the protocol of the DeepSeek models), and which
 * Agent a request is for. The Turn-chat driver and the test of the analyze template differ only in
 * how they queue turns and what they record.
 */

/** One tool call the scripted model makes; `arguments` is sent as its JSON text. */
export interface ScriptedCall {
  readonly name: string;
  readonly arguments: unknown;
}

/** An answer: tool calls, or text. */
export interface ScriptedTurn {
  readonly calls: readonly ScriptedCall[];
  readonly text?: string;
  /** What the model thought; sent as `reasoning_content`, the way DeepSeek does. */
  readonly reasoning?: string;
}

/** The usage a scripted answer reports; tests that look at tokens give their own. */
export interface ScriptedUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

const DEFAULT_USAGE: ScriptedUsage = { promptTokens: 100, completionTokens: 10 };

export function completionResponse(
  turn: ScriptedTurn,
  id: string,
  usage: ScriptedUsage = DEFAULT_USAGE,
): Response {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${id}`,
      object: 'chat.completion',
      created: 1_767_225_600,
      model: 'deepseek-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: turn.text ?? null,
            ...(turn.reasoning === undefined ? {} : { reasoning_content: turn.reasoning }),
            ...(turn.calls.length === 0
              ? {}
              : {
                  tool_calls: turn.calls.map((call, index) => ({
                    id: `call_${id}_${String(index)}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  })),
                }),
          },
          finish_reason: turn.calls.length === 0 ? 'stop' : 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.promptTokens + usage.completionTokens,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export type ScriptedAgent = 'main' | 'explorer' | 'worker' | 'planner' | 'code-viewer' | 'unknown';

/** Which Agent a request is for, from the tools it offers (M2Design 3.9). */
export function agentOfTools(names: ReadonlySet<string>): ScriptedAgent {
  if (names.has('run_subagents')) return 'main';
  if (names.has('finish_subagent')) return names.has('write_file') ? 'worker' : 'explorer';
  if (names.has('handoff_to_code_viewer')) return 'planner';
  if (names.has('finish_analysis')) return 'code-viewer';
  return 'unknown';
}
