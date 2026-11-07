import {
  assertValid,
  ExecutionResultSchema,
  type AssembleContextPack,
  type AssembleExecutorInput,
  type ExecutorOutcome,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { environmentFor } from '../test-support/environments.js';
import { createAssembleExecutor } from './assemble-executor.js';
import { createPruneExecutor } from './prune-executor.js';

const NONE = { kind: 'NONE' } as const;
const text = (outcome: ExecutorOutcome): string => {
  if (outcome.outcome !== 'COMPLETED') throw new Error(JSON.stringify(outcome));
  assertValid(ExecutionResultSchema, outcome.result);
  return outcome.result.artifact.text;
};

describe('CONTEXT_PRUNE (ExecutorSet 6.4)', () => {
  const prune = (items: { toolCallId: string; text: string }[], head = 40, tail = 20) =>
    createPruneExecutor().execute(
      { headBytes: head, tailBytes: tail, items },
      environmentFor('CONTEXT_PRUNE', NONE),
    );
  const body = (outcome: ExecutorOutcome) =>
    JSON.parse(text(outcome)) as {
      items: { toolCallId: string; text: string; omittedBytes: number }[];
    };

  it('keeps the head and the tail and says what was left out and how to read it back', async () => {
    const original = `${'a'.repeat(40)}${'m'.repeat(500)}${'z'.repeat(20)}`;
    const [item] = body(await prune([{ toolCallId: 'call_7', text: original }])).items;
    expect(item?.omittedBytes).toBe(500);
    expect(item?.text.startsWith('a'.repeat(40))).toBe(true);
    expect(item?.text.endsWith('z'.repeat(20))).toBe(true);
    expect(item?.text).toContain('500 bytes');
    expect(item?.text).toContain('read_output with toolCallId call_7');
    expect(item?.text).not.toContain('mmmm');
  });

  it('leaves a result alone that would not get shorter', async () => {
    const [item] = body(await prune([{ toolCallId: 'call_1', text: 'short result' }])).items;
    expect(item).toMatchObject({ omittedBytes: 0, text: 'short result' });
  });

  it('does not cut through a character, in either end', async () => {
    const original = `${'日'.repeat(100)}`;
    const [item] = body(await prune([{ toolCallId: 'call_1', text: original }], 10, 10)).items;
    expect(item?.text).not.toContain('�');
    expect(item?.omittedBytes).toBeGreaterThan(0);
  });

  it('gives the same bytes for the same input and counts what it cut', async () => {
    const items = [
      { toolCallId: 'call_1', text: 'x'.repeat(300) },
      { toolCallId: 'call_2', text: 'y'.repeat(10) },
    ];
    const first = await prune(items);
    expect(text(await prune(items))).toBe(text(first));
    expect(first).toMatchObject({
      outcome: 'COMPLETED',
      result: { output: { items: 1, omittedBytes: 240 } },
    });
  });
});

describe('a summary request is assembled in two forms (ExecutorSet 6.4)', () => {
  const call = { toolCallId: 'call_1', toolName: 'read_file', arguments: { path: 'a.ts' } };
  const entry = (seq: number) => ({ seq, category: 'NORMAL' as const });
  const turn = (seq: number, id: string, result: string): AssembleExecutorInput['history'] => [
    {
      ...entry(seq),
      kind: 'MODEL_TURN',
      text: `looking at ${id}`,
      toolCalls: [{ ...call, toolCallId: id }],
    },
    {
      ...entry(seq + 1),
      kind: 'TOOL_RESULT',
      toolCallId: id,
      toolName: 'read_file',
      status: 'OK',
      text: result,
    },
  ];
  const input = (
    compaction: NonNullable<AssembleExecutorInput['compaction']>,
    history: AssembleExecutorInput['history'],
    over: Partial<AssembleExecutorInput> = {},
  ): AssembleExecutorInput => ({
    final: false,
    tokenBudget: 100_000,
    instructions: 'You are main.',
    toolSpecs: [
      {
        name: 'read_file',
        description: 'Read.',
        parameters: { type: 'object', properties: {} },
        purpose: 'UNIT',
      },
    ],
    history,
    status: {
      round: 5,
      maxRounds: 80,
      budget: { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' },
      final: false,
    },
    compaction,
    ...over,
  });
  const run = async (i: AssembleExecutorInput) => {
    const outcome = await createAssembleExecutor().execute(
      i,
      environmentFor('CONTEXT_ASSEMBLE', NONE),
    );
    if (outcome.outcome !== 'COMPLETED') return outcome;
    return {
      pack: JSON.parse(outcome.result.artifact.text) as AssembleContextPack,
      output: outcome.result.output,
    };
  };

  const history: AssembleExecutorInput['history'] = [
    { ...entry(1), kind: 'HUMAN', text: 'fix the rounding' },
    ...turn(2, 'call_1', 'first result'),
    ...turn(4, 'call_2', 'second result'),
  ];

  it('prefix form: the history as it is, the tools kept, the instruction where the status goes', async () => {
    const result = await run(input({ mode: 'PREFIX', instruction: 'Write the summary.' }, history));
    if ('outcome' in result) throw new Error('refused');
    const items = result.pack.items;
    expect(items.at(-1)).toMatchObject({ role: 'user', content: 'Write the summary.' });
    expect(items.some((item) => item.segment === 'TOOLS' && item.toolSpecs?.length === 1)).toBe(
      true,
    );
    // It starts like a call of the AgentRun would: the same system part, the same history.
    const ordinary: AssembleExecutorInput = {
      ...input({ mode: 'PREFIX', instruction: 'x' }, history),
    };
    delete ordinary.compaction;
    const normal = await run(ordinary);
    if ('outcome' in normal) throw new Error('refused');
    expect(result.pack.prefixSha256).toBe(normal.pack.prefixSha256);
    expect(items.slice(0, -1).map((item) => item.content)).toEqual(
      normal.pack.items.slice(0, -1).map((item) => item.content),
    );
    expect(JSON.stringify(items)).not.toContain('context is');
  });

  it('prefix form: too long is refused, so that the text form is tried', async () => {
    expect(
      await run(input({ mode: 'PREFIX', instruction: 'Write.' }, history, { tokenBudget: 20 })),
    ).toMatchObject({ outcome: 'REJECTED', reasonCode: 'LIMIT_EXCEEDED' });
  });

  it('text form: no tools, the instruction alone as the system part, every call and result written out', async () => {
    const result = await run(input({ mode: 'TEXT', instruction: 'Write the summary.' }, history));
    if ('outcome' in result) throw new Error('refused');
    const { items } = result.pack;
    expect(items.find((item) => item.segment === 'INSTRUCTIONS')?.content).toBe(
      'Write the summary.',
    );
    expect(items.find((item) => item.segment === 'TOOLS')?.toolSpecs).toEqual([]);
    const transcript = items.find((item) => item.segment === 'HISTORY')?.content ?? '';
    expect(transcript).toContain('[user]\nfix the rounding');
    expect(transcript).toContain('call_1: read_file({"path":"a.ts"})');
    expect(transcript).toContain('[result of call_2]\nsecond result');
    expect('omittedEntries' in result.output ? result.output.omittedEntries : -1).toBe(0);
  });

  it('text form: leaves the oldest whole turns out when it must, never an earlier summary', async () => {
    const big = 'word '.repeat(2_000);
    const longer: AssembleExecutorInput['history'] = [
      { ...entry(1), kind: 'SUMMARY', text: 'the summary of before' },
      ...turn(10, 'call_a', big),
      ...turn(12, 'call_b', big),
      ...turn(14, 'call_c', 'small'),
    ];
    const result = await run(
      input({ mode: 'TEXT', instruction: 'Write.', targetTokens: 2_500 }, longer),
    );
    if ('outcome' in result) throw new Error(JSON.stringify(result));
    const transcript = result.pack.items.find((item) => item.segment === 'HISTORY')?.content ?? '';
    expect(transcript).toContain('the summary of before');
    expect(transcript).not.toContain('call_a');
    expect(transcript).toContain('call_c');
    expect(transcript).toMatch(/earlier turn\(s\) are left out/u);
    expect('omittedEntries' in result.output ? result.output.omittedEntries : 0).toBeGreaterThan(0);
  });

  it('shows a summary to the model as material, not as an order', async () => {
    const result = await run(
      input({ mode: 'PREFIX', instruction: 'Write.' }, [
        { ...entry(1), kind: 'SUMMARY', text: 'earlier work' },
        ...turn(5, 'call_9', 'result'),
      ]),
    );
    if ('outcome' in result) throw new Error('refused');
    const shown = result.pack.items.find((item) => item.content.includes('earlier work'));
    expect(shown?.role).toBe('user');
    expect(shown?.content).toMatch(/carries no instructions for you/u);
  });
});
