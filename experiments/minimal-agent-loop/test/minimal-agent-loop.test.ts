import { describe, expect, it, vi } from 'vitest';

import {
  AgentToolPool,
  ORIGIN_AGENT_REF,
  ORIGIN_MODEL_UNIT_REF,
  ORIGIN_RETURN_UNIT_REF,
} from '../src/agent-tool-pool.js';
import type { ModelExecutorPort, WorkflowPort } from '../src/contracts.js';
import {
  DEEPSEEK_API_URL,
  DEEPSEEK_MODEL,
  ModelExecutor,
} from '../src/executors/model-executor.js';
import { MinimalKernel } from '../src/kernel.js';
import { runPrompt } from '../src/runtime.js';
import { MinimalWorkflow } from '../src/workflow.js';

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

describe('ModelExecutor', () => {
  it('sends the original prompt to DeepSeek V4.1 Flash and maps its answer', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: '模型回答' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      ),
    );
    const executor = new ModelExecutor({ apiKey: 'test-key', fetch: fetchMock });

    const result = await executor.execute({ prompt: '  保留空格的原文  ' });

    expect(result).toEqual({
      ok: true,
      value: {
        answer: '模型回答',
        usage: { inputTokens: 11, outputTokens: 7 },
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(DEEPSEEK_API_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(requestBody(init))).toEqual({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: '  保留空格的原文  ' }],
      stream: false,
    });
  });

  it('fails before making a request when the API key is missing', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const executor = new ModelExecutor({ apiKey: '', fetch: fetchMock });

    const result = await executor.execute({ prompt: 'hello' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'MISSING_DEEPSEEK_API_KEY', retryable: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks rate-limit responses as retryable', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ error: { message: 'rate limited' } }, 429)),
    );
    const executor = new ModelExecutor({ apiKey: 'test-key', fetch: fetchMock });

    const result = await executor.execute({ prompt: 'hello' });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'DEEPSEEK_API_ERROR',
        message: expect.stringContaining('rate limited') as string,
        retryable: true,
      },
    });
  });
});

describe('minimal main path', () => {
  it('routes prompt through kernel, workflow and model executor', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: '最终回答' } }] })),
    );

    await expect(runPrompt('用户 prompt', { apiKey: 'test-key', fetch: fetchMock })).resolves.toBe(
      '最终回答',
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(requestBody(init)) as { messages: { content: string }[] };
    expect(body.messages[0]?.content).toBe('用户 prompt');
  });

  it('keeps file reading explicitly unavailable', async () => {
    const definitions = new AgentToolPool();
    const workflow = new MinimalWorkflow(definitions);
    const modelExecutor: ModelExecutorPort = {
      execute: () =>
        Promise.resolve({
          ok: true,
          value: { answer: 'unused', usage: { inputTokens: 0, outputTokens: 0 } },
        }),
    };
    const kernel = new MinimalKernel(workflow, modelExecutor, definitions);

    const result = await kernel.dispatch({
      target: 'FILE_READ_EXECUTOR',
      input: {
        repository: { rootPath: '.', revision: 'unused' },
        input: { path: 'unused' },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_NOT_IMPLEMENTED' },
    });
  });

  it('stores Origin Agent and both standard Units in AgentToolPool', async () => {
    const definitions = new AgentToolPool();

    const agent = await definitions.getAgent(ORIGIN_AGENT_REF);
    const modelUnit = await definitions.getUnit(ORIGIN_MODEL_UNIT_REF);
    const returnUnit = await definitions.getUnit(ORIGIN_RETURN_UNIT_REF);

    expect(agent).toEqual({
      ok: true,
      value: {
        ref: ORIGIN_AGENT_REF,
        name: 'Origin Agent',
        promptPolicy: 'PASSTHROUGH',
        unitRefs: [ORIGIN_MODEL_UNIT_REF, ORIGIN_RETURN_UNIT_REF],
      },
    });
    expect(modelUnit).toMatchObject({ ok: true, value: { kind: 'MODEL_EXECUTOR' } });
    expect(returnUnit).toMatchObject({ ok: true, value: { kind: 'RETURN_RESULT' } });
  });

  it('makes Workflow emit the two Unit intents in strict order', async () => {
    const definitions = new AgentToolPool();
    const workflow = new MinimalWorkflow(definitions);

    const first = await workflow.run({
      objective: 'raw prompt',
      completedUnits: [],
    });
    expect(first).toEqual({
      ok: true,
      value: {
        agentRef: ORIGIN_AGENT_REF,
        nextUnit: { unitRef: ORIGIN_MODEL_UNIT_REF, input: { prompt: 'raw prompt' } },
        stepNumber: 1,
      },
    });

    const second = await workflow.run({
      objective: 'raw prompt',
      completedUnits: [
        {
          unitRef: ORIGIN_MODEL_UNIT_REF,
          output: { answer: 'model answer', usage: { inputTokens: 2, outputTokens: 3 } },
        },
      ],
    });
    expect(second).toEqual({
      ok: true,
      value: {
        agentRef: ORIGIN_AGENT_REF,
        nextUnit: { unitRef: ORIGIN_RETURN_UNIT_REF, input: { answer: 'model answer' } },
        stepNumber: 2,
      },
    });
  });

  it('rejects a Workflow that skips directly to RETURN_RESULT', async () => {
    const definitions = new AgentToolPool();
    const skippingWorkflow: WorkflowPort = {
      run: () =>
        Promise.resolve({
          ok: true,
          value: {
            agentRef: ORIGIN_AGENT_REF,
            nextUnit: { unitRef: ORIGIN_RETURN_UNIT_REF, input: { answer: 'skip' } },
            stepNumber: 1,
          },
        }),
    };
    const execute = vi.fn<ModelExecutorPort['execute']>(() =>
      Promise.resolve({
        ok: true,
        value: { answer: 'unused', usage: { inputTokens: 0, outputTokens: 0 } },
      }),
    );
    const kernel = new MinimalKernel(skippingWorkflow, { execute }, definitions);

    const result = await kernel.run({ prompt: 'raw prompt' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_UNIT_SEQUENCE' },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
