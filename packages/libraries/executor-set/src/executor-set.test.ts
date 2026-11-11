import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DENY_SANDBOX,
  AssembleContextPackSchema,
  ExecutionResultSchema,
  assertValid,
  type AssembleContextPack,
  type AssembleExecutorInput,
  type ExecutorEnvironment,
  type ResolvedHistoryEntry,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { createAssembleExecutor } from './context-assemble/assemble-executor.js';
import { createFileReadExecutor } from './file-read/file-read-executor.js';
import { createModelCallExecutor, retryAfterMsOf } from './model-call/model-call-executor.js';
import { FileDigestCache } from './repository-access/file-set.js';
import { createListExecutor } from './repository-list/list-executor.js';

const NOW = new Date('2026-11-02T00:00:00.000Z');
const deadline = '2026-11-02T01:00:00.000Z';
const environment = (over: Partial<ExecutorEnvironment>): ExecutorEnvironment => ({
  scope: { kind: 'NONE' },
  limits: { deadline, maxOutputBytes: 100_000 },
  signal: new AbortController().signal,
  subprocess: { run: () => Promise.reject(new Error('no subprocess')) },
  sandbox: DENY_SANDBOX,
  credentials: { apiKeyFor: () => 'test-key' },
  now: () => NOW,
  ...over,
});

const status = {
  round: 2,
  maxRounds: 10,
  budget: { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' },
  final: false,
} as const;
const call = { toolCallId: 'call_1', toolName: 'read_file', arguments: { path: 'a' } };
const entry = (seq: number, category: 'PINNED' | 'NORMAL' = 'NORMAL') => ({ seq, category });
const conversation: ResolvedHistoryEntry[] = [
  { ...entry(1, 'PINNED'), kind: 'HUMAN', text: 'hello' },
  { ...entry(2), kind: 'MODEL_TURN', text: 'reading', toolCalls: [call], reasoningContent: 'hmm' },
  {
    ...entry(3),
    kind: 'TOOL_RESULT',
    toolCallId: 'call_1',
    toolName: 'read_file',
    status: 'REJECTED',
    reasonCode: 'USER_DECLINED',
  },
  {
    ...entry(4, 'PINNED'),
    kind: 'PROJECT_INSTRUCTIONS',
    path: 'AGENTS.md',
    text: 'be careful',
    trusted: false,
  },
];
const assembleInput = (over: Partial<AssembleExecutorInput> = {}): AssembleExecutorInput => ({
  final: false,
  tokenBudget: 10_000,
  instructions: 'You are main.',
  toolSpecs: [],
  history: conversation,
  status,
  ...over,
});

async function assembled(input: AssembleExecutorInput) {
  const outcome = await createAssembleExecutor().execute(input, environment({}));
  if (outcome.outcome !== 'COMPLETED') return outcome;
  assertValid(ExecutionResultSchema, outcome.result);
  return assertValid<AssembleContextPack>(
    AssembleContextPackSchema,
    JSON.parse(outcome.result.artifact.text),
  );
}

const packOf = async (input: AssembleExecutorInput) => {
  const pack = await assembled(input);
  if ('outcome' in pack) throw new Error(pack.outcome);
  return pack;
};

describe('context-assemble', () => {
  it('keeps the log order, tells the refusal, and marks untrusted instructions', async () => {
    const pack = await packOf(assembleInput());
    const history = pack.items.filter((item) => item.segment === 'HISTORY');
    expect(history.map((item) => item.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(history[1]).toMatchObject({ reasoningContent: 'hmm' });
    expect(history[2]?.content).toBe('the user rejected tool "read_file"\n[toolCallId: call_1]');
    expect(history[3]?.content).toContain('not trusted by the user');
    expect(pack.items.at(-1)?.segment).toBe('STATUS');
  });

  it('ends every tool result with its toolCallId, whatever the result was', async () => {
    const second = { toolCallId: 'call_2', toolName: 'run_command', arguments: {} };
    const pack = await packOf(
      assembleInput({
        history: [
          ...conversation.slice(0, 3),
          { ...entry(5), kind: 'MODEL_TURN', text: 'again', toolCalls: [second] },
          {
            ...entry(6),
            kind: 'TOOL_RESULT',
            toolCallId: 'call_2',
            toolName: 'run_command',
            status: 'OK',
            text: 'exit code 0\nall good',
          },
        ],
      }),
    );
    const results = pack.items.filter((item) => item.role === 'tool');
    expect(results.map((item) => item.content.split('\n').at(-1))).toEqual([
      '[toolCallId: call_1]',
      '[toolCallId: call_2]',
    ]);
    expect(results[1]?.content).toContain('all good');
  });

  it('keeps AGENTS.md out of the system segments', async () => {
    const pack = await packOf(assembleInput());
    expect(
      pack.items.filter((item) => item.role === 'system').map((item) => item.content),
    ).not.toContain('be careful');
  });

  it('makes one pack a prefix of the next', async () => {
    const shorter = await packOf(assembleInput());
    const longer = await packOf(
      assembleInput({
        history: [...conversation, { ...entry(5), kind: 'NOTE', text: 'a new day' }],
      }),
    );
    const content = (pack: AssembleContextPack) =>
      pack.items.filter((item) => item.segment !== 'STATUS').map((item) => item.content);
    expect(content(longer).slice(0, content(shorter).length)).toEqual(content(shorter));
  });

  it('refuses an ordinary call over budget instead of cutting it', async () => {
    expect(await assembled(assembleInput({ tokenBudget: 5 }))).toMatchObject({
      outcome: 'REJECTED',
      reasonCode: 'LIMIT_EXCEEDED',
    });
  });

  it('warns the model once the context is nearly full, and not before', async () => {
    const history = [
      ...conversation,
      { ...entry(5), kind: 'NOTE' as const, text: 'word '.repeat(300) },
    ];
    const status = (pack: AssembleContextPack) => pack.items.at(-1)?.content ?? '';
    const size = (await packOf(assembleInput({ history }))).tokenCount;
    expect(status(await packOf(assembleInput({ history, tokenBudget: size * 2 })))).not.toContain(
      'Warning',
    );
    const warned = status(await packOf(assembleInput({ history, tokenBudget: size + 50 })));
    expect(warned).toContain('Warning: the context is');
    expect(warned).toContain('your next call is the final one');
  });

  it('judges the limit by the calibrated figure', async () => {
    const size = (await packOf(assembleInput())).tokenCount;
    const measuredDouble = {
      tokenCalibration: { measuredInputTokens: size * 2, estimatedInputTokens: size },
    };
    await expect(
      assembled(assembleInput({ tokenBudget: size + 10, ...measuredDouble })),
    ).resolves.toMatchObject({ outcome: 'REJECTED', reasonCode: 'LIMIT_EXCEEDED' });
    const pack = await packOf(assembleInput({ tokenBudget: size * 3, ...measuredDouble }));
    expect(pack.tokenCount).toBe(size * 2);
  });

  it('lets only a final call drop whole old rounds, never a PINNED entry or the latest', async () => {
    const long = 'x'.repeat(4000);
    const old: ResolvedHistoryEntry[] = [
      { ...entry(1, 'PINNED'), kind: 'HUMAN', text: 'hello' },
      { ...entry(2), kind: 'MODEL_TURN', text: long, toolCalls: [] },
      { ...entry(3), kind: 'MODEL_TURN', text: 'latest', toolCalls: [] },
    ];
    const input = assembleInput({
      history: old,
      final: true,
      tokenBudget: 500,
      status: { ...status, final: true },
    });
    const pack = await packOf(input);
    expect(pack.elidedEntries).toEqual([2]);
    expect(pack.items.map((item) => item.content)).toContain('hello');
    expect(pack.items.map((item) => item.content)).toContain('latest');
  });

  it('warns a few rounds before the round limit and asks for a handover in the last one', async () => {
    const statusOf = async (over: { round: number; maxRounds: number }) => {
      const pack = await packOf(assembleInput({ status: { ...status, ...over } }));
      return pack.items.find((item) => item.segment === 'STATUS')?.content ?? '';
    };
    const far = await statusOf({ round: 4, maxRounds: 80 });
    expect(far).not.toContain('round limit');
    const near = await statusOf({ round: 77, maxRounds: 80 });
    expect(near).toContain('After 2 more working rounds, round 80 is your final call');
    const last = await statusOf({ round: 79, maxRounds: 80 });
    expect(last).toContain('This is your last working round');
    const final = await packOf(
      assembleInput({
        final: true,
        status: { ...status, round: 80, maxRounds: 80, final: true, wrapUpReason: 'ROUND_LIMIT' },
      }),
    );
    const text = final.items.find((item) => item.segment === 'STATUS')?.content ?? '';
    expect(text).toContain('round limit has been reached');
    expect(text).toContain('next prompt the user could send');
  });

  it('fails on a call without an answer', async () => {
    const outcome = await createAssembleExecutor().execute(
      assembleInput({ history: conversation.slice(0, 2) }),
      environment({}),
    );
    expect(outcome).toMatchObject({ outcome: 'FAILED', reasonCode: 'INTERNAL' });
  });
});

describe('tools', () => {
  const repository = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mao-v1-')));
    mkdirSync(join(root, 'src'));
    for (let index = 0; index < 30; index += 1)
      writeFileSync(join(root, 'src', `f${String(index)}.ts`), 'x\n');
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\n');
    return root;
  };
  const toolEnvironment = (root: string, maxLines = 2000) =>
    environment({
      scope: { kind: 'REPOSITORY', repositoryRoot: root, exclusions: [] },
      limits: {
        deadline,
        maxOutputBytes: 100_000,
        preview: { maxBytes: 10_000, maxLines },
        maxFullOutputBytes: 100_000,
      },
    });

  it('renders a file as numbered lines for the model', async () => {
    const outcome = await createFileReadExecutor().execute(
      { path: 'a.ts' },
      toolEnvironment(repository()),
    );
    if (outcome.outcome !== 'COMPLETED') throw new Error(outcome.outcome);
    expect(outcome.result.artifact.text).toContain('a.ts (lines 1-2 of 2)');
  });

  it('lists the repository, and keeps the full output when the preview is cut', async () => {
    const list = createListExecutor(new FileDigestCache());
    const whole = await list.execute({ depth: 2 }, toolEnvironment(repository()));
    if (whole.outcome !== 'COMPLETED') throw new Error(whole.outcome);
    expect('fullOutput' in whole.result).toBe(false);
    const cut = await list.execute({ depth: 2 }, toolEnvironment(repository(), 5));
    if (cut.outcome !== 'COMPLETED') throw new Error(cut.outcome);
    assertValid(ExecutionResultSchema, cut.result);
    expect(cut.result.artifact.text).toContain('more entries omitted');
    expect('fullOutput' in cut.result).toBe(true);
  });

  it('does not tell a missing path from an excluded one', async () => {
    expect(
      await createListExecutor(new FileDigestCache()).execute(
        { path: 'nothing' },
        toolEnvironment(repository()),
      ),
    ).toMatchObject({ outcome: 'REJECTED', reasonCode: 'NOT_FOUND' });
  });
});

describe('model-call', () => {
  const scope = {
    kind: 'MODEL',
    provider: 'deepseek',
    apiModelId: 'deepseek-v4',
    apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
    baseUrl: 'https://api.deepseek.com',
    thinking: 'ENABLED',
    thinkingEffort: 'high',
  } as const;
  const tools = [
    { name: 'reply', description: 'reply', parameters: { type: 'object' }, purpose: 'CONTROL' },
    { name: 'read_file', description: 'read', parameters: { type: 'object' }, purpose: 'UNIT' },
  ] as const;
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const answer = (message: object, finish_reason = 'tool_calls') =>
    new Response(
      JSON.stringify({
        id: 'x',
        created: 0,
        model: 'deepseek-v4',
        choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }],
        usage,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const toolCall = (name: string, args: string) => ({
    tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }],
  });
  async function run(
    reply: () => Response,
    over: {
      final?: boolean;
      finalMode?: 'AUTO' | 'FORCED';
      replayKeep?: number;
      history?: ResolvedHistoryEntry[];
    } = {},
  ) {
    const bodies: Record<string, unknown>[] = [];
    const pack = await packOf(
      assembleInput({
        toolSpecs: [...tools],
        ...(over.history === undefined ? {} : { history: over.history }),
      }),
    );
    const executor = createModelCallExecutor({
      ...(over.replayKeep === undefined ? {} : { replayKeep: over.replayKeep }),
      fetch: (_url, init) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return Promise.resolve(reply());
      },
    });
    const outcome = await executor.execute(
      {
        contextPack: pack,
        final: over.final ?? false,
        ...(over.finalMode === undefined ? {} : { finalMode: over.finalMode }),
      },
      environment({ scope, limits: { deadline, maxOutputBytes: 100_000, maxOutputTokens: 100 } }),
    );
    return { outcome, body: bodies[0] ?? {} };
  }

  it('replays the thinking of earlier turns and hands back the new one apart', async () => {
    const { outcome, body } = await run(() =>
      answer({ ...toolCall('read_file', '{}'), reasoning_content: 'new thought' }),
    );
    expect(body['messages']).toEqual(
      expect.arrayContaining([expect.objectContaining({ reasoning_content: 'hmm' })]),
    );
    expect(outcome).toMatchObject({
      outcome: 'COMPLETED',
      result: { output: { hasReasoning: true }, reasoning: { text: 'new thought' } },
    });
    if (outcome.outcome === 'COMPLETED')
      expect(outcome.result.artifact.text).not.toContain('new thought');
  });

  it('replays the thinking of only the latest steps when a window is set', async () => {
    const turn = (seq: number, id: string, thought: string): ResolvedHistoryEntry => ({
      ...entry(seq),
      kind: 'MODEL_TURN',
      text: `step ${String(seq)}`,
      toolCalls: [{ ...call, toolCallId: id }],
      reasoningContent: thought,
    });
    const result = (seq: number, id: string): ResolvedHistoryEntry => ({
      ...entry(seq),
      kind: 'TOOL_RESULT',
      toolCallId: id,
      toolName: 'read_file',
      status: 'REJECTED',
      reasonCode: 'USER_DECLINED',
    });
    const history = [
      { ...entry(1, 'PINNED'), kind: 'HUMAN' as const, text: 'go' },
      turn(2, 'call_a', 'first thought'),
      result(3, 'call_a'),
      turn(4, 'call_b', 'second thought'),
      result(5, 'call_b'),
      turn(6, 'call_c', 'third thought'),
      result(7, 'call_c'),
    ];
    const thoughts = async (replayKeep?: number) => {
      const { body } = await run(() => answer(toolCall('read_file', '{}')), {
        history,
        ...(replayKeep === undefined ? {} : { replayKeep }),
      });
      return (body['messages'] as { role: string; reasoning_content?: string }[])
        .filter((message) => message.role === 'assistant')
        .map((message) => message.reasoning_content);
    };
    expect(await thoughts()).toEqual(['first thought', 'second thought', 'third thought']);
    expect(await thoughts(2)).toEqual(['', 'second thought', 'third thought']);
    expect(await thoughts(0)).toEqual(['', '', '']);
  });

  it('leaves a final call free first, and forces the tool with thinking off on the retry', async () => {
    const free = await run(() => answer(toolCall('reply', '{}')), {
      final: true,
      finalMode: 'AUTO',
    });
    expect(free.body['tool_choice']).toBe('auto');
    const forced = await run(() => answer(toolCall('reply', '{}')), {
      final: true,
      finalMode: 'FORCED',
    });
    expect(forced.body['tool_choice']).toMatchObject({ function: { name: 'reply' } });
    expect(forced.body['thinking']).toEqual({ type: 'disabled' });
  });

  it('fails retryably when a final call does not end properly', async () => {
    const { outcome } = await run(() => answer(toolCall('read_file', '{}')), { final: true });
    expect(outcome).toMatchObject({
      reasonCode: 'PROVIDER_TOOL_CHOICE_IGNORED',
      retryable: true,
      requestState: 'SENT',
    });
  });

  it('hands back Retry-After with a rate limit', async () => {
    const { outcome } = await run(
      () =>
        new Response('{"error":{"message":"slow down"}}', {
          status: 429,
          headers: { 'retry-after': '3', 'content-type': 'application/json' },
        }),
    );
    expect(outcome).toMatchObject({ reasonCode: 'PROVIDER_RATE_LIMITED', retryAfterMs: 3000 });
  });

  it('reads both forms of Retry-After, and ignores anything else', () => {
    expect(retryAfterMsOf('2', NOW)).toBe(2000);
    expect(retryAfterMsOf('Mon, 02 Nov 2026 00:00:05 GMT', NOW)).toBe(5000);
    expect(retryAfterMsOf('soon', NOW)).toBeUndefined();
    expect(retryAfterMsOf(undefined, NOW)).toBeUndefined();
  });
});
