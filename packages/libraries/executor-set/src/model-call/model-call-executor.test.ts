import {
  ModelRawOutputSchema,
  validate,
  type AssembleContextPack,
  type ExecutorEnvironment,
  type ExecutorOutcome,
} from '@multiagentos/contracts';
import { asksForStream, streamedIfAsked } from '@multiagentos/testing';
import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import { createAssembleExecutor } from '../context-assemble/assemble-executor.js';
import { MODEL_SCOPE, chatCompletion, environmentFor } from '../test-support/environments.js';
import { classifyCall, createModelCallExecutor } from './model-call-executor.js';

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
      final,
      tokenBudget: 64_000,
      instructions: 'Analyse the repository.',
      toolSpecs: final ? [TOOLS[1] as (typeof TOOLS)[number]] : TOOLS,
      history: [
        { seq: 1, category: 'PINNED', kind: 'HUMAN', text: 'What does add do?' },
        {
          seq: 2,
          category: 'NORMAL',
          kind: 'MODEL_TURN',
          toolCalls: [{ toolCallId: 'call_0', toolName: 'read_file', arguments: { path: 'a.ts' } }],
        },
        {
          seq: 3,
          category: 'NORMAL',
          kind: 'FEEDBACK',
          text: 'Not executed.',
          toolCallId: 'call_0',
        },
      ],
      status: {
        round: 2,
        maxRounds: 5,
        final,
        budget: { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' },
      },
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
  options: {
    final?: boolean;
    finalMode?: 'AUTO' | 'FORCED';
    compaction?: { requiredSections: string[] };
    environment?: Partial<ExecutorEnvironment>;
  } = {},
): Promise<{ outcome: ExecutorOutcome; recorded: Recorded }> {
  const recorded: Recorded = { calls: 0 };
  const executor = createModelCallExecutor({ fetch: fakeFetch(respond, recorded) });
  const outcome = await executor.execute(
    {
      contextPack: options.final === true ? finalPack : pack,
      final: options.final === true,
      ...(options.finalMode === undefined ? {} : { finalMode: options.finalMode }),
      ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
    },
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

describe('MODEL (ExecutorSet 7)', () => {
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

  it('offers the end tool freely on a final call, and forces it on the retry', async () => {
    const free = await call(() => chatCompletion([]), { final: true });
    expect(free.recorded.body?.['tool_choice']).toBe('auto');
    const forced = await call(() => chatCompletion([]), { final: true, finalMode: 'FORCED' });
    expect(forced.recorded.body?.['tool_choice']).toEqual({
      type: 'function',
      function: { name: 'finish_analysis' },
    });
    expect(forced.recorded.body?.['thinking']).toEqual({ type: 'disabled' });
  });

  it('completes a final call that answers with exactly one end tool', async () => {
    const { outcome } = await call(
      () => chatCompletion([{ id: 'c', name: 'finish_analysis', arguments: '{"summary":"s"}' }]),
      { final: true },
    );
    expect(outcome).toMatchObject({
      outcome: 'COMPLETED',
      result: { output: { toolCalls: [{ toolName: 'finish_analysis' }] } },
    });
  });

  // DeepSeek has answered final calls with read_file, which the request did not even offer.
  it.each([
    ['another tool', [{ id: 'c', name: 'read_file', arguments: '{"path":"a"}' }]],
    ['no tool call', []],
    ['arguments that are not JSON', [{ id: 'c', name: 'finish_analysis', arguments: '{"summ' }]],
    [
      'a second call',
      [
        { id: 'c', name: 'finish_analysis', arguments: '{"summary":"s"}' },
        { id: 'd', name: 'finish_analysis', arguments: '{"summary":"s"}' },
      ],
    ],
  ])(
    'turns a final call answered with %s into a retryable failure with its usage',
    async (_, calls) => {
      const { outcome } = await call(() => chatCompletion(calls), { final: true });
      expect(outcome).toEqual({
        outcome: 'FAILED',
        reasonCode: 'PROVIDER_TOOL_CHOICE_IGNORED',
        retryable: true,
        requestState: 'SENT',
        usage: { inputTokens: 1200, outputTokens: 80 },
      });
    },
  );

  it('leaves an ordinary call with any tool to Workflow', async () => {
    const { outcome } = await call(() =>
      chatCompletion([{ id: 'c', name: 'finish_analysis', arguments: '{"summ' }]),
    );
    expect(outcome).toMatchObject({ outcome: 'COMPLETED' });
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

describe('a size the provider refuses', () => {
  it('is a context limit, in the words DeepSeek really uses', () => {
    const error = new APICallError({
      message:
        "This model's maximum context length is 1048576 tokens. However, you requested 1419096 tokens.",
      url: 'https://api.deepseek.com/chat/completions',
      requestBodyValues: {},
      statusCode: 400,
    });
    const progress = { started: true, failedBeforeSending: false, responded: true };
    expect(classifyCall(error, progress, new AbortController().signal)).toEqual({
      outcome: 'REJECTED',
      reasonCode: 'CONTEXT_OVERFLOW',
    });
  });
});

describe('a summary request (ExecutorSet 7)', () => {
  const sections = { requiredSections: ['Goal', 'Open items'] };
  const summary = '1. Goal and requirements\nfix it\n6. Open items\nnone';

  it('is a completed call whose text is the summary', async () => {
    const { outcome } = await call(() => chatCompletion([], { text: summary }), {
      compaction: sections,
    });
    expect(outcome).toMatchObject({ outcome: 'COMPLETED', requestState: 'SENT' });
  });

  it('is not a summary when a section is missing, and Kernel may ask again', async () => {
    const { outcome } = await call(() => chatCompletion([], { text: 'Goal: fix it' }), {
      compaction: sections,
    });
    expect(outcome).toMatchObject({
      outcome: 'FAILED',
      reasonCode: 'COMPACTION_SUMMARY_INVALID',
      retryable: true,
      requestState: 'SENT',
      usage: { inputTokens: 1200 },
    });
  });

  it('is not a summary when the model calls a tool, and the call is not carried out', async () => {
    const { outcome } = await call(
      () =>
        chatCompletion([{ id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }], {
          text: summary,
        }),
      { compaction: sections },
    );
    expect(outcome).toMatchObject({ outcome: 'FAILED', reasonCode: 'COMPACTION_SUMMARY_INVALID' });
  });

  it('leaves an ordinary call alone', async () => {
    const { outcome } = await call(() => chatCompletion([], { text: 'just text' }));
    expect(outcome.outcome).toBe('COMPLETED');
  });
});

describe('MODEL streamed for a watcher (docs/M2/Phase1Console.md 4)', () => {
  /** An answer with thinking and a cache hit, as DeepSeek sends it in one piece. */
  const withThinking = () =>
    new Response(
      JSON.stringify({
        id: 'chatcmpl-think',
        object: 'chat.completion',
        created: 1_767_225_600,
        model: 'deepseek-flash',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Reading.',
              reasoning_content: 'First I need to look at a.ts, then decide what to change.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 80,
          total_tokens: 1280,
          prompt_cache_hit_tokens: 1000,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const run = async (
    fetchOf: (init: RequestInit | undefined) => Promise<Response>,
    progress?: ExecutorEnvironment['progress'],
  ) => {
    const executor = createModelCallExecutor({ fetch: (_input, init) => fetchOf(init) });
    return executor.execute(
      { contextPack: pack, final: false },
      environmentFor('MODEL', MODEL_SCOPE, progress === undefined ? {} : { progress }),
    );
  };

  it('gives the same result as the one-piece answer, and tells the watcher the thinking as it comes', async () => {
    const oneShot = await run(() => Promise.resolve(withThinking()));
    const events: { kind: string; delta?: string }[] = [];
    let asked = false;
    const streamed = await run(
      async (init) => {
        asked = asksForStream(init);
        return streamedIfAsked(init, withThinking());
      },
      (event) => void events.push(event),
    );
    expect(asked).toBe(true);
    // Everything the Workflow and the Kernel see is the same.
    expect(streamed).toEqual(oneShot);
    expect(streamed).toMatchObject({
      outcome: 'COMPLETED',
      usage: { inputTokens: 1200, outputTokens: 80, inputCacheHitTokens: 1000 },
      result: {
        reasoning: { text: 'First I need to look at a.ts, then decide what to change.' },
      },
    });
    // The watcher got the thinking in several pieces that make up the whole, then the end.
    const pieces = events.filter((event) => event.kind === 'REASONING');
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((event) => event.delta).join('')).toBe(
      'First I need to look at a.ts, then decide what to change.',
    );
    expect(events.at(-1)).toEqual({ kind: 'END' });
  });

  it('does not stream when nobody watches', async () => {
    let asked = true;
    await run((init) => {
      asked = asksForStream(init);
      return Promise.resolve(withThinking());
    });
    expect(asked).toBe(false);
  });

  it('is not changed by a watcher that throws', async () => {
    const oneShot = await run(() => Promise.resolve(withThinking()));
    const streamed = await run(
      (init) => streamedIfAsked(init, withThinking()),
      () => {
        throw new Error('the watcher broke');
      },
    );
    expect(streamed).toEqual(oneShot);
  });

  it('fails as UNKNOWN, not retryable, when the stream breaks after it began', async () => {
    const events: string[] = [];
    const pieces: Uint8Array[] = [];
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // The adapter reads on until the first piece of an answer, so the stream has begun
            // properly (a piece of text) before the thinking arrives and the connection breaks.
            const chunk = (delta: object) =>
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  id: 'x',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: 'deepseek-flash',
                  choices: [{ index: 0, delta }],
                })}\n\n`,
              );
            // `error` would drop what is queued, so each piece goes out on its own turn first.
            pieces.push(chunk({ content: 'Hi' }), chunk({ reasoning_content: 'half a thought' }));
          },
          pull(controller) {
            const next = pieces.shift();
            if (next === undefined) controller.error(new TypeError('terminated'));
            else controller.enqueue(next);
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const outcome = await run(
      () => Promise.resolve(broken()),
      (event) => void events.push(event.kind),
    );
    expect(outcome).toMatchObject({
      outcome: 'FAILED',
      reasonCode: 'PROVIDER_ERROR',
      retryable: false,
      requestState: 'UNKNOWN',
    });
    expect(events.at(-1)).toBe('END');
  });
});

describe('MODEL thinking reaches the watcher before the answer does', () => {
  it('tells the thinking while the stream is still open, not when the call is over', async () => {
    const event = (delta: object, finish: string | null = null) =>
      new TextEncoder().encode(
        `data: ${JSON.stringify({
          id: 'x',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-flash',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let step = 0;
    const slow = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            step += 1;
            if (step === 1) controller.enqueue(event({ reasoning_content: 'thinking hard ' }));
            else if (step === 2) controller.enqueue(event({ reasoning_content: 'still thinking' }));
            else if (step === 3) {
              // The answer proper comes only now, and only when the test lets it.
              await gate;
              controller.enqueue(event({ content: 'done' }));
              controller.enqueue(event({}, 'stop'));
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            } else controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const events: string[] = [];
    let finished = false;
    const executor = createModelCallExecutor({ fetch: () => Promise.resolve(slow()) });
    const outcome = executor
      .execute(
        { contextPack: pack, final: false },
        environmentFor('MODEL', MODEL_SCOPE, {
          progress: (each) => void events.push(each.kind === 'REASONING' ? each.delta : each.kind),
        }),
      )
      .finally(() => {
        finished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The call is still waiting for the answer, and the watcher already has both pieces.
    expect(finished).toBe(false);
    expect(events).toEqual(['thinking hard ', 'still thinking']);
    release();
    expect(await outcome).toMatchObject({
      outcome: 'COMPLETED',
      result: { reasoning: { text: 'thinking hard still thinking' } },
    });
    expect(events.at(-1)).toBe('END');
  });
});

describe('MODEL shows the text of a reply as the model writes it', () => {
  const REPLY = {
    name: 'reply',
    description: 'Reply to the user.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    purpose: 'CONTROL' as const,
    liveText: 'text',
  };

  async function replyPack(): Promise<AssembleContextPack> {
    const outcome = await createAssembleExecutor().execute(
      {
        final: false,
        tokenBudget: 64_000,
        instructions: 'Chat.',
        toolSpecs: [REPLY],
        history: [{ seq: 1, category: 'PINNED', kind: 'HUMAN', text: 'hi' }],
        status: {
          round: 1,
          maxRounds: 5,
          final: false,
          budget: { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' },
        },
      },
      environmentFor('CONTEXT_ASSEMBLE', { kind: 'NONE' }),
    );
    if (outcome.outcome !== 'COMPLETED') throw new Error('assemble');
    return JSON.parse(outcome.result.artifact.text) as AssembleContextPack;
  }

  const answer = () =>
    chatCompletion(
      [
        {
          id: 'call_r',
          name: 'reply',
          arguments: JSON.stringify({ text: 'Hello,\n"friend" 你好 😀!' }),
        },
      ],
      {},
    );

  it('tells the text while it is written, and the result is the same as without watching', async () => {
    const contextPack = await replyPack();
    const make = (progress?: ExecutorEnvironment['progress']) =>
      createModelCallExecutor({
        fetch: (_input, init) => streamedIfAsked(init, answer()),
      }).execute(
        { contextPack, final: false },
        environmentFor('MODEL', MODEL_SCOPE, progress === undefined ? {} : { progress }),
      );
    const plain = await createModelCallExecutor({ fetch: () => Promise.resolve(answer()) }).execute(
      { contextPack, final: false },
      environmentFor('MODEL', MODEL_SCOPE),
    );
    const events: { kind: string; delta?: string }[] = [];
    const watched = await make((event) => void events.push(event));
    expect(watched).toEqual(plain);
    const written = events.filter((event) => event.kind === 'TEXT');
    expect(written.length).toBeGreaterThan(1);
    expect(written.map((event) => event.delta).join('')).toBe('Hello,\n"friend" 你好 😀!');
    expect(events.at(-1)).toEqual({ kind: 'END' });
  });

  it('shows nothing of a tool that is not marked as text for the user', async () => {
    const contextPack = await replyPack();
    const events: string[] = [];
    await createModelCallExecutor({
      fetch: (_input, init) =>
        streamedIfAsked(
          init,
          chatCompletion([{ id: 'c', name: 'other', arguments: '{"text":"secret plan"}' }], {}),
        ),
    }).execute(
      { contextPack, final: false },
      environmentFor('MODEL', MODEL_SCOPE, { progress: (event) => void events.push(event.kind) }),
    );
    expect(events).not.toContain('TEXT');
  });
});
