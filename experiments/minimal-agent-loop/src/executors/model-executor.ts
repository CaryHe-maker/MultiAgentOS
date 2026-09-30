import type {
  AgentAction,
  DefinitionRef,
  FileReadInput,
  ModelExecutorPort,
  ModelRequest,
  ModelResponse,
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
  readonly choices: readonly {
    readonly message: {
      readonly content: string | null;
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

function failure(code: string, message: string, retryable: boolean): Result<never> {
  return { ok: false, error: { code, message, retryable } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDefinitionRef(value: unknown): value is DefinitionRef {
  return isRecord(value) && typeof value.id === 'string' && typeof value.version === 'string';
}

function isFileReadInput(value: unknown): value is FileReadInput {
  if (!isRecord(value) || typeof value.path !== 'string') return false;
  return (
    (value.startLine === undefined || typeof value.startLine === 'number') &&
    (value.endLine === undefined || typeof value.endLine === 'number')
  );
}

function isCitation(value: unknown): value is SourceCitation {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.startLine === 'number' &&
    typeof value.endLine === 'number'
  );
}

function parseAction(content: string): AgentAction | undefined {
  const trimmed = content.trim();
  const json = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
    : trimmed;

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined;

  if (value.kind === 'FINAL' && typeof value.answer === 'string') {
    if (value.citations !== undefined) {
      if (!Array.isArray(value.citations) || !value.citations.every(isCitation)) return undefined;
      return { kind: 'FINAL', answer: value.answer, citations: value.citations };
    }
    return { kind: 'FINAL', answer: value.answer };
  }

  if (
    value.kind === 'TOOL_CALL' &&
    typeof value.callId === 'string' &&
    value.toolName === 'file_read' &&
    isFileReadInput(value.input)
  ) {
    return {
      kind: 'TOOL_CALL',
      callId: value.callId,
      toolName: 'file_read',
      input: value.input,
    };
  }

  if (
    value.kind === 'HANDOFF' &&
    isDefinitionRef(value.targetAgentRef) &&
    isRecord(value.task) &&
    value.task.taskType === 'CODE_REVIEW' &&
    typeof value.task.objective === 'string' &&
    Array.isArray(value.task.constraints) &&
    value.task.constraints.every((item) => typeof item === 'string') &&
    Array.isArray(value.task.acceptanceCriteria) &&
    value.task.acceptanceCriteria.every((item) => typeof item === 'string')
  ) {
    return {
      kind: 'HANDOFF',
      targetAgentRef: value.targetAgentRef,
      task: {
        taskType: 'CODE_REVIEW',
        objective: value.task.objective,
        constraints: value.task.constraints,
        acceptanceCriteria: value.task.acceptanceCriteria,
      },
    };
  }

  return undefined;
}

function readApiError(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  return typeof payload.error.message === 'string' ? payload.error.message : undefined;
}

function parseResponse(payload: unknown): DeepSeekResponse | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;

  const firstChoice: unknown = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return undefined;
  const content = firstChoice.message.content;
  if (content !== null && typeof content !== 'string') return undefined;

  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  const promptTokens = usage?.prompt_tokens;
  const completionTokens = usage?.completion_tokens;

  return {
    choices: [{ message: { content } }],
    ...(typeof promptTokens === 'number' && typeof completionTokens === 'number'
      ? { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }
      : {}),
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
    if (
      request.context.instructions.trim().length === 0 ||
      request.context.input.trim().length === 0
    ) {
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
          messages: [
            { role: 'system', content: request.context.instructions },
            { role: 'user', content: request.context.input },
          ],
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

      const content = parsed.choices[0]?.message.content;
      if (typeof content !== 'string' || content.length === 0) {
        return failure(
          'INVALID_MODEL_RESPONSE',
          'DeepSeek response did not contain an action.',
          false,
        );
      }

      this.logAssistantContent(request, content);

      const action = parseAction(content);
      if (action === undefined) {
        return failure(
          'INVALID_MODEL_ACTION',
          'DeepSeek response was not a valid Planner or Review Agent action.',
          false,
        );
      }

      return {
        ok: true,
        value: {
          action,
          usage: {
            inputTokens: parsed.usage?.prompt_tokens ?? 0,
            outputTokens: parsed.usage?.completion_tokens ?? 0,
          },
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

  private logAssistantContent(request: ModelRequest, content: string): void {
    if (!this.debugModelResponses) return;
    this.modelResponseLogger(
      [
        '[minimal-agent-loop] DeepSeek assistant content',
        `agent=${request.context.agentRef.id}@${request.context.agentRef.version}`,
        content,
      ].join('\n'),
    );
  }
}
