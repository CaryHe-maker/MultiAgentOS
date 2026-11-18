/**
 * The evaluation system tests itself (docs/M2/Evaluation.md 6): the self-check tasks run and are
 * judged as they should be, a task that must fail is recorded as failed, the figures come out of
 * the log, and a regression is found by the rules.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reply, scriptedChat } from '../acceptance/chat-driver.js';
import { maxOverlap, metricsOf } from './metrics.js';
import { DEFAULT_RULES, compare, summarize } from './report.js';
import { judgeRun, runTask } from './runner.js';
import type { RunRecord, TaskSpec } from './spec.js';
import { ALL_TASKS, select } from './tasks/index.js';

const ENV = {
  version: { commit: 'test', definitions: 'test' },
  model: { id: 'deepseek-flash' },
};
const TIMEOUT = 60_000;

describe('the self-check tasks', () => {
  for (const task of ALL_TASKS.filter((each) => each.scripted !== undefined))
    it(
      `${task.id} runs offline and every check holds`,
      async () => {
        const record = await runTask(task, 1, ENV);
        expect(record.error).toBeUndefined();
        expect(record.checks.filter((each) => !each.ok)).toEqual([]);
        expect(record.ok).toBe(true);
        expect(record.provider).toBe('scripted');
        expect(record.metrics.modelRequests).toBeGreaterThan(0);
        expect(record.metrics.inputs).toBeGreaterThan(0);
      },
      TIMEOUT,
    );

  it(
    'cover every angle that is judged',
    () => {
      expect(
        new Set(ALL_TASKS.flatMap((task) => task.tags)).has('safety') &&
          new Set(ALL_TASKS.flatMap((task) => task.tags)).has('context') &&
          new Set(ALL_TASKS.flatMap((task) => task.tags)).has('write'),
      ).toBe(true);
    },
    TIMEOUT,
  );

  it('can be picked by id and by tag', () => {
    expect(select(ALL_TASKS, ['selfcheck.attack']).map((task) => task.id)).toEqual([
      'selfcheck.attack',
    ]);
    expect(select(ALL_TASKS, ['tag:safety']).length).toBeGreaterThanOrEqual(1);
    expect(select(ALL_TASKS, ['all'])).toHaveLength(ALL_TASKS.length);
  });
});

describe('what the runner records', () => {
  const failing: TaskSpec = {
    id: 'control.fails',
    mode: 'chat',
    tags: ['control'],
    description: 'A judge that says no must make the record say no.',
    fixture: () => Promise.resolve(),
    steps: [{ say: 'hello' }],
    scripted: () => scriptedChat(reply('hi')),
    judge: () => [{ name: 'must fail', angle: 'OUTCOME', ok: false, detail: 'on purpose' }],
  };

  it(
    'marks a task failed when a check fails, and keeps which one',
    async () => {
      const record = await runTask(failing, 1, ENV);
      expect(record.ok).toBe(false);
      expect(record.checks).toEqual([
        { name: 'must fail', angle: 'OUTCOME', ok: false, detail: 'on purpose' },
      ]);
    },
    TIMEOUT,
  );

  it(
    'measures the tokens of a run from the log the product wrote, not from anything a task says',
    async () => {
      const record = await runTask(failing, 1, ENV);
      // One scripted answer of 100 input and 10 output tokens: the model turn of the log has them.
      expect(record.metrics.modelRequests).toBe(1);
      expect(record.metrics.tokens).toMatchObject({ input: 100, output: 10 });
    },
    TIMEOUT,
  );

  it(
    'marks a task failed when the steps do not finish, and still judges what is there',
    async () => {
      const stuck: TaskSpec = {
        ...failing,
        id: 'control.stuck',
        steps: [{ waitFor: () => false, what: 'something that never happens' }],
        judge: () => [{ name: 'ran', angle: 'OUTCOME', ok: true }],
      };
      const record = await runTask(stuck, 1, { ...ENV, stepTimeoutMs: 200 });
      expect(record.ok).toBe(false);
      expect(record.error).toContain('something that never happens');
      expect(record.checks).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'marks a task failed when the judge throws',
    async () => {
      const record = await runTask(
        {
          ...failing,
          id: 'control.throws',
          judge: () => {
            throw new Error('boom');
          },
        },
        1,
        ENV,
      );
      expect(record.ok).toBe(false);
      expect(record.checks[0]?.detail).toBe('boom');
    },
    TIMEOUT,
  );

  it('refuses a task of the real model without a key', async () => {
    const withoutScript: TaskSpec = { ...failing, id: 'control.real' };
    delete (withoutScript as { scripted?: unknown }).scripted;
    await expect(runTask(withoutScript, 1, ENV)).rejects.toThrow(/needs a key/u);
  });
});

describe('the figures of the log', () => {
  const at = (second: number) => `2026-11-09T10:00:${String(second).padStart(2, '0')}.000Z`;
  const log = [
    { type: 'HUMAN_ANSWERED', kind: 'prompt', at: at(0) },
    { type: 'AGENT_RUN_REGISTERED', agentRef: { id: 'main' }, at: at(0) },
    {
      type: 'MODEL_TURN',
      at: at(1),
      toolCalls: [
        { toolName: 'read_file', toolCallId: 'call_a' },
        { toolName: 'read_file', toolCallId: 'call_b' },
      ],
      usage: { inputTokens: 1000, outputTokens: 100, inputCacheHitTokens: 600 },
    },
    {
      type: 'UNIT_SUBMITTED',
      requestId: 'req_a',
      at: at(2),
      inputSource: { kind: 'TOOL_CALL', toolCallId: 'call_a' },
    },
    {
      type: 'UNIT_SUBMITTED',
      requestId: 'req_b',
      at: at(2),
      inputSource: { kind: 'TOOL_CALL', toolCallId: 'call_b' },
    },
    { type: 'UNIT_COMPLETED', requestId: 'req_a', status: 'OK', at: at(4) },
    {
      type: 'UNIT_COMPLETED',
      requestId: 'req_b',
      status: 'REJECTED',
      reasonCode: 'PATH_ESCAPE',
      at: at(3),
    },
    {
      type: 'CONTEXT_COMPACTED',
      at: at(5),
      usage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 0 },
    },
    { type: 'TOOL_RESULTS_PRUNED', items: [{}, {}], at: at(5) },
    { type: 'HUMAN_REQUESTED', kind: 'prompt', at: at(6) },
    { type: 'HUMAN_REQUESTED', kind: 'ask', at: at(6) },
  ];

  it('counts requests, tokens, cache hits, tools and outcomes without any help from a task', () => {
    const metrics = metricsOf(log, { authorizationQuestions: 2 });
    expect(metrics.modelRequests).toBe(1);
    expect(metrics.tokens).toMatchObject({
      input: 1000,
      output: 100,
      cacheHit: 600,
      compactionInput: 500,
      compactionOutput: 50,
    });
    expect(metrics.cacheHitRate).toBeCloseTo(0.6);
    expect(metrics.toolRequests).toEqual({ read_file: 2 });
    expect(metrics.toolOutcomes).toEqual({
      'read_file:OK': 1,
      'read_file:REJECTED(PATH_ESCAPE)': 1,
    });
    expect(metrics.agentRuns).toEqual({ main: 1 });
    expect(metrics.maxParallelUnits).toBe(2);
    expect(metrics.compactions).toEqual({ summarised: 1, pruned: 2 });
    expect(metrics.humanRequests).toBe(1);
    expect(metrics.authorizationQuestions).toBe(2);
    expect(metrics.logWallMs).toBe(6000);
    expect(metrics.costUsd).toBeNull();
  });

  it('prices a run from the price list of the model', () => {
    const pricing = {
      currency: 'USD',
      offPeak: { inputCacheHit: 1, inputCacheMiss: 2, output: 4 },
      peak: { ratePercent: 100, weekdays: [], windows: [] },
    } as never;
    const metrics = metricsOf(log, { model: { pricing } });
    // 600 hits at 1, 400 misses at 2, 100 output at 4, then the compaction: 500 misses at 2, 50 at 4.
    expect(metrics.costUsd).toBeCloseTo((600 + 800 + 400 + 1000 + 200) / 1_000_000);
  });

  it('finds the overlap of intervals; touching ones do not overlap', () => {
    expect(maxOverlap([])).toBe(0);
    expect(
      maxOverlap([
        [0, 5],
        [5, 9],
      ]),
    ).toBe(1);
    expect(
      maxOverlap([
        [0, 5],
        [1, 3],
        [2, 9],
      ]),
    ).toBe(3);
  });
});

describe('reports and regressions', () => {
  const record = (
    over: Partial<RunRecord> & {
      cost?: number;
      ok?: boolean;
      elapsedMs?: number;
      requests?: number;
      hit?: number;
    },
    run: number,
  ): RunRecord => {
    const { cost, requests, hit, ...rest } = over;
    return {
      schema: 1,
      taskId: 't',
      mode: 'chat',
      tags: [],
      run,
      at: 'x',
      version: { commit: 'c', definitions: 'd' },
      model: 'm',
      provider: 'real',
      ok: true,
      checks: [],
      elapsedMs: 10_000,
      metrics: {
        logWallMs: 0,
        inputs: 1,
        modelRequests: requests ?? 4,
        failedModelRequests: 0,
        tokens: { input: 100, output: 10, cacheHit: 50, compactionInput: 0, compactionOutput: 0 },
        cacheHitRate: hit ?? 0.5,
        costUsd: cost ?? 0.01,
        toolRequests: { read_file: 2 },
        toolOutcomes: {},
        agentRuns: {},
        maxParallelUnits: 1,
        compactions: { summarised: 0, pruned: 0 },
        authorizationQuestions: 0,
        humanRequests: 0,
        wrapUps: 0,
      },
      ...rest,
    };
  };
  const runs = (count: number, over: Parameters<typeof record>[0] = {}) =>
    Array.from({ length: count }, (_, index) => record(over, index + 1));

  it('summarises a task: pass rate, means, tools per run', () => {
    const [only] = summarize([...runs(3), record({ ok: false, cost: 0.03 }, 4)]);
    expect(only).toMatchObject({ taskId: 't', runs: 4, passed: 3, passRate: 0.75 });
    expect(only?.meanCostUsd).toBeCloseTo(0.015);
    expect(only?.toolsPerRun).toEqual({ read_file: 2 });
  });

  it('finds nothing between two identical sets', () => {
    expect(compare(runs(3), runs(3)).filter((each) => each.severity === 'REGRESSION')).toEqual([]);
  });

  it('finds a fall of the pass rate, and growth of cost, time and requests, and a fall of the cache hit', () => {
    const worse = [
      ...runs(1, { ok: false, cost: 0.02, elapsedMs: 30_000, requests: 9, hit: 0.2 }),
      ...runs(2, { cost: 0.02, elapsedMs: 30_000, requests: 9, hit: 0.2 }).map((each, index) => ({
        ...each,
        run: index + 2,
      })),
    ];
    const messages = compare(runs(3), worse)
      .filter((each) => each.severity === 'REGRESSION')
      .map((each) => each.message)
      .join('\n');
    expect(messages).toContain('mean cost grew');
    expect(messages).toContain('mean time grew');
    expect(messages).toContain('mean model requests grew');
    expect(messages).toContain('cache hit rate fell');
    // One failed run of three is a fall of a third, over the threshold.
    expect(messages).toContain('pass rate fell');
  });

  it('does not judge a pass rate on too few runs, and says so', () => {
    const findings = compare(runs(1), runs(1, { ok: false }));
    expect(findings.some((each) => each.severity === 'REGRESSION')).toBe(false);
    expect(findings.map((each) => each.message).join()).toContain('too few runs');
    expect(DEFAULT_RULES.minRuns).toBe(3);
  });

  it('notes tasks that appear or disappear', () => {
    const findings = compare(runs(3), runs(3, { taskId: 'u' }));
    expect(findings.map((each) => each.message)).toEqual(
      expect.arrayContaining([
        'new task, nothing to compare with',
        'task is not in the new records',
      ]),
    );
  });
});

describe('a run a person starts and watches, judged afterwards (prepare, judge)', () => {
  const watched: TaskSpec = {
    id: 'control.watched',
    mode: 'mission',
    tags: ['control'],
    description: 'A mission judged from its repository, its log and what main replied.',
    fixture: (repository) => writeFile(join(repository, 'README.md'), '# watched\n'),
    steps: [{ run: 'say hello' }],
    scripted: () => scriptedChat(reply('hello')),
    judge: (observation) => [
      { name: 'exited 0', angle: 'OUTCOME', ok: observation.exitCode === 0 },
      {
        name: 'one reply',
        angle: 'BEHAVIOR',
        ok: observation.printed('REPLY').length === 1,
        detail: String(observation.printed('REPLY').length),
      },
      {
        name: 'the repository is there',
        angle: 'OUTCOME',
        ok: existsSync(join(observation.repository, 'README.md')),
      },
    ],
  };

  it(
    'records what the evaluation records of the same Session, and leaves the repository as it was',
    async () => {
      const archive = await mkdtemp(join(tmpdir(), 'mas-eval-archive-'));
      const before = process.env['EVAL_ARCHIVE'];
      process.env['EVAL_ARCHIVE'] = archive;
      try {
        const evaluated = await runTask(watched, 1, ENV);
        const [folder] = await readdir(archive);
        if (folder === undefined) throw new Error('nothing was kept');
        // The kept run stands for a run of mas run: its data directory and its repository.
        const kept = join(archive, folder);
        const judged = await judgeRun(
          watched,
          1,
          ENV,
          { dataDir: kept, repository: join(kept, 'repository') },
          0,
        );
        expect(judged.ok).toBe(true);
        expect(judged.checks).toEqual(evaluated.checks);
        expect(judged.metrics).toEqual(evaluated.metrics);
        expect(judged.provider).toBe('real');
        expect(judged.elapsedMs).toBeGreaterThanOrEqual(0);
        const failed = await judgeRun(
          watched,
          2,
          ENV,
          { dataDir: kept, repository: join(kept, 'repository') },
          1,
        );
        expect(failed.ok).toBe(false);
        expect(failed.checks.find((each) => each.name === 'exited 0')?.ok).toBe(false);
      } finally {
        if (before === undefined) delete process.env['EVAL_ARCHIVE'];
        else process.env['EVAL_ARCHIVE'] = before;
        await rm(archive, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it('refuses a data directory that is not one run of its own', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'mas-eval-empty-'));
    try {
      await expect(
        judgeRun(watched, 1, ENV, { dataDir: empty, repository: empty }, 0),
      ).rejects.toThrow(/holds 0 Sessions/u);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
