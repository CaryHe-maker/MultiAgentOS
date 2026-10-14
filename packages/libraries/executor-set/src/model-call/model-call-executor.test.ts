import {
  ModelRawOutputSchema,
  validate,
  type AssembleContextPack,
  type ExecutorEnvironment,
  type ExecutorOutcome,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { createAssembleExecutor } from '../context-assemble/assemble-executor.js';
import { MODEL_SCOPE, chatCompletion, environmentFor } from '../test-support/environments.js';
import { createModelCallExecutor } from './model-call-executor.js';

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    purpose: 'UNIT' as const,
  },
  {
    name: 'finish_analysis',
    description: 'Finish.',
    parameters: { type: 'object', properties: { summary: { type: 'string' } } },
    purpose: 'CONTROL' as const,
  },
];

async function packOf(final: boolean): Promise<AssembleContextPack> {
  const outcome = await createAssembleExecutor().execute(
    {
      objective: 'What does add do?',
      final,
      tokenBudget: 64_000,
      instructions: 'Analyse the repository.',
      toolSpecs: final ? [TOOLS[1] as (typeof TOOLS)[number]] : TOOLS,
      history: [
        {
          step: {
            kind: 'MODEL_TURN',
            round: 1,
            requestId: 'req_turn000001',
            toolCalls: [
              { toolCallId: 'call_0', toolName: 'read_file', arguments: { path: 'a.ts' } },
            ],
          },
        },
        {
          step: {
            kind: 'FEEDBACK',
            round: 1,
            code: 'NOT_EXECUTED',
            message: 'Not executed.',
            toolCallId: 'call_0',
          },
        },
      ],
      status: { roundsUsed: 1, maxRounds: 5, final, budgetState: 'NORMAL' },
    },
    environmentFor('CONTEXT_ASSEMBLE', { kind: 'NONE' }),
  );
  if (outcome.outcome !== 'COMPLETED') throw new Error('assemble');
  return JSON.parse(outcome.result.artifact.text) as AssembleContextPack;
}

const pack = await packOf(false);
const finalPack = await packOf(true);

interface Recorded {
  calls: number;
  body?: Record<string, unknown>;
  authorization?: string | null;
}

function fakeFetch(respond: () => Response | Promise<Response>, recorded: Recorded): typeof fetch {
  return async (_input, init) => {
    recorded.calls += 1;
    recorded.body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    recorded.authorization = new Headers(init?.headers).get('authorization');
    return respond();
  };
}

async function call(
  respond: () => Response | Promise<Response>,
  options: { final?: boolean; environment?: Partial<ExecutorEnvironment> } = {},
): Promise<{ outcome: ExecutorOutcome; recorded: Recorded }> {
  const recorded: Recorded = { calls: 0 };
  const executor = createModelCallExecutor({ fetch: fakeFetch(respond, recorded) });
  const outcome = await executor.execute(
    { contextPack: options.final === true ? finalPack : pack, final: options.final === true },
    environmentFor('MODEL', MODEL_SCOPE, options.environment),
  );
  return { outcome, recorded };
}

const status = (code: number) => () =>
  new Response(JSON.stringify({ error: { message: 'x' } }), { status: code });
const networkError = (code: string) => () =>
  Promise.reject(
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(code), { code }),
    }),
  );

describe('MODEL (ExecutorSet 4.5)', () => {
  it('maps a tool-calling answer to the output and the raw artifact', async () => {
    const { outcome, recorded } = await call(() =>
      chatCompletion(
        [
          { id: 'call_1', name: 'read_file', arguments: '{"path":"src/a.ts"}' },
          { id: 'call_2', name: 'read_file', arguments: '{"path":' },
        ],
        { text: 'Reading.', cacheHit: 1000 },
      ),
    );
    expect(outcome).toMatchObject({
      outcome: 'COMPLETED',
      requestState: 'SENT',
      usage: { inputTokens: 1200, outputTokens: 80, inputCacheHitTokens: 1000 },
      result: {
        output: {
          finishReason: 'TOOL_CALLS',
          hasText: true,
          toolCalls: [
            { toolCallId: 'call_1', toolName: 'read_file', arguments: { path: 'src/a.ts' } },
            {
              toolCallId: 'call_2',
              toolName: 'read_file',
              arguments: null,
              argumentsError: 'INVALID_JSON',
            },
          ],
        },
      },
    });
    if (outcome.outcome !== 'COMPLETED') return;
    const raw: unknown = JSON.parse(outcome.result.artifact.text);
    expect(validate(ModelRawOutputSchema, raw)).toMatchObject({ ok: true });
    expect(raw).toMatchObject({ text: 'Reading.', toolCalls: [{}, { argumentsText: '{"path":' }] });
    expect(recorded.calls).toBe(1);
  });

  it('sends the pack as messages, tools, max_tokens and the thinking switch', async () => {
    const { recorded } = await call(() => chatCompletion([]));
    const body = recorded.body ?? {};
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      max_tokens: 8192,
      tool_choice: 'auto',
      thinking: { type: 'disabled' },
    });
    const messages = body['messages'] as { role: string; tool_call_id?: string }[];
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(messages[3]?.tool_call_id).toBe('call_0');
    expect((body['tools'] as unknown[]).length).toBe(2);
    expect(recorded.authorization).toBe('Bearer sk-test-secret');
  });

  it('forces the control tool on the final call', async () => {
    const { recorded } = await call(() => chatCompletion([]), { final: true });
    expect(recorded.body?.['tool_choice']).toEqual({
      type: 'function',
      function: { name: 'finish_analysis' },
    });
  });

  it('maps a text-only answer to STOP without tool calls', async () => {
    const { outcome } = await call(() => chatCompletion([], { text: 'Done.' }));
    expect(outcome).toMatchObject({
      result: { output: { finishReason: 'STOP', toolCalls: [], hasText: true } },
    });
  });

  it.each([
    ['429', status(429), 'PROVIDER_RATE_LIMITED', 'NOT_SENT', true],
    ['401', status(401), 'PROVIDER_AUTH', 'NOT_SENT', false],
    ['403', status(403), 'PROVIDER_AUTH', 'NOT_SENT', false],
    ['400', status(400), 'INTERNAL', 'NOT_SENT', false],
    ['404', status(404), 'INTERNAL', 'NOT_SENT', false],
    ['408', status(408), 'PROVIDER_ERROR', 'UNKNOWN', false],
    ['500', status(500), 'PROVIDER_ERROR', 'UNKNOWN', false],
    ['503', status(503), 'PROVIDER_ERROR', 'UNKNOWN', false],
    ['refused connection', networkError('ECONNREFUSED'), 'PROVIDER_UNREACHABLE', 'NOT_SENT', true],
    ['unknown host', networkError('ENOTFOUND'), 'PROVIDER_UNREACHABLE', 'NOT_SENT', true],
    ['bad certificate', networkError('CERT_HAS_EXPIRED'), 'PROVIDER_UNREACHABLE', 'NOT_SENT', true],
    ['reset connection', networkError('ECONNRESET'), 'PROVIDER_ERROR', 'UNKNOWN', false],
    [
      'broken body',
      () => new Response('{"choices": [', { status: 200 }),
      'PROVIDER_ERROR',
      'UNKNOWN',
      false,
    ],
  ] as const)('%s → %s, %s', async (_name, respond, reasonCode, requestState, retryable) => {
    const { outcome, recorded } = await call(respond);
    expect(outcome).toEqual({ outcome: 'FAILED', reasonCode, retryable, requestState });
    expect(recorded.calls).toBe(1); // the SDK never retries
  });

  it('reports a missing API key as PROVIDER_AUTH without sending', async () => {
    const { outcome, recorded } = await call(() => chatCompletion([]), {
      environment: { credentials: { apiKeyFor: () => undefined } },
    });
    expect(outcome).toEqual({
      outcome: 'FAILED',
      reasonCode: 'PROVIDER_AUTH',
      retryable: false,
      requestState: 'NOT_SENT',
    });
    expect(recorded.calls).toBe(0);
  });

  it('stops on abort and says whether the request may have been processed', async () => {
    const before = await call(() => chatCompletion([]), {
      environment: { signal: AbortSignal.abort() },
    });
    expect(before.outcome).toMatchObject({ outcome: 'FAILED', requestState: 'NOT_SENT' });
    expect(before.recorded.calls).toBe(0);

    const controller = new AbortController();
    const during = await call(
      () => {
        controller.abort();
        return new Promise<Response>((_resolve, reject) =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      },
      { environment: { signal: controller.signal } },
    );
    expect(during.outcome).toMatchObject({ outcome: 'FAILED', requestState: 'UNKNOWN' });
  });

  it('never puts the API key into an outcome', async () => {
    for (const respond of [
      () => chatCompletion([{ id: 'c', name: 'read_file', arguments: '{}' }]),
      status(401),
      status(500),
    ]) {
      const { outcome } = await call(respond);
      expect(JSON.stringify(outcome)).not.toContain('sk-test-secret');
    }
  });

  it('reports a scope that is not MODEL as SCOPE_MISSING', async () => {
    const { outcome } = await call(() => chatCompletion([]), {
      environment: { scope: { kind: 'NONE' } },
    });
    expect(outcome).toEqual({ outcome: 'VIOLATION', reasonCode: 'SCOPE_MISSING' });
  });
});
