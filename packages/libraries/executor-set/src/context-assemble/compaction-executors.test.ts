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
      budget: { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' },
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
    // (An ordinary call ends with its status only when the status has something to say, D61.)
    expect(items.slice(0, -1).map((item) => item.content)).toEqual(
      normal.pack.items.filter((item) => item.segment !== 'STATUS').map((item) => item.content),
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

describe('the status that ends a request (D61)', () => {
  const statusOf = async (
    round: number,
    over: Partial<AssembleExecutorInput['status']> = {},
  ): Promise<string | undefined> => {
    const outcome = await createAssembleExecutor().execute(
      {
        final: over.final ?? false,
        tokenBudget: 100_000,
        instructions: 'You are a worker.',
        toolSpecs: [],
        history: [{ seq: 1, category: 'NORMAL', kind: 'HUMAN', text: 'go' }],
        status: {
          round,
          maxRounds: 40,
          budget: { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' },
          final: false,
          ...over,
        },
      },
      environmentFor('CONTEXT_ASSEMBLE', NONE),
    );
    const pack = JSON.parse(text(outcome)) as AssembleContextPack;
    return pack.items.find((item) => item.segment === 'STATUS')?.content;
  };

  it('tells the rounds at the first, at half, at three quarters and in each of the last five', async () => {
    expect(await statusOf(1)).toContain('You have 40 rounds');
    expect(await statusOf(2)).toBeUndefined();
    expect(await statusOf(19)).toBeUndefined();
    expect(await statusOf(20)).toContain('half of your rounds are used');
    expect(await statusOf(30)).toContain('three quarters of your rounds are used');
    expect(await statusOf(31)).toBeUndefined();
    expect(await statusOf(34)).toBeUndefined();
    for (const round of [35, 36, 37, 38, 39])
      expect(await statusOf(round)).toContain('the round limit is near');
    expect(await statusOf(40, { final: true })).toContain('This is your final call');
  });

  it('tells at every call which background commands still run, and whose they were (D65)', async () => {
    const status = await statusOf(7, {
      jobs: [
        { name: 'job_1', command: 'npm run dev', seconds: 42 },
        { name: 'coretext/job_1', command: 'wc -l /dev/zero', seconds: 251, from: 'coretext' },
      ],
    });
    expect(status).toContain(
      'Background command job_1 (npm run dev) is still running, 42 s in the background. You can stop it with job_kill if you no longer need it.',
    );
    expect(status).toContain(
      'Background command coretext/job_1 (wc -l /dev/zero) is still running, 251 s in the background; your subtask coretext started it and has ended, so it is yours now. You can stop it with job_kill',
    );
    expect(await statusOf(7, { jobs: [] })).toBeUndefined();
  });

  it('tells a task that can split, while its background command runs, that other parts can start (D86)', async () => {
    const statusWith = async (tools: string[], final = false) => {
      const outcome = await createAssembleExecutor().execute(
        {
          final,
          tokenBudget: 100_000,
          instructions: 'You are main.',
          toolSpecs: tools.map((name) => ({
            name,
            description: name,
            parameters: { type: 'object', properties: {} },
            purpose: name === 'reply' ? ('CONTROL' as const) : ('UNIT' as const),
          })),
          history: [{ seq: 1, category: 'NORMAL', kind: 'HUMAN', text: 'go' }],
          status: {
            round: 7,
            maxRounds: 120,
            budget: { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' },
            final,
            jobs: [{ name: 'job_1', command: 'python3 tools/resolve.py all', seconds: 300 }],
          },
        },
        environmentFor('CONTEXT_ASSEMBLE', NONE),
      );
      const pack = JSON.parse(text(outcome)) as AssembleContextPack;
      return pack.items.find((item) => item.segment === 'STATUS')?.content ?? '';
    };
    const line = 'parts that do not depend on its result can start now';
    expect(await statusWith(['run_subagents', 'reply'])).toContain(line);
    expect(await statusWith(['run_command', 'finish_subagent'])).not.toContain(line);
    expect(await statusWith(['run_subagents', 'reply'], true)).not.toContain(line);
  });

  it('tells a task whose subtasks have all ended to check the whole once and deliver (D70)', async () => {
    expect(await statusOf(12, { partsBack: true })).toContain('All your subtasks have ended.');
    expect(await statusOf(12, { partsBack: true, partsBackMinutes: 9 })).toContain(
      'All your subtasks have ended, the last one 9 min ago.',
    );
    expect(await statusOf(40, { final: true, partsBack: true })).not.toContain('All your subtasks');
  });

  it('tells how much of its time a task waited on its commands (D82)', async () => {
    expect(await statusOf(12, { commandMinutes: { commands: 9, total: 14 } })).toContain(
      'Your commands have taken 9 of your 14 minutes so far.',
    );
    expect(
      await statusOf(40, { final: true, commandMinutes: { commands: 9, total: 14 } }),
    ).not.toContain('Your commands have taken');
  });

  it('tells the last subtask still running that its caller waits only on it (D72)', async () => {
    expect(await statusOf(12, { lastRunning: true })).toContain(
      'You are the only subtask still running',
    );
    expect(await statusOf(40, { final: true, lastRunning: true })).not.toContain('only subtask');
  });

  it('tells a task that can split and has not, once at round 10 (D73)', async () => {
    const statusWith = async (round: number, tools: string[]) => {
      const outcome = await createAssembleExecutor().execute(
        {
          final: false,
          tokenBudget: 100_000,
          instructions: 'You are main.',
          toolSpecs: tools.map((name) => ({
            name,
            description: name,
            parameters: { type: 'object', properties: {} },
            purpose: 'UNIT' as const,
          })),
          history: [{ seq: 1, category: 'NORMAL', kind: 'HUMAN', text: 'go' }],
          status: {
            round,
            maxRounds: 120,
            budget: { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' },
            final: false,
            noSubtasksYet: true,
          },
        },
        environmentFor('CONTEXT_ASSEMBLE', NONE),
      );
      const pack = JSON.parse(text(outcome)) as AssembleContextPack;
      return pack.items.find((item) => item.segment === 'STATUS')?.content ?? '';
    };
    expect(await statusWith(10, ['run_subagents'])).toContain('Round 10, no subtasks yet.');
    expect(await statusWith(11, ['run_subagents'])).not.toContain('no subtasks yet');
    expect(await statusWith(10, ['read_file'])).not.toContain('no subtasks yet');
  });

  it('says plainly what a final call asked again must do', async () => {
    const asked = await statusOf(40, { final: true, finalRetry: true });
    expect(asked).toContain('This is your final call');
    expect(asked).toContain('did not call exactly one of');
    expect(await statusOf(40, { final: true })).not.toContain('did not call exactly one of');
  });

  it('tells the budget only when it is no longer normal', async () => {
    expect(await statusOf(7)).toBeUndefined();
    expect(
      await statusOf(7, { budget: { agentRun: 'NORMAL', input: 'NORMAL', run: 'WRAP_UP' } }),
    ).toBe('Budget: this request NORMAL, run WRAP_UP.');
  });
});
