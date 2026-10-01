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
import { MinimalContextEngine } from '../src/context-engine.js';
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
  instructions: 'system instructions',
  input: '{"objective":"hi"}',
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

    const secondReviewContextBody = JSON.parse(requestBody(fetchMock.mock.calls[2]?.[1])) as {
      messages: { role: string; content: string }[];
    };
    const reviewerInput = secondReviewContextBody.messages[1]?.content ?? '';
    expect(reviewerInput).toContain('src/parser.c');
    expect(reviewerInput).toContain('return input[0]');
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
    const finalBody = JSON.parse(requestBody(fetchMock.mock.calls[2]?.[1])) as {
      messages: { role: string; content: string }[];
    };
    const finalInput = finalBody.messages[1]?.content ?? '';
    expect(finalInput).toContain('int parse(const char *input);');
    expect(finalInput).toContain('return input[0]');
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
  ])('rejects a review turn with %s', async (_label, calls) => {
    const root = await makeRepository();
    const responses = [toolCallResponse([['handoff', HANDOFF_ARGS]]), toolCallResponse(calls)];
    const runtime = createExperimentRuntime({
      apiKey: 'test-key',
      fetch: () => Promise.resolve(responses.shift() ?? textResponse('')),
    });
    const result = await runtime.kernel.run({
      prompt: '审查这个 C 仓库',
      repository: { rootPath: root, revision: 'fixture-v1' },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REVIEW_ACTION' } });
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

  it('routes every Context build through Kernel', async () => {
    const pool = new AgentToolPool();
    const workflow = new MinimalWorkflow(pool);
    const build = vi.fn<MinimalContextEngine['build']>(() =>
      Promise.resolve({
        ok: true,
        value: {
          agentRef: PLANNER_AGENT_REF,
          promptRef: { id: 'test', version: '1.0.0' },
          instructions: 'planner',
          input: 'hi',
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
      observations: [],
      status: { modelCallsRemaining: 1, fileReadsRemaining: 1 },
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.value.input).not.toContain('/Users/someone');
    expect(context.value.input).toContain('fixture-v1');
  });
});
