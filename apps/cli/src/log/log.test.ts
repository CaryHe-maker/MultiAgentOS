import type { ArtifactRef, SessionLogRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { clip, duration, plain, renderSessionList, renderTimeline } from './render.js';
import { buildTimeline, type ReadText } from './timeline.js';

const ref = (name: string): ArtifactRef => ({
  artifactId: `art_${name}`,
  mediaType: 'text/plain',
  sha256: name.padEnd(64, '0'),
  size: 1,
});

const bodies = new Map<string, string>();
const store = (name: string, text: string): ArtifactRef => {
  bodies.set(`art_${name}`, text);
  return ref(name);
};
const readText: ReadText = (artifact) => Promise.resolve(bodies.get(artifact.artifactId));

const at = (second: number): string => new Date(Date.UTC(2026, 10, 7, 10, 0, second)).toISOString();
const log = (records: readonly object[]): SessionLogRecord[] =>
  records.map((record, index) => ({ seq: index + 1, ...record })) as SessionLogRecord[];

const modelOutput = JSON.stringify({
  provider: 'deepseek',
  apiModelId: 'deepseek-flash',
  providerFinishReason: 'tool_calls',
  text: 'looking',
  toolCalls: [{ toolCallId: 'call_1', toolName: 'read_file', argumentsText: '{"path":"a.txt"}' }],
  usage: { inputTokens: 1200, outputTokens: 80, inputCacheHitTokens: 900 },
  receivedAt: at(3),
});

function sampleLog(): SessionLogRecord[] {
  return log([
    {
      type: 'SESSION_STARTED',
      at: at(0),
      repositoryRoot: '/work/repo',
      sandbox: { state: 'ISOLATED' },
    },
    // The user's message is answered before the Turn starts.
    {
      type: 'HUMAN_ANSWERED',
      at: at(1),
      kind: 'prompt',
      origin: 'initial',
      contentRef: store('user1', 'read a.txt'),
    },
    { type: 'TURN_STARTED', at: at(1), turnId: 'trn_1' },
    {
      type: 'AGENT_RUN_REGISTERED',
      at: at(1),
      turnId: 'trn_1',
      agentRunId: 'agr_1',
      agentRef: { kind: 'AGENT', id: 'main', version: '1.0.0' },
    },
    {
      type: 'UNIT_SUBMITTED',
      at: at(1),
      turnId: 'trn_1',
      requestId: 'req_m',
      agentRunId: 'agr_1',
      inputSource: { kind: 'STRUCTURED', input: {} },
    },
    {
      type: 'CONTEXT_ASSEMBLED',
      at: at(2),
      turnId: 'trn_1',
      requestId: 'req_m',
      tokenCount: 1300,
      tokenBudget: 100000,
    },
    {
      type: 'MODEL_TURN',
      at: at(4),
      turnId: 'trn_1',
      requestId: 'req_m',
      agentRunId: 'agr_1',
      outputRef: store('out1', modelOutput),
      reasoningRef: store('think1', 'I should read the file first.'),
      toolCalls: [{ toolName: 'read_file', toolCallId: 'call_1', argsDigest: 'x' }],
      replayable: true,
    },
    {
      type: 'AUTHORIZATION_REQUESTED',
      at: at(4),
      turnId: 'trn_1',
      questionId: 'qst_1',
      capability: 'repo.read',
    },
    {
      type: 'AUTHORIZATION_DECIDED',
      at: at(5),
      turnId: 'trn_1',
      questionId: 'qst_1',
      capability: 'repo.read',
      resolution: 'GRANTED',
    },
    {
      type: 'UNIT_SUBMITTED',
      at: at(5),
      turnId: 'trn_1',
      requestId: 'req_t',
      agentRunId: 'agr_1',
      inputSource: { kind: 'TOOL_CALL', modelTurnRequestId: 'req_m', toolCallId: 'call_1' },
    },
    {
      type: 'UNIT_COMPLETED',
      at: at(6),
      turnId: 'trn_1',
      requestId: 'req_t',
      status: 'OK',
      outputRef: store('res1', 'line one\nline two'),
    },
    { type: 'TURN_ENDED', at: at(7), turnId: 'trn_1', reason: 'COMPLETED' },
    { type: 'LOG_TAIL_REPAIRED', at: at(8), truncatedBytes: 12 },
    // A record type from a newer version.
    { type: 'SOMETHING_NEW', at: at(9) },
  ]);
}

describe('buildTimeline', () => {
  it('puts the user message, the model call, the tool and the authorization into the part of their input', async () => {
    const timeline = await buildTimeline(sampleLog(), readText);
    expect(timeline.repositoryRoot).toBe('/work/repo');
    expect(timeline.sandbox).toBe('ISOLATED');
    expect(timeline.inputs).toHaveLength(1);
    const [turn] = timeline.inputs;
    expect(turn?.user).toEqual(['read a.txt']);
    expect(turn?.endReason).toBe('COMPLETED');
    const kinds = turn?.entries.map((entry) => entry.kind);
    expect(kinds).toEqual(['MODEL', 'AUTHORIZATION', 'TOOL']);

    const model = turn?.entries[0];
    if (model?.kind !== 'MODEL') throw new Error('expected a model entry');
    expect(model.agent).toBe('main');
    expect(model.durationMs).toBe(3000);
    expect(model.reasoning).toBe('I should read the file first.');
    expect(model.text).toBe('looking');
    expect(model.context).toEqual({ tokens: 1300, budget: 100000 });
    expect(model.toolCalls).toEqual([
      { toolCallId: 'call_1', toolName: 'read_file', args: '{"path":"a.txt"}' },
    ]);

    const authorization = turn?.entries[1];
    expect(authorization).toMatchObject({ kind: 'AUTHORIZATION', resolution: 'GRANTED' });

    const toolEntry = turn?.entries[2];
    expect(toolEntry).toMatchObject({
      kind: 'TOOL',
      toolName: 'read_file',
      status: 'OK',
      durationMs: 1000,
      output: 'line one\nline two',
      args: '{"path":"a.txt"}',
    });
    expect(timeline.totals).toMatchObject({
      modelCalls: 1,
      toolCalls: 1,
      inputTokens: 1200,
      outputTokens: 80,
      cacheHitTokens: 900,
    });
  });

  it('keeps records outside a Turn apart and skips a type it does not know', async () => {
    const timeline = await buildTimeline(sampleLog(), readText);
    expect(
      timeline.outside.map((entry) => (entry.kind === 'EVENT' ? entry.label : entry.kind)),
    ).toEqual(['日志末尾被修复']);
    expect(timeline.records).toBe(sampleLog().length);
  });

  it('says so when a body expired instead of failing', async () => {
    const empty: ReadText = () => Promise.resolve(undefined);
    const timeline = await buildTimeline(sampleLog(), empty);
    const [turn] = timeline.inputs;
    expect(turn?.user).toEqual([undefined]);
    const model = turn?.entries[0];
    if (model?.kind !== 'MODEL') throw new Error('expected a model entry');
    expect(model.reasoning).toBeUndefined();
    expect(model.reasoningMissing).toBe(true);
    expect(model.toolCalls[0]?.args).toBeUndefined();
    const text = renderTimeline(timeline, { full: false });
    expect(text).toContain('内容已过期或缺失');
  });
});

describe('renderTimeline', () => {
  it('shows the Turn as a readable time line', async () => {
    const text = renderTimeline(await buildTimeline(sampleLog(), readText), {
      sessionId: 'ses_1',
      full: false,
    });
    expect(text).toContain('对话 ses_1');
    expect(text).toContain('仓库：/work/repo');
    expect(text).toContain('1 次输入 · 1 次模型调用 · 1 次工具调用');
    expect(text).toContain('第 1 次输入');
    expect(text).toContain('你：read a.txt');
    expect(text).toContain('模型 main  3.0s  输入 1,200（命中 900） 输出 80');
    expect(text).toContain('思考：I should read the file first.');
    expect(text).toContain('调用：read_file {"path":"a.txt"}');
    expect(text).toContain('授权 repo.read：允许');
    expect(text).toContain('工具 read_file  OK  1.0s');
    expect(text).toContain('结果：line one');
  });

  it('cleans control characters out of what a model or a web page said', () => {
    const attack = 'ok\u001b[2J\u001b]0;pwned\u0007 ‮evil\u0085 done\r\nnext';
    const cleaned = plain(attack);
    for (const forbidden of ['\u001b', '\u0007', '‮', '\u0085', '\r'])
      expect(cleaned.includes(forbidden), JSON.stringify(forbidden)).toBe(false);
    expect(cleaned).toContain('ok');
    expect(cleaned).toContain('done\nnext');
  });

  it('cuts a long body to its first lines, and `full` keeps all of it', () => {
    const body = Array.from({ length: 20 }, (_, index) => `line ${String(index)}`).join('\n');
    const short = clip(body, false);
    expect(short).toContain('line 2');
    expect(short).not.toContain('line 3\n');
    expect(short).toContain('加 --full 看全文');
    expect(clip(body, true)).toBe(body);
  });

  it('writes durations the way people read them', () => {
    expect(duration(250)).toBe('250ms');
    expect(duration(3200)).toBe('3.2s');
    expect(duration(65_000)).toBe('1m05s');
  });
});

describe('renderSessionList', () => {
  it('numbers the Sessions and says when there are none', () => {
    expect(renderSessionList([])).toContain('还没有对话');
    const text = renderSessionList([
      {
        sessionId: 'ses_a',
        createdAt: at(0),
        lastActiveAt: at(5),
        inputCount: 3,
        title: 'Fix the bug',
      },
      { sessionId: 'ses_b', createdAt: at(0), lastActiveAt: at(1), inputCount: 1 },
    ]);
    expect(text).toContain('1. ');
    expect(text).toContain('3 次输入  Fix the bug  ses_a');
    expect(text).toContain('（无标题）  ses_b');
  });
});
