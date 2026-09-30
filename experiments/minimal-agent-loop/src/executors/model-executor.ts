import type { ModelExecutorPort, ModelRequest, ModelResponse, Result } from '../contracts.js';

export const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-flash';

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ModelExecutorOptions {
  readonly apiKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
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

  public constructor(options: ModelExecutorOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async execute(request: ModelRequest): Promise<Result<ModelResponse>> {
    if (request.prompt.trim().length === 0) {
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
          messages: [{ role: 'user', content: request.prompt }],
          stream: false,
        }),
        signal: controller.signal,
      });

      let payload: unknown;
      try {
        payload = await response.json();
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

      const answer = parsed.choices[0]?.message.content;
      if (typeof answer !== 'string' || answer.length === 0) {
        return failure(
          'INVALID_MODEL_RESPONSE',
          'DeepSeek response did not contain an answer.',
          false,
        );
      }

      return {
        ok: true,
        value: {
          answer,
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
}
