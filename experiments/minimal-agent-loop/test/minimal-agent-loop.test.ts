import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentToolPool,
  CONTEXT_BUILD_UNIT_REF,
  C_REVIEW_AGENT_REF,
  FILE_READ_UNIT_REF,
  MODEL_CALL_UNIT_REF,
  PLANNER_AGENT_REF,
  REPOSITORY_VIEW_UNIT_REF,
  RETURN_RESULT_UNIT_REF,
} from '../src/agent-tool-pool.js';
import { formatFileRead, MinimalContextEngine } from '../src/context-engine.js';
import type { FileReadExecutorPort, ModelExecutorPort } from '../src/contracts.js';
import { FileReadExecutor } from '../src/executors/file-read-executor.js';
import {
  DEEPSEEK_API_URL,
  DEEPSEEK_MODEL,
  ModelExecutor,
} from '../src/executors/model-executor.js';
import { MinimalKernel } from '../src/kernel.js';
import { createExperimentRuntime, runPrompt } from '../src/runtime.js';
import { MinimalWorkflow } from '../src/workflow.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type ToolCallSpec = readonly [name: string, args: unknown];

function toolCallResponse(calls: readonly ToolCallSpec[]): Response {
  return jsonResponse({
    choices: [
      {
        message: {
          content: null,
          tool_calls: calls.map(([name, args], index) => ({
            id: `call-${index + 1}`,
            type: 'function',
            function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
          })),
        },
      },
    ],
  });
}

function textResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

const HANDOFF_ARGS = {
  targetAgentId: 'c-repository-review-agent',
  objective: '检查可能导致错误结果的问题',
  constraints: ['read-only'],
  acceptanceCriteria: ['findings cite files and line ranges'],
};

interface WireMessage {
  readonly role: string;
  readonly content: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: { readonly id: string }[];
}

function requestMessages(init: RequestInit | undefined): WireMessage[] {
  return (JSON.parse(requestBody(init)) as { messages: WireMessage[] }).messages;
}

const VALID_REVIEW = {
  answer: 'input 未检查 NULL 就被解引用。',
  citations: [{ path: 'src/parser.c', startLine: 2, endLine: 3 }],
};

function runReview(root: string, fetchMock: typeof fetch) {
  return createExperimentRuntime({
    apiKey: 'test-key',
    fetch: fetchMock,
    retryDelayMs: 0,
  }).kernel.run({
    prompt: '审查这个 C 仓库',
    repository: { rootPath: root, revision: 'fixture-v1' },
  });
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a string request body.');
  return init.body;
}

async function makeRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'minimal-agent-loop-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'include'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'include', 'parser.h'), 'int parse(const char *input);\n', 'utf8');
  await writeFile(
    join(root, 'src', 'parser.c'),
    ['#include "parser.h"', 'int parse(const char *input) {', '  return input[0];', '}', ''].join(
      '\n',
    ),
    'utf8',
  );
  return root;
}

const PLANNER_CONTEXT = {
  agentRef: PLANNER_AGENT_REF,
  promptRef: { id: 'prompt', version: '1.0.0' },
  messages: [
    { role: 'system' as const, content: 'system instructions' },
    { role: 'user' as const, content: '{"objective":"hi"}' },
  ],
  tools: [{ name: 'handoff', description: 'hand off', parameters: { type: 'object' } }],
};

describe('ModelExecutor', () => {
  it('sends native tools with thinking disabled and maps a plain-text reply to FINAL', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: '你好！' } }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            prompt_cache_hit_tokens: 8,
            prompt_cache_miss_tokens: 3,
          },
        }),
      ),
    );
    const executor = new ModelExecutor({ apiKey: 'test-key', fetch: fetchMock });

    const result = await executor.execute({ context: PLANNER_CONTEXT });

    expect(result).toEqual({
      ok: true,
      value: {
        actions: [{ kind: 'FINAL', answer: '你好！' }],
        turn: { content: '你好！', toolCalls: [] },
        usage: { inputTokens: 11, outputTokens: 7, cacheHitTokens: 8, cacheMissTokens: 3 },
      },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(DEEPSEEK_API_URL);
    expect(JSON.parse(requestBody(init))).toEqual({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: 'system instructions' },
        { role: 'user', content: '{"objective":"hi"}' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'handoff', description: 'hand off', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'auto',
      thinking: { type: 'disabled' },
      stream: false,
    });
  });

  it('serializes assistant tool calls and tool results in the wire format', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(textResponse('ok')));
    const executor = new ModelExecutor({ apiKey: 'test-key', fetch: fetchMock });
    await executor.execute({
      context: {
        ...PLANNER_CONTEXT,
        messages: [
          ...PLANNER_CONTEXT.messages,
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'call-1', name: 'file_read', arguments: '{"path":"a.c"}' }],
          },
          { role: 'tool', toolCallId: 'call-1', content: 'result' },
        ],
      },
    });
    expect(requestMessages(fetchMock.mock.calls[0]?.[1]).slice(2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'file_read', arguments: '{"path":"a.c"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'result' },
    ]);
  });

  it('maps each native tool call to one action', async () => {
    const executor = new ModelExecutor({
      apiKey: 'test-key',
      fetch: () =>
        Promise.resolve(
          toolCallResponse([
            ['file_read', { path: 'src/a.c', startLine: 1, endLine: 9 }],
            ['file_read', { path: 'src/b.c' }],
          ]),
        ),
    });
    const result = await executor.execute({ context: PLANNER_CONTEXT });
    expect(result).toMatchObject({
      ok: true,
      value: {
        actions: [
          {
            kind: 'TOOL_CALL',
            callId: 'call-1',
            toolName: 'file_read',
            input: { path: 'src/a.c', startLine: 1, endLine: 9 },
          },
          {
            kind: 'TOOL_CALL',
            callId: 'call-2',
            toolName: 'file_read',
            input: { path: 'src/b.c' },
          },
        ],
      },
    });
  });

  it('maps handoff and submit_review tool calls', async () => {
    const responses = [
      toolCallResponse([['handoff', HANDOFF_ARGS]]),
      toolCallResponse([
        ['submit_review', { answer: 'ok', citations: [{ path: 'a.c', startLine: 1, endLine: 2 }] }],
      ]),
    ];
    const executor = new ModelExecutor({
      apiKey: 'test-key',
      fetch: () => Promise.resolve(responses.shift() ?? textResponse('')),
    });
    await expect(executor.execute({ context: PLANNER_CONTEXT })).resolves.toMatchObject({
      ok: true,
      value: {
        actions: [
          {
            kind: 'HANDOFF',
            targetAgentId: 'c-repository-review-agent',
            task: { taskType: 'CODE_REVIEW', objective: HANDOFF_ARGS.objective },
          },
        ],
      },
    });
    await expect(executor.execute({ context: PLANNER_CONTEXT })).resolves.toMatchObject({
      ok: true,
      value: {
        actions: [
          { kind: 'FINAL', answer: 'ok', citations: [{ path: 'a.c', startLine: 1, endLine: 2 }] },
        ],
      },
    });
  });

  it.each<[string, Response]>([
    ['unknown tool', toolCallResponse([['run_shell', { command: 'ls' }]])],
    ['non-JSON arguments', toolCallResponse([['file_read', '{"path":']])],
    ['missing required argument', toolCallResponse([['file_read', { startLine: 1 }]])],
    ['empty reply', textResponse('')],
  ])('rejects a response with %s', async (_label, response) => {
    const messages: string[] = [];
    const executor = new ModelExecutor({
      apiKey: 'test-key',
      fetch: () => Promise.resolve(response),
      debugModelResponses: true,
      modelResponseLogger: (message) => messages.push(message),
    });
    const result = await executor.execute({ context: PLANNER_CONTEXT });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_MODEL_ACTION' } });
    expect(messages.join('\n')).toContain('DeepSeek raw response');
    expect(messages.join('\n')).toContain('planner-agent@1.0.0');
    expect(messages.join('\n')).toContain('DeepSeek assistant message');
  });
});

describe('Agent and Unit definitions', () => {
  it('publishes two Agents that share generic Unit definitions', async () => {
    const pool = new AgentToolPool();
    const planner = await pool.getAgent(PLANNER_AGENT_REF);
    const reviewer = await pool.getAgent(C_REVIEW_AGENT_REF);

    expect(planner).toMatchObject({
      ok: true,
      value: {
        allowedUnitRefs: [CONTEXT_BUILD_UNIT_REF, MODEL_CALL_UNIT_REF, RETURN_RESULT_UNIT_REF],
        allowedHandoffRefs: [C_REVIEW_AGENT_REF],
        tools: [{ name: 'handoff' }],
      },
    });
    expect(reviewer).toMatchObject({
      ok: true,
      value: {
        allowedUnitRefs: [
          REPOSITORY_VIEW_UNIT_REF,
          CONTEXT_BUILD_UNIT_REF,
          MODEL_CALL_UNIT_REF,
          FILE_READ_UNIT_REF,
          RETURN_RESULT_UNIT_REF,
        ],
        tools: [{ name: 'file_read' }, { name: 'submit_review' }],
      },
    });
  });

  it('starts Planner ready and Review Agent waiting for activation', async () => {
    const pool = new AgentToolPool();
    const workflow = new MinimalWorkflow(pool);
    const decision = await workflow.start({ workflowRunId: 'run-1', objective: 'hi' });

    expect(decision).toMatchObject({
      ok: true,
      value: {
        kind: 'EXECUTE_UNIT',
        intent: { unitRef: CONTEXT_BUILD_UNIT_REF },
        state: {
          phase: 'ROUTING',
          agentRuns: {
            'run-1:agent:planner': { status: 'WAITING_UNIT' },
            'run-1:agent:c-review': { status: 'WAITING_ACTIVATION' },
          },
        },
      },
    });
  });
});

describe('minimal full loop', () => {
  it('lets Planner answer a greeting without activating Review Agent or reading files', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(textResponse('你好！')));

    await expect(runPrompt('hi', { apiKey: 'test-key', fetch: fetchMock })).resolves.toBe('你好！');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('runs Planner handoff, repository view, Context, file read and Review final', async () => {
    const root = await makeRepository();
    const responses = [
      toolCallResponse([['handoff', HANDOFF_ARGS]]),
      toolCallResponse([['file_read', { path: 'src/parser.c', startLine: 1, endLine: 4 }]]),
      toolCallResponse([
        [
          'submit_review',
          {
            answer: '发现 input 未检查 NULL 就被解引用。',
            citations: [{ path: 'src/parser.c', startLine: 2, endLine: 3 }],
          },
        ],
      ]),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(responses.shift() ?? textResponse('')),
    );
    const runtime = createExperimentRuntime({ apiKey: 'test-key', fetch: fetchMock });

    const result = await runtime.kernel.run({
      prompt: '审查这个 C 仓库',
      repository: { rootPath: root, revision: 'fixture-v1' },
    });

    expect(result).toEqual({ ok: true, value: { answer: '发现 input 未检查 NULL 就被解引用。' } });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const repositoryViewAttempt = runtime.kernel.getUnitAttempt(
      'workflow-run-1:intent:3:attempt:1',
    );
    expect(repositoryViewAttempt?.history).toEqual([
      'CREATED',
      'ADMISSION_CHECKING',
      'ADMITTED',
      'RUNNING',
      'SUCCEEDED',
    ]);

    const firstReview = requestMessages(fetchMock.mock.calls[1]?.[1]);
    const secondReview = requestMessages(fetchMock.mock.calls[2]?.[1]);
    // Append-only: the second call starts with exactly the first call's messages.
    expect(secondReview.slice(0, firstReview.length)).toEqual(firstReview);
    expect(secondReview.slice(firstReview.length).map((message) => message.role)).toEqual([
      'assistant',
      'tool',
    ]);
    const toolResult = secondReview.at(-1);
    expect(toolResult?.tool_call_id).toBe('call-1');
    expect(toolResult?.content).toContain('return input[0]');
  });

  it('queues parallel file reads and calls the model once after all of them', async () => {
    const root = await makeRepository();
    const responses = [
      toolCallResponse([['handoff', HANDOFF_ARGS]]),
      toolCallResponse([
        ['file_read', { path: 'include/parser.h' }],
        ['file_read', { path: 'src/parser.c' }],
      ]),
      toolCallResponse([
        [
          'submit_review',
          { answer: 'done', citations: [{ path: 'src/parser.c', startLine: 3, endLine: 3 }] },
        ],
      ]),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(responses.shift() ?? textResponse('')),
    );
    const runtime = createExperimentRuntime({ apiKey: 'test-key', fetch: fetchMock });

    const result = await runtime.kernel.run({
      prompt: '审查这个 C 仓库',
      repository: { rootPath: root, revision: 'fixture-v1' },
    });

    expect(result).toEqual({ ok: true, value: { answer: 'done' } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const finalMessages = requestMessages(fetchMock.mock.calls[2]?.[1]);
    expect(finalMessages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    expect(finalMessages[2]?.tool_calls?.map((call) => call.id)).toEqual(['call-1', 'call-2']);
    expect(finalMessages[3]?.content).toContain('int parse(const char *input);');
    expect(finalMessages[4]?.content).toContain('return input[0]');
  });

  it.each<[string, readonly ToolCallSpec[]]>([
    [
      'submit_review mixed with file_read',
      [
        ['file_read', { path: 'src/parser.c' }],
        ['submit_review', { answer: 'x', citations: [] }],
      ],
    ],
    [
      'two submit_review calls',
      [
        ['submit_review', { answer: 'x', citations: [] }],
        ['submit_review', { answer: 'y', citations: [] }],
      ],
    ],
  ])('returns a review turn with %s to the model as tool errors', async (_label, calls) => {
    const root = await makeRepository();
    const responses = [
      toolCallResponse([['handoff', HANDOFF_ARGS]]),
      toolCallResponse(calls),
      toolCallResponse([['file_read', { path: 'src/parser.c' }]]),
      toolCallResponse([['submit_review', VALID_REVIEW]]),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(responses.shift() ?? textResponse('')),
    );
    const result = await runReview(root, fetchMock);

    expect(result).toEqual({ ok: true, value: { answer: VALID_REVIEW.answer } });
    const errors = requestMessages(fetchMock.mock.calls[2]?.[1]).filter(
      (message) => message.role === 'tool',
    );
    expect(errors).toHaveLength(2);
    for (const message of errors) expect(message.content).toContain('INVALID_REVIEW_ACTION');
  });

  it('returns a failed file read to the model instead of ending the run', async () => {
    const root = await makeRepository();
    const responses = [
      toolCallResponse([['handoff', HANDOFF_ARGS]]),
      toolCallResponse([['file_read', { path: 'src/missing.c' }]]),
      toolCallResponse([['file_read', { path: 'src/parser.c' }]]),
      toolCallResponse([['submit_review', VALID_REVIEW]]),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(responses.shift() ?? textResponse('')),
    );
    const result = await runReview(root, fetchMock);

    expect(result).toEqual({ ok: true, value: { answer: VALID_REVIEW.answer } });
    const toolMessage = requestMessages(fetchMock.mock.calls[2]?.[1]).at(-1);
    expect(toolMessage).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
    expect(toolMessage?.content).toContain('Error FILE_READ_FAILED');
  });

  it.each<[string, unknown, string]>([
    [
      'cites a range it never read',
      { answer: 'x', citations: [{ path: 'src/parser.c', startLine: 1, endLine: 99 }] },
      'UNSUPPORTED_REVIEW_CITATION',
    ],
    ['has no citations', { answer: 'x', citations: [] }, 'REVIEW_CITATIONS_REQUIRED'],
  ])(
    'rejects a submit_review that %s and lets the model resubmit',
    async (_label, review, code) => {
      const root = await makeRepository();
      const responses = [
        toolCallResponse([['handoff', HANDOFF_ARGS]]),
        toolCallResponse([['file_read', { path: 'src/parser.c', startLine: 1, endLine: 4 }]]),
        toolCallResponse([['submit_review', review]]),
        toolCallResponse([['submit_review', VALID_REVIEW]]),
      ];
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(responses.shift() ?? textResponse('')),
      );
      const result = await runReview(root, fetchMock);

      expect(result).toEqual({ ok: true, value: { answer: VALID_REVIEW.answer } });
      expect(requestMessages(fetchMock.mock.calls[3]?.[1]).at(-1)?.content).toContain(code);
    },
  );

  it('does not accept a plain-text review and asks for submit_review', async () => {
    const root = await makeRepository();
    const responses = [
      toolCallResponse([['handoff', HANDOFF_ARGS]]),
      toolCallResponse([['file_read', { path: 'src/parser.c' }]]),
      textResponse('Looks fine to me.'),
      toolCallResponse([['submit_review', VALID_REVIEW]]),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(responses.shift() ?? textResponse('')),
    );
    const result = await runReview(root, fetchMock);

    expect(result).toEqual({ ok: true, value: { answer: VALID_REVIEW.answer } });
    const lastTwo = requestMessages(fetchMock.mock.calls[3]?.[1]).slice(-2);
    expect(lastTwo[0]).toMatchObject({ role: 'assistant', content: 'Looks fine to me.' });
    expect(lastTwo[1]).toMatchObject({ role: 'user' });
    expect(lastTwo[1]?.content).toContain('REVIEW_TOOL_REQUIRED');
  });

  it('answers reads beyond the file-read limit with an error instead of failing', async () => {
    const root = await makeRepository();
    const reads: ToolCallSpec[] = Array.from({ length: 17 }, () => [
      'file_read',
      { path: 'src/parser.c' },
    ]);
    const responses = [
      toolCallResponse([['handoff', HANDOFF_ARGS]]),
      toolCallResponse(reads),
      toolCallResponse([['submit_review', VALID_REVIEW]]),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(responses.shift() ?? textResponse('')),
    );
    const result = await runReview(root, fetchMock);

    expect(result).toEqual({ ok: true, value: { answer: VALID_REVIEW.answer } });
    const toolMessages = requestMessages(fetchMock.mock.calls[2]?.[1]).filter(
      (message) => message.role === 'tool',
    );
    expect(toolMessages).toHaveLength(17);
    expect(
      toolMessages.filter((message) => message.content?.includes('FILE_READ_LIMIT')),
    ).toHaveLength(1);
  });

  it('forces submit_review on the last allowed model call', async () => {
    const root = await makeRepository();
    let call = 0;
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      call += 1;
      if (call === 1) return Promise.resolve(toolCallResponse([['handoff', HANDOFF_ARGS]]));
      const body = JSON.parse(requestBody(init)) as { tool_choice: unknown };
      return Promise.resolve(
        body.tool_choice === 'auto'
          ? toolCallResponse([['file_read', { path: 'src/parser.c', startLine: 1, endLine: 4 }]])
          : toolCallResponse([['submit_review', VALID_REVIEW]]),
      );
    });
    const result = await runReview(root, fetchMock);

    expect(result).toEqual({ ok: true, value: { answer: VALID_REVIEW.answer } });
    // 1 Planner call plus the Review Agent's 12 allowed calls; only the last one is forced.
    expect(fetchMock).toHaveBeenCalledTimes(13);
    const lastBody = JSON.parse(requestBody(fetchMock.mock.calls[12]?.[1])) as {
      tool_choice: unknown;
      messages: WireMessage[];
    };
    expect(lastBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'submit_review' },
    });
    expect(lastBody.messages.at(-1)?.content).toContain('final call');
  });

  it('retries a retryable model failure as a new Unit attempt', async () => {
    const responses = [
      jsonResponse({ error: { message: 'rate limited' } }, 429),
      textResponse('hi!'),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(responses.shift() ?? textResponse('')),
    );
    const runtime = createExperimentRuntime({
      apiKey: 'test-key',
      fetch: fetchMock,
      retryDelayMs: 0,
    });

    await expect(runtime.kernel.run({ prompt: 'hi' })).resolves.toEqual({
      ok: true,
      value: { answer: 'hi!' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runtime.kernel.getUnitAttempt('workflow-run-1:intent:2:attempt:1')?.status).toBe(
      'FAILED',
    );
    expect(runtime.kernel.getUnitAttempt('workflow-run-1:intent:2:attempt:2')?.status).toBe(
      'SUCCEEDED',
    );
  });

  it('does not retry a non-retryable model failure', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ error: { message: 'bad request' } }, 400)),
    );
    const runtime = createExperimentRuntime({
      apiKey: 'test-key',
      fetch: fetchMock,
      retryDelayMs: 0,
    });

    await expect(runtime.kernel.run({ prompt: 'hi' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'DEEPSEEK_API_ERROR' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a handoff to an Agent outside the Planner handoff set', async () => {
    const root = await makeRepository();
    const runtime = createExperimentRuntime({
      apiKey: 'test-key',
      fetch: () =>
        Promise.resolve(
          toolCallResponse([['handoff', { ...HANDOFF_ARGS, targetAgentId: 'planner-agent' }]]),
        ),
    });
    const result = await runtime.kernel.run({
      prompt: '审查这个 C 仓库',
      repository: { rootPath: root, revision: 'fixture-v1' },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'HANDOFF_NOT_ALLOWED' } });
  });

  it('adds no status bar unless it is turned on', async () => {
    const root = await makeRepository();
    const responses = [
      toolCallResponse([['handoff', HANDOFF_ARGS]]),
      toolCallResponse([['file_read', { path: 'src/parser.c', startLine: 1, endLine: 4 }]]),
      toolCallResponse([['submit_review', VALID_REVIEW]]),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(responses.shift() ?? textResponse('')),
    );
    await runReview(root, fetchMock);
    for (const [, init] of fetchMock.mock.calls) {
      const text = JSON.stringify(requestMessages(init));
      expect(text).not.toContain('[Run status]');
    }
  });

  it('ends each context with a status bar that is never kept in history', async () => {
    const root = await makeRepository();
    const responses = [
      toolCallResponse([['handoff', HANDOFF_ARGS]]),
      toolCallResponse([['file_read', { path: 'src/parser.c', startLine: 1, endLine: 4 }]]),
      toolCallResponse([['submit_review', VALID_REVIEW]]),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(responses.shift() ?? textResponse('')),
    );
    const result = await createExperimentRuntime({
      apiKey: 'test-key',
      fetch: fetchMock,
      retryDelayMs: 0,
      statusBar: true,
    }).kernel.run({
      prompt: '审查这个 C 仓库',
      repository: { rootPath: root, revision: 'fixture-v1' },
    });
    expect(result).toEqual({ ok: true, value: { answer: VALID_REVIEW.answer } });

    const first = requestMessages(fetchMock.mock.calls[1]?.[1]);
    const second = requestMessages(fetchMock.mock.calls[2]?.[1]);
    expect(first.at(-1)).toEqual({
      role: 'user',
      content: '[Run status] model call 1 of 12 | file reads used 0 of 16 | ranges read: none',
    });
    expect(second.at(-1)?.content).toBe(
      '[Run status] model call 2 of 12 | file reads used 1 of 16 | ranges read: src/parser.c:1-4',
    );
    // Without its trailing status bar, the first request is an exact prefix of the second.
    const firstHistory = first.slice(0, -1);
    expect(second.slice(0, firstHistory.length)).toEqual(firstHistory);
    expect(JSON.stringify(second.slice(0, -1))).not.toContain('[Run status]');
  });

  it('routes every Context build through Kernel', async () => {
    const pool = new AgentToolPool();
    const workflow = new MinimalWorkflow(pool);
    const build = vi.fn<MinimalContextEngine['build']>(() =>
      Promise.resolve({
        ok: true,
        value: {
          agentRef: PLANNER_AGENT_REF,
          promptRef: { id: 'test', version: '1.0.0' },
          messages: [
            { role: 'system', content: 'planner' },
            { role: 'user', content: 'hi' },
          ],
          tools: [],
        },
      }),
    );
    const model: ModelExecutorPort = {
      execute: () =>
        Promise.resolve({
          ok: true,
          value: {
            actions: [{ kind: 'FINAL', answer: 'hello' }],
            turn: { content: 'hello', toolCalls: [] },
            usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
          },
        }),
    };
    const files: FileReadExecutorPort = {
      read: () => Promise.reject(new Error('unexpected read')),
      view: () => Promise.reject(new Error('unexpected view')),
    };
    const kernel = new MinimalKernel(workflow, { build }, model, files, pool);

    await expect(kernel.run({ prompt: 'hi' })).resolves.toEqual({
      ok: true,
      value: { answer: 'hello' },
    });
    expect(build).toHaveBeenCalledOnce();
    expect(kernel.getUnitAttempt('workflow-run-1:intent:1:attempt:1')?.status).toBe('SUCCEEDED');
  });
});

describe('FileReadExecutor', () => {
  it('discovers the checked-in 200-line C review fixture', async () => {
    const fixture = fileURLToPath(new URL('../fixtures/c-review/', import.meta.url));
    const executor = new FileReadExecutor();
    const overview = await executor.view({
      repository: { rootPath: fixture, revision: 'fixture-c-review-v1' },
      maxDepth: 4,
      includeExtensions: ['.c', '.h'],
    });

    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.value.files.map((file) => file.path)).toEqual([
      'include/parser.h',
      'src/main.c',
      'src/parser.c',
      'src/util.c',
    ]);
    expect(overview.value.files.reduce((total, file) => total + file.totalLines, 0)).toBe(200);
  });

  it('produces a repository overview and bounded line-numbered reads', async () => {
    const root = await makeRepository();
    const executor = new FileReadExecutor();
    const repository = { rootPath: root, revision: 'fixture-v1' };

    const overview = await executor.view({
      repository,
      maxDepth: 4,
      includeExtensions: ['.c', '.h'],
    });
    expect(overview).toMatchObject({
      ok: true,
      value: {
        revision: 'fixture-v1',
        files: [{ path: 'include/parser.h' }, { path: 'src/parser.c' }],
      },
    });

    const read = await executor.read({
      repository,
      input: { path: 'src/parser.c', startLine: 2, endLine: 3 },
    });
    expect(read).toMatchObject({
      ok: true,
      value: { path: 'src/parser.c', startLine: 2, endLine: 3 },
    });
    if (read.ok) expect(read.value.content).toContain('   3 |   return input[0];');
  });

  it('marks a read without endLine as truncated when the file is longer than the limit', async () => {
    const root = await makeRepository();
    const lines = Array.from({ length: 150 }, (_, index) => `int line${index + 1};`);
    await writeFile(join(root, 'src', 'long.c'), `${lines.join('\n')}\n`, 'utf8');
    const result = await new FileReadExecutor().read({
      repository: { rootPath: root, revision: 'fixture-v1' },
      input: { path: 'src/long.c' },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { startLine: 1, endLine: 120, totalLines: 150, truncated: true },
    });
  });

  it('rejects repository escapes', async () => {
    const root = await makeRepository();
    const executor = new FileReadExecutor();
    const result = await executor.read({
      repository: { rootPath: root, revision: 'fixture-v1' },
      input: { path: '../secret.txt' },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_FILE_PATH' } });
  });
});

describe('MinimalContextEngine', () => {
  it('does not expose the local repository root path to the model', async () => {
    const pool = new AgentToolPool();
    const agent = await pool.getAgent(C_REVIEW_AGENT_REF);
    if (!agent.ok) throw new Error('Review Agent definition missing.');
    const context = await new MinimalContextEngine(pool).build({
      agentRef: agent.value.ref,
      promptRef: agent.value.promptRef,
      objective: 'review',
      repository: { rootPath: '/Users/someone/private/repo', revision: 'fixture-v1' },
      routingCatalog: [],
      turns: [],
      observations: [],
      limits: { maxModelCalls: 12, maxFileReads: 16 },
      finalCall: false,
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const text = JSON.stringify(context.value.messages);
    expect(text).not.toContain('/Users/someone');
    expect(text).toContain('fixture-v1');
  });

  it('states fixed limits once instead of a remaining budget', async () => {
    const pool = new AgentToolPool();
    const context = await new MinimalContextEngine(pool).build({
      agentRef: C_REVIEW_AGENT_REF,
      promptRef: { id: 'c-repository-review-prompt', version: '1.0.0' },
      objective: 'review',
      routingCatalog: [],
      turns: [],
      observations: [],
      limits: { maxModelCalls: 12, maxFileReads: 16 },
      finalCall: false,
    });
    if (!context.ok) throw new Error(context.error.message);
    const task = context.value.messages[1]?.content ?? '';
    expect(JSON.parse(task)).toMatchObject({ limits: { maxModelCalls: 12, maxFileReads: 16 } });
    expect(task).not.toContain('Remaining');
  });

  it('renders a file read as plain line-numbered text', () => {
    const text = formatFileRead({
      path: 'src/parser.c',
      revision: 'fixture-v1',
      startLine: 2,
      endLine: 3,
      totalLines: 150,
      content: '   2 | int parse(const char *input) {\n   3 |   return input[0];',
      truncated: true,
    });
    expect(text).toBe(
      [
        'src/parser.c (lines 2-3 of 150)',
        '   2 | int parse(const char *input) {',
        '   3 |   return input[0];',
        '[truncated: read from line 4 to continue]',
      ].join('\n'),
    );
  });

  it('pairs a tool-call id reused across turns with its own result', async () => {
    const pool = new AgentToolPool();
    const error = (message: string) =>
      ({ ok: false, error: { code: 'E', message, retryable: false } }) as const;
    const context = await new MinimalContextEngine(pool).build({
      agentRef: C_REVIEW_AGENT_REF,
      promptRef: { id: 'c-repository-review-prompt', version: '1.0.0' },
      objective: 'review',
      routingCatalog: [],
      turns: [
        { content: null, toolCalls: [{ id: 'call-1', name: 'file_read', arguments: '{}' }] },
        { content: null, toolCalls: [{ id: 'call-1', name: 'submit_review', arguments: '{}' }] },
      ],
      observations: [
        { callId: 'call-1', toolName: 'file_read', result: error('first') },
        { callId: 'call-1', toolName: 'submit_review', result: error('second') },
      ],
      limits: { maxModelCalls: 12, maxFileReads: 16 },
      finalCall: false,
    });
    if (!context.ok) throw new Error(context.error.message);
    const tools = context.value.messages.filter((message) => message.role === 'tool');
    expect(tools.map((message) => message.content)).toEqual(['Error E: first', 'Error E: second']);
  });

  it('rejects a replayed tool call that has no observation', async () => {
    const pool = new AgentToolPool();
    const context = await new MinimalContextEngine(pool).build({
      agentRef: C_REVIEW_AGENT_REF,
      promptRef: { id: 'c-repository-review-prompt', version: '1.0.0' },
      objective: 'review',
      routingCatalog: [],
      turns: [{ content: null, toolCalls: [{ id: 'lost', name: 'file_read', arguments: '{}' }] }],
      observations: [],
      limits: { maxModelCalls: 12, maxFileReads: 16 },
      finalCall: false,
    });
    expect(context).toMatchObject({ ok: false, error: { code: 'CONTEXT_MISSING_OBSERVATION' } });
  });
});
