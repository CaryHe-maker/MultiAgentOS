import type {
  AgentAction,
  ChatMessage,
  FileReadInput,
  ModelExecutorPort,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelUsage,
  Result,
  SourceCitation,
} from '../contracts.js';

export const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-flash';

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ModelExecutorOptions {
  readonly apiKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly debugModelResponses?: boolean;
  readonly modelResponseLogger?: (message: string) => void;
}

interface DeepSeekResponse {
  readonly content: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage: ModelUsage;
}

/** Map internal messages to the Chat Completions wire format. */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

function hasTextMessage(messages: readonly ChatMessage[], role: 'system' | 'user'): boolean {
  return messages.some((message) => message.role === role && message.content.trim().length > 0);
}

function failure(code: string, message: string, retryable: boolean): Result<never> {
  return { ok: false, error: { code, message, retryable } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function isCitation(value: unknown): value is SourceCitation {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.startLine === 'number' &&
    typeof value.endLine === 'number'
  );
}

function numberField(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === 'number' ? value : 0;
}

/** Map one native tool call to an AgentAction; undefined means unknown tool or bad arguments. */
function toAction(call: ModelToolCall): AgentAction | undefined {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return undefined;
  }
  if (!isRecord(args)) return undefined;

  switch (call.name) {
    case 'file_read': {
      if (typeof args.path !== 'string') return undefined;
      if (!isOptionalNumber(args.startLine) || !isOptionalNumber(args.endLine)) return undefined;
      const input: FileReadInput = {
        path: args.path,
        ...(typeof args.startLine === 'number' ? { startLine: args.startLine } : {}),
        ...(typeof args.endLine === 'number' ? { endLine: args.endLine } : {}),
      };
      return { kind: 'TOOL_CALL', callId: call.id, toolName: 'file_read', input };
    }
    case 'submit_review': {
      if (typeof args.answer !== 'string') return undefined;
      if (!Array.isArray(args.citations) || !args.citations.every(isCitation)) return undefined;
      return { kind: 'FINAL', answer: args.answer, citations: args.citations };
    }
    case 'handoff': {
      if (
        typeof args.targetAgentId !== 'string' ||
        typeof args.objective !== 'string' ||
        !isStringArray(args.constraints) ||
        !isStringArray(args.acceptanceCriteria)
      ) {
        return undefined;
      }
      return {
        kind: 'HANDOFF',
        targetAgentId: args.targetAgentId,
        task: {
          taskType: 'CODE_REVIEW',
          objective: args.objective,
          constraints: args.constraints,
          acceptanceCriteria: args.acceptanceCriteria,
        },
      };
    }
    default:
      return undefined;
  }
}

/** Tool calls become one action each; a plain-text reply without tool calls is FINAL. */
function toActions(response: DeepSeekResponse): AgentAction[] | undefined {
  if (response.toolCalls.length === 0) {
    const text = response.content?.trim() ?? '';
    return text.length === 0 ? undefined : [{ kind: 'FINAL', answer: text }];
  }
  const actions: AgentAction[] = [];
  for (const call of response.toolCalls) {
    const action = toAction(call);
    if (action === undefined) return undefined;
    actions.push(action);
  }
  return actions;
}

function readApiError(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  return typeof payload.error.message === 'string' ? payload.error.message : undefined;
}

function parseToolCalls(value: unknown): ModelToolCall[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  const calls: ModelToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.function))
      return undefined;
    const { name, arguments: args } = item.function;
    if (typeof name !== 'string' || typeof args !== 'string') return undefined;
    calls.push({ id: item.id, name, arguments: args });
  }
  return calls;
}

function parseResponse(payload: unknown): DeepSeekResponse | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;

  const firstChoice: unknown = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return undefined;
  const content = firstChoice.message.content ?? null;
  if (content !== null && typeof content !== 'string') return undefined;
  const toolCalls = parseToolCalls(firstChoice.message.tool_calls);
  if (toolCalls === undefined) return undefined;

  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  return {
    content,
    toolCalls,
    usage: {
      inputTokens: numberField(usage, 'prompt_tokens'),
      outputTokens: numberField(usage, 'completion_tokens'),
      cacheHitTokens: numberField(usage, 'prompt_cache_hit_tokens'),
      cacheMissTokens: numberField(usage, 'prompt_cache_miss_tokens'),
    },
  };
}

export class ModelExecutor implements ModelExecutorPort {
  private readonly apiKey: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly debugModelResponses: boolean;
  private readonly modelResponseLogger: (message: string) => void;

  public constructor(options: ModelExecutorOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.debugModelResponses =
      options.debugModelResponses ?? process.env.MINIMAL_AGENT_LOOP_DEBUG_MODEL === '1';
    this.modelResponseLogger =
      options.modelResponseLogger ?? ((message) => process.stderr.write(`${message}\n`));
  }

  public async execute(request: ModelRequest): Promise<Result<ModelResponse>> {
    const { messages } = request.context;
    if (!hasTextMessage(messages, 'system') || !hasTextMessage(messages, 'user')) {
      return failure('INVALID_PROMPT', 'Prompt must not be empty.', false);
    }
    if (this.apiKey.length === 0) {
      return failure(
        'MISSING_DEEPSEEK_API_KEY',
        'DEEPSEEK_API_KEY is required to call DeepSeek.',
        false,
      );
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      return failure('INVALID_TIMEOUT', 'Model timeout must be a positive number.', false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetcher(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: messages.map(toWireMessage),
          ...(request.context.tools.length === 0
            ? {}
            : {
                tools: request.context.tools.map((tool) => ({ type: 'function', function: tool })),
                tool_choice: 'auto',
              }),
          thinking: { type: 'disabled' },
          stream: false,
        }),
        signal: controller.signal,
      });

      let rawBody: string;
      try {
        rawBody = await response.text();
      } catch {
        return failure(
          'INVALID_MODEL_RESPONSE',
          `DeepSeek response body could not be read (HTTP ${response.status}).`,
          response.status >= 500,
        );
      }

      this.logRawResponse(request, response.status, rawBody);

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return failure(
          'INVALID_MODEL_RESPONSE',
          `DeepSeek returned a non-JSON response (HTTP ${response.status}).`,
          response.status >= 500,
        );
      }

      if (!response.ok) {
        const detail = readApiError(payload);
        const message = detail
          ? `DeepSeek API request failed (HTTP ${response.status}): ${detail}`
          : `DeepSeek API request failed (HTTP ${response.status}).`;
        return failure(
          'DEEPSEEK_API_ERROR',
          message,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }

      const parsed = parseResponse(payload);
      if (parsed === undefined) {
        return failure('INVALID_MODEL_RESPONSE', 'DeepSeek returned an invalid payload.', false);
      }

      this.logAssistantMessage(request, parsed);

      const actions = toActions(parsed);
      if (actions === undefined) {
        return failure(
          'INVALID_MODEL_ACTION',
          'DeepSeek response was not a valid Planner or Review Agent action.',
          false,
        );
      }

      return {
        ok: true,
        value: {
          actions,
          turn: { content: parsed.content, toolCalls: parsed.toolCalls },
          usage: parsed.usage,
        },
      };
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return failure(
          'MODEL_TIMEOUT',
          `DeepSeek request timed out after ${this.timeoutMs}ms.`,
          true,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return failure('MODEL_NETWORK_ERROR', `DeepSeek request failed: ${detail}`, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  private logRawResponse(request: ModelRequest, status: number, rawBody: string): void {
    if (!this.debugModelResponses) return;
    this.modelResponseLogger(
      [
        '[minimal-agent-loop] DeepSeek raw response',
        `agent=${request.context.agentRef.id}@${request.context.agentRef.version}`,
        `httpStatus=${status}`,
        rawBody,
      ].join('\n'),
    );
  }

  private logAssistantMessage(request: ModelRequest, response: DeepSeekResponse): void {
    if (!this.debugModelResponses) return;
    this.modelResponseLogger(
      [
        '[minimal-agent-loop] DeepSeek assistant message',
        `agent=${request.context.agentRef.id}@${request.context.agentRef.version}`,
        `content=${response.content ?? ''}`,
        ...response.toolCalls.map((call) => `tool_call ${call.name} ${call.arguments}`),
      ].join('\n'),
    );
  }
}
