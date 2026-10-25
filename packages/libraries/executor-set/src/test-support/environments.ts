import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecutionScope,
  ExecutorEnvironment,
  ExecutorKind,
  SubprocessRunner,
} from '@multiagentos/contracts';

/** Test helpers of ExecutorSet; never imported by production code. */

export const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

export const MODEL_SCOPE: Extract<ExecutionScope, { kind: 'MODEL' }> = {
  kind: 'MODEL',
  provider: 'deepseek',
  apiModelId: 'deepseek-flash',
  apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
  baseUrl: 'https://api.deepseek.test',
  thinking: 'DISABLED',
};

/** A runner that reports `rg` as missing, so the scan backend answers. */
export const NO_SUBPROCESS: SubprocessRunner = {
  run: () => Promise.resolve({ exitCode: null, signal: null, stdout: '', truncated: false }),
};

export function environmentFor(
  kind: ExecutorKind,
  scope: ExecutionScope,
  overrides: Partial<ExecutorEnvironment> = {},
): ExecutorEnvironment {
  return {
    scope,
    limits:
      kind === 'MODEL'
        ? {
            deadline: '2099-01-01T00:00:00.000Z',
            maxOutputBytes: 1_048_576,
            maxOutputTokens: 8_192,
          }
        : kind === 'REPOSITORY_ORIENT'
          ? { deadline: '2099-01-01T00:00:00.000Z', maxOutputBytes: 1_048_576, maxFiles: 20_000 }
          : { deadline: '2099-01-01T00:00:00.000Z', maxOutputBytes: 1_048_576 },
    signal: new AbortController().signal,
    subprocess: NO_SUBPROCESS,
    credentials: {
      apiKeyFor: (provider) => (provider === 'deepseek' ? 'sk-test-secret' : undefined),
    },
    now: () => FIXED_NOW,
    ...overrides,
  };
}

/** A fresh empty directory, resolved with realpath (macOS /tmp is a link to /private/tmp). */
export async function emptyDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `${prefix}-`)));
}

export function repositoryScope(root: string, exclusions: string[] = []): ExecutionScope {
  return { kind: 'REPOSITORY', repositoryRoot: root, exclusions };
}

/** An OpenAI chat-completions response with the given tool calls. */
export function chatCompletion(
  calls: readonly { id: string; name: string; arguments: string }[],
  options: { text?: string; finishReason?: string; cacheHit?: number } = {},
): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1_767_225_600,
      model: 'deepseek-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: options.text ?? null,
            ...(calls.length === 0
              ? {}
              : {
                  tool_calls: calls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }),
          },
          finish_reason: options.finishReason ?? (calls.length === 0 ? 'stop' : 'tool_calls'),
        },
      ],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        ...(options.cacheHit === undefined ? {} : { prompt_cache_hit_tokens: options.cacheHit }),
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
