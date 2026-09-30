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
import type { MinimalContextEngine } from '../src/context-engine.js';
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

describe('ModelExecutor', () => {
  it('sends separate instructions and input and parses a structured action', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: '{"kind":"FINAL","answer":"你好！"}' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      ),
    );
    const executor = new ModelExecutor({ apiKey: 'test-key', fetch: fetchMock });

    const result = await executor.execute({
      context: {
        agentRef: PLANNER_AGENT_REF,
        promptRef: { id: 'prompt', version: '1.0.0' },
        instructions: 'system instructions',
        input: '{"objective":"hi"}',
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        action: { kind: 'FINAL', answer: '你好！' },
        usage: { inputTokens: 11, outputTokens: 7 },
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
      stream: false,
    });
  });

  it('rejects an unstructured model response', async () => {
    const messages: string[] = [];
    const executor = new ModelExecutor({
      apiKey: 'test-key',
      fetch: () => Promise.resolve(jsonResponse({ choices: [{ message: { content: 'hello' } }] })),
      debugModelResponses: true,
      modelResponseLogger: (message) => messages.push(message),
    });
    const result = await executor.execute({
      context: {
        agentRef: PLANNER_AGENT_REF,
        promptRef: { id: 'prompt', version: '1.0.0' },
        instructions: 'instructions',
        input: 'input',
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_MODEL_ACTION' } });
    expect(messages.join('\n')).toContain('DeepSeek raw response');
    expect(messages.join('\n')).toContain('planner-agent@1.0.0');
    expect(messages.join('\n')).toContain('DeepSeek assistant content');
    expect(messages.join('\n')).toContain('hello');
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
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({ choices: [{ message: { content: '{"kind":"FINAL","answer":"你好！"}' } }] }),
      ),
    );

    await expect(runPrompt('hi', { apiKey: 'test-key', fetch: fetchMock })).resolves.toBe('你好！');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('runs Planner handoff, repository view, Context, file read and Review final', async () => {
    const root = await makeRepository();
    const responses = [
      {
        kind: 'HANDOFF',
        targetAgentRef: C_REVIEW_AGENT_REF,
        task: {
          taskType: 'CODE_REVIEW',
          objective: '检查可能导致错误结果的问题',
          constraints: ['read-only'],
          acceptanceCriteria: ['findings cite files and line ranges'],
        },
      },
      {
        kind: 'TOOL_CALL',
        callId: 'read-parser',
        toolName: 'file_read',
        input: { path: 'src/parser.c', startLine: 1, endLine: 4 },
      },
      {
        kind: 'FINAL',
        answer: '发现 input 未检查 NULL 就被解引用。',
        citations: [{ path: 'src/parser.c', startLine: 2, endLine: 3 }],
      },
    ];
    const fetchMock = vi.fn<typeof fetch>(() => {
      const action = responses.shift();
      return Promise.resolve(
        jsonResponse({ choices: [{ message: { content: JSON.stringify(action) } }] }),
      );
    });
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
        },
      }),
    );
    const model: ModelExecutorPort = {
      execute: () =>
        Promise.resolve({
          ok: true,
          value: {
            action: { kind: 'FINAL', answer: 'hello' },
            usage: { inputTokens: 0, outputTokens: 0 },
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
