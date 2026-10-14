import {
  AssembleContextPackSchema,
  MEDIA_TYPES,
  estimateItemTokens,
  sha256Hex,
  validate,
  type AssembleContextPack,
  type AssembleExecutorInput,
  type ContextAssembleOutput,
  type ExecutorOutcome,
  type ModelToolSpec,
  type ResolvedStep,
} from '@multiagentos/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { environmentFor } from '../test-support/environments.js';
import { createAssembleExecutor } from './assemble-executor.js';
import { ELIDED_RESULT } from './history-render.js';

const TOOLS: ModelToolSpec[] = [
  { name: 'read_file', description: 'Read.', parameters: { type: 'object' }, purpose: 'UNIT' },
  {
    name: 'finish_analysis',
    description: 'Finish.',
    parameters: { type: 'object' },
    purpose: 'CONTROL',
  },
];

const requestId = (label: string) => `req_test${label.padStart(6, '0')}`;
const fileRef = (text: string) => {
  const sha256 = sha256Hex(text);
  return {
    artifactId: `art_${sha256}`,
    sha256,
    size: Buffer.byteLength(text),
    mediaType: MEDIA_TYPES.fileText,
  };
};

function turn(round: number, ...callIds: string[]): ResolvedStep {
  return {
    step: {
      kind: 'MODEL_TURN',
      round,
      requestId: requestId(`m${round}`),
      toolCalls: callIds.map((toolCallId) => ({
        toolCallId,
        toolName: 'read_file',
        arguments: { path: `${toolCallId}.ts` },
      })),
    },
  };
}

function read(round: number, toolCallId: string, text: string, totalLines?: number): ResolvedStep {
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return {
    step: {
      kind: 'TOOL_RESULT',
      round,
      requestId: requestId(toolCallId),
      toolCallId,
      toolName: 'read_file',
      status: 'OK',
      output: {
        path: `${toolCallId}.ts`,
        startLine: 1,
        endLine: lines,
        totalLines: totalLines ?? lines,
        contentSha256: sha256Hex(text),
        fileSha256: sha256Hex(text),
      },
      outputRef: fileRef(text),
    },
    outputText: text,
  };
}

function rejected(round: number, toolCallId: string): ResolvedStep {
  return {
    step: {
      kind: 'TOOL_RESULT',
      round,
      requestId: requestId(toolCallId),
      toolCallId,
      toolName: 'read_file',
      status: 'REJECTED',
      reasonCode: 'NOT_FOUND',
    },
  };
}

const roundFeedback = (round: number): ResolvedStep => ({
  step: { kind: 'FEEDBACK', round, code: 'WRAP_UP_NOTICE', message: 'Wrap up soon.' },
});

function input(
  history: ResolvedStep[],
  overrides: Partial<AssembleExecutorInput> = {},
): AssembleExecutorInput {
  return {
    objective: 'How does parsing work?',
    final: false,
    tokenBudget: 100_000,
    instructions: 'You are a careful code analyst.',
    toolSpecs: TOOLS,
    history,
    status: { roundsUsed: 2, maxRounds: 10, final: false, budgetState: 'NORMAL' },
    ...overrides,
  };
}

async function assemble(value: AssembleExecutorInput) {
  const outcome: ExecutorOutcome = await createAssembleExecutor().execute(
    value,
    environmentFor('CONTEXT_ASSEMBLE', { kind: 'NONE' }),
  );
  if (outcome.outcome !== 'COMPLETED') return { outcome };
  const pack = JSON.parse(outcome.result.artifact.text) as AssembleContextPack;
  return { outcome, pack, output: outcome.result.output as ContextAssembleOutput };
}

const body = (lines: number, tag: string) =>
  Array.from({ length: lines }, (_, index) => `${tag} ${index + 1}`).join('\n') + '\n';

/** Every tool call of an assistant item is answered by exactly one following tool item. */
function expectPaired(pack: AssembleContextPack) {
  const history = pack.items.filter((item) => item.segment === 'HISTORY');
  const calls = history.flatMap((item) => ('toolCalls' in item ? (item.toolCalls ?? []) : []));
  const answers = history.flatMap((item) => (item.role === 'tool' ? [item.toolCallId] : []));
  expect(answers.sort()).toEqual(calls.map((call) => call.toolCallId).sort());
}

describe('CONTEXT_ASSEMBLE (ExecutorSet 4.4)', () => {
  it('lays out the segments in order with numbered, cited tool results', async () => {
    const { pack } = await assemble(input([turn(1, 'a'), read(1, 'a', 'x\ny\n', 9)]));
    expect(validate(AssembleContextPackSchema, pack)).toMatchObject({ ok: true });
    expect(pack?.items.map((item) => `${item.segment}:${item.role}`)).toEqual([
      'INSTRUCTIONS:system',
      'TOOLS:system',
      'OBJECTIVE:user',
      'HISTORY:assistant',
      'HISTORY:tool',
      'STATUS:user',
    ]);
    const tool = pack?.items[4];
    expect(tool?.content).toBe(
      'a.ts (lines 1-2 of 9)\n1 | x\n2 | y\n[Lines 3-9 not shown; call read_file with startLine 3 to continue.]',
    );
    expect(tool && 'provenance' in tool ? tool.provenance : undefined).toMatchObject({
      path: 'a.ts',
      startLine: 1,
      endLine: 2,
      retrieval: 'FILE_READ',
    });
    expect(pack?.tokenCount).toBe(
      pack?.items.reduce((sum, item) => sum + estimateItemTokens(item), 0),
    );
  });

  it('keeps the prefix hash stable across calls of one AgentRun', async () => {
    const first = await assemble(input([]));
    const later = await assemble(input([turn(1, 'a'), read(1, 'a', 'x\n')]));
    expect(later.output?.prefixSha256).toBe(first.output?.prefixSha256);
    const other = await assemble(input([], { instructions: 'Different prompt.' }));
    expect(other.output?.prefixSha256).not.toBe(first.output?.prefixSha256);
  });

  it('puts tool results right after their call, in call order, before Round feedback', async () => {
    const { pack } = await assemble(
      input([turn(1, 'a', 'b'), roundFeedback(1), rejected(1, 'b'), read(1, 'a', 'x\n')]),
    );
    const history = pack?.items.filter((item) => item.segment === 'HISTORY') ?? [];
    expect(
      history.map((item) => (item.role === 'tool' ? `tool:${item.toolCallId}` : item.role)),
    ).toEqual(['assistant', 'tool:a', 'tool:b', 'user']);
    expect(history[2]?.content).toContain('Error NOT_FOUND: no file at this path');
  });

  it('fails as INTERNAL when a tool call has no result, or a result no call', async () => {
    expect((await assemble(input([turn(1, 'a')]))).outcome).toEqual({
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
      retryable: false,
    });
    expect((await assemble(input([read(1, 'a', 'x\n')]))).outcome).toMatchObject({
      reasonCode: 'INTERNAL',
    });
  });

  it('tells the model on the final call which tool must end the run', async () => {
    const { pack } = await assemble(
      input([], {
        final: true,
        toolSpecs: [TOOLS[1] as ModelToolSpec],
        status: {
          roundsUsed: 10,
          maxRounds: 10,
          final: true,
          budgetState: 'NORMAL',
          wrapUpReason: 'ROUND_LIMIT',
        },
      }),
    );
    expect(pack?.items.at(-1)?.content).toContain(
      'This is your final call because the round limit has been reached. Call finish_analysis now',
    );
  });

  describe('trimming (M1Interface 6.3)', () => {
    const orientPack = {
      contextPackId: 'ctx_orient01',
      operation: 'ORIENT' as const,
      snapshotId: `snp_${sha256Hex('s')}`,
      tokenCount: 0,
      tokenBudget: 10_000,
      truncated: false,
      droppedCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      items: [
        {
          itemId: 'ctx_orient01:0',
          segment: 'ORIENT' as const,
          role: 'user' as const,
          content: body(40, 'tree'),
          contentSha256: sha256Hex(body(40, 'tree')),
          tokenCount: 0,
          reason: 'repository layout',
          provenance: {
            path: '.',
            startLine: 1,
            endLine: 1,
            contentSha256: sha256Hex(body(40, 'tree')),
            retrieval: 'TREE' as const,
          },
        },
      ],
    };
    const history = [
      turn(1, 'a'),
      read(1, 'a', body(60, 'first')),
      turn(2, 'b'),
      read(2, 'b', body(60, 'second')),
    ];
    const full = async () =>
      (await assemble(input(history, { orientPack })))?.output?.tokenCount ?? 0;

    it('elides the oldest tool result first', async () => {
      const budget = (await full()) - 100;
      const { pack, output } = await assemble(input(history, { orientPack, tokenBudget: budget }));
      expect(output).toMatchObject({
        truncated: true,
        droppedCount: 1,
        elidedRequestIds: [requestId('a')],
      });
      const tools = pack?.items.filter((item) => item.role === 'tool') ?? [];
      expect(tools.map((item) => item.content === ELIDED_RESULT)).toEqual([true, false]);
      expect(pack?.items.some((item) => item.segment === 'ORIENT')).toBe(true);
      expect(pack?.tokenCount).toBeLessThanOrEqual(budget);
    });

    it('then drops ORIENT, then whole Rounds from the oldest', async () => {
      const { pack: elidedAll } = await assemble(input(history, { orientPack, tokenBudget: 1 }));
      expect(elidedAll).toBeUndefined(); // below the untrimmable segments: LIMIT_EXCEEDED
      const untrimmable =
        (await assemble(input([], { tokenBudget: 100_000 })))?.output?.tokenCount ?? 0;
      const { pack, output } = await assemble(
        input(history, { orientPack, tokenBudget: untrimmable + 120 }),
      );
      expect(pack?.items.some((item) => item.segment === 'ORIENT')).toBe(false);
      const rounds = pack?.items.filter((item) => item.role === 'assistant').length;
      expect(rounds).toBeLessThan(2);
      expect(output?.elidedRequestIds.sort()).toEqual([requestId('a'), requestId('b')].sort());
      expectPaired(pack as AssembleContextPack);
    });
  });

  it('always fits the budget and keeps calls paired with results', async () => {
    const untrimmable =
      (await assemble(input([], { tokenBudget: 100_000 })))?.output?.tokenCount ?? 0;
    const roundArbitrary = fc.record({
      calls: fc.integer({ min: 0, max: 3 }),
      lines: fc.integer({ min: 1, max: 80 }),
      feedback: fc.boolean(),
      failed: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(roundArbitrary, { maxLength: 6 }),
        fc.integer({ min: 0, max: 6_000 }),
        async (rounds, slack) => {
          const steps: ResolvedStep[] = [];
          rounds.forEach((round, index) => {
            const number = index + 1;
            const ids = Array.from({ length: round.calls }, (_, call) => `r${number}c${call}`);
            steps.push(turn(number, ...ids));
            if (round.feedback) steps.push(roundFeedback(number));
            for (const id of ids.reverse())
              steps.push(
                round.failed ? rejected(number, id) : read(number, id, body(round.lines, id)),
              );
          });
          const budget = untrimmable + slack;
          const { pack, output } = await assemble(input(steps, { tokenBudget: budget }));
          expect(validate(AssembleContextPackSchema, pack)).toMatchObject({ ok: true });
          expect(output?.tokenCount).toBeLessThanOrEqual(budget);
          expectPaired(pack as AssembleContextPack);
        },
      ),
      { numRuns: 60 },
    );
  });
});
