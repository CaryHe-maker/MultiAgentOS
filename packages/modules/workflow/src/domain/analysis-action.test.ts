import { createM1ProtocolRegistry } from '@multiagentos/contracts';
import type { ModelCallOutput, ModelToolCall, PinnedDefinitionSet } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { definitions, repositoryDefinitions } from '../test-support/definitions.js';
import { interpretModelOutput } from './analysis-action.js';

const planner = definitions();
const viewer = definitions('code-viewer', false);
const registry = createM1ProtocolRegistry();
const draft = { summary: '分析结果', conclusions: [], unconfirmed: [] };
const brief = { task: '分析仓库', focusAreas: [], openQuestions: [] };
const call = (toolName: string, args: ModelToolCall['arguments']): ModelToolCall =>
  args === null
    ? { toolCallId: 'call-1', toolName, arguments: null, argumentsError: 'INVALID_JSON' }
    : { toolCallId: 'call-1', toolName, arguments: args };
const output = (...toolCalls: ModelToolCall[]): ModelCallOutput => ({
  finishReason: 'TOOL_CALLS',
  toolCalls,
  hasText: false,
});
const interpret = (value: ModelCallOutput, current = planner, isFinal = false) =>
  interpretModelOutput(value, current, [planner, viewer], isFinal, registry);

describe('model output interpretation', () => {
  it.each(['STOP', 'LENGTH', 'CONTENT_FILTER', 'OTHER'] as const)(
    'rejects empty tool calls with finishReason %s, regardless of text',
    (finishReason) => {
      for (const hasText of [false, true])
        expect(interpret({ finishReason, toolCalls: [], hasText })).toEqual({
          kind: 'INVALID',
          reason: finishReason === 'LENGTH' ? 'OUTPUT_TRUNCATED' : 'NO_ACTION',
        });
    },
  );

  it.each([false, true])('accepts finish when final is %s', (isFinal) => {
    expect(interpret(output(call('finish_analysis', draft)), planner, isFinal)).toEqual({
      kind: 'FINISH',
      toolCallId: 'call-1',
      draft,
    });
  });

  it.each([{}, { ...draft, extra: true }, null, [], 'invalid', 1])(
    'rejects invalid finish arguments %j',
    (args) => {
      expect(interpret(output(call('finish_analysis', args)))).toEqual({
        kind: 'INVALID',
        reason: 'CONTROL_ARGUMENTS_INVALID',
      });
    },
  );

  it('accepts handoff only when the current Agent declares it', () => {
    const value = output(call('handoff_to_code_viewer', brief));
    expect(interpret(value)).toEqual({ kind: 'HANDOFF', toolCallId: 'call-1', brief });
    expect(interpret(value, viewer)).toEqual({ kind: 'INVALID', reason: 'CONTROL_NOT_ALLOWED' });
    expect(interpret(value, planner, true)).toEqual({
      kind: 'INVALID',
      reason: 'CONTROL_NOT_ALLOWED',
    });
  });

  it.each([{}, { ...brief, extra: true }, null])('rejects invalid handoff arguments %j', (args) => {
    expect(interpret(output(call('handoff_to_code_viewer', args)))).toEqual({
      kind: 'INVALID',
      reason: 'CONTROL_ARGUMENTS_INVALID',
    });
  });

  it.each(['finish_analysis', 'handoff_to_code_viewer'])('rejects mixed %s calls', (name) => {
    expect(interpret(output(call(name, null), call('unknown', {})), viewer)).toEqual({
      kind: 'INVALID',
      reason: 'CONTROL_MIXED',
    });
    expect(interpret(output(call('unknown', {}), call(name, null)))).toEqual({
      kind: 'INVALID',
      reason: 'CONTROL_MIXED',
    });
  });

  it('passes unknown calls to Validation instead of inventing their purpose', () => {
    const calls = [call('unknown', {}), { ...call('also_unknown', null), toolCallId: 'call-2' }];
    expect(interpret(output(...calls))).toEqual({ kind: 'TOOL_CALLS', calls });
  });

  it('uses pinned model names rather than hard-coded control tool names', () => {
    const renamed: PinnedDefinitionSet = {
      ...planner,
      tools: planner.tools.map((tool) => ({
        ...tool,
        modelName: tool.id === 'finish-analysis' ? 'custom_finish' : 'custom_handoff',
      })),
    };
    expect(interpret(output(call('custom_finish', draft)), renamed)).toMatchObject({
      kind: 'FINISH',
    });
    expect(interpret(output(call('custom_handoff', brief)), renamed)).toMatchObject({
      kind: 'HANDOFF',
    });
  });

  it('passes UNIT calls to Validation without inspecting their arguments', () => {
    const value = output(call('read_file', null), call('search_repository', { query: 'test' }));
    expect(interpret(value, repositoryDefinitions())).toEqual({
      kind: 'TOOL_CALLS',
      calls: value.toolCalls,
    });
  });
});
