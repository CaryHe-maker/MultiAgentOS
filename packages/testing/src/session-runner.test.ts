import {
  MEDIA_TYPES,
  AnalysisReportDraftSchema,
  HandoffBriefSchema,
  ReplyArgsSchema,
  RepositoryListInputSchema,
  newId,
  type ArtifactRef,
  type SessionLogRecord,
  type SubmitUnitRequestV1,
  type TemplateDefinition,
  type UnitReportV1,
} from '@multiagentos/contracts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore } from '@multiagentos/persistence';
import {
  SessionLogStore,
  SessionRunner,
  projectHistory,
  settleStaleRecords,
  type AgentDefinitions,
  type AgentUnit,
} from '@multiagentos/workflow';
import { describe, expect, it } from 'vitest';
import {
  createFakeSessionKernel,
  type FakeSessionKernelOptions,
  type FakeUnitScript,
} from './fakes/fake-session-kernel.js';

const digest = 'a'.repeat(64);
const artifact = (digit: string, mediaType: string): ArtifactRef => {
  const sha256 = digit.repeat(64);
  return { artifactId: `art_${sha256}`, sha256, size: 1, mediaType };
};
const packRef = artifact('1', MEDIA_TYPES.contextPack);
const modelRef = artifact('2', MEDIA_TYPES.modelOutput);
const unit = (id: string): AgentUnit => ({
  ref: { kind: 'UNIT', id, version: 'v1.0.0', digest },
  failurePolicy: { NOT_FOUND: 'RETURN_TO_MODEL' },
});
const definitions: AgentDefinitions = {
  label: 'main',
  limits: { maxRounds: 5, maxToolCallsPerRound: 4 },
  orient: unit('repository-orient'),
  contextAssemble: unit('context-assemble'),
  modelCall: unit('model-call'),
  publish: unit('message-publish'),
  tools: [
    {
      modelName: 'list_files',
      unit: unit('repository-list'),
      parameters: RepositoryListInputSchema,
    },
  ],
  endTools: [
    {
      toolName: 'reply',
      parameters: ReplyArgsSchema,
      allowedInFinal: true,
      action: 'PUBLISH_REPLY',
    },
  ],
  onDegraded: 'PUBLISH_NOTICE',
};

const binding = (id: string, agentDefinitions: AgentDefinitions) => ({
  ref: { kind: 'AGENT', id, version: 'v1.0.0', digest } as const,
  modelRef: { id: 'deepseek-flash', version: 'v2.0.0' },
  effort: 'none' as const,
  toolsDigest: digest,
  definitions: agentDefinitions,
});
const finishTool = {
  toolName: 'finish',
  parameters: AnalysisReportDraftSchema,
  allowedInFinal: true,
  action: 'PUBLISH_REPORT',
} as const;
const reporting: AgentDefinitions = {
  limits: definitions.limits,
  contextAssemble: definitions.contextAssemble,
  modelCall: definitions.modelCall,
  tools: definitions.tools,
  label: 'analysis',
  publish: unit('report-publish'),
  endTools: [finishTool],
  onDegraded: 'PUBLISH_REPORT',
};
const plannerDefinitions: AgentDefinitions = {
  ...reporting,
  endTools: [
    finishTool,
    {
      toolName: 'handoff',
      parameters: HandoffBriefSchema,
      allowedInFinal: false,
      action: 'HANDOFF',
    },
  ],
};
const viewerDefinitions = reporting;
const analyze: TemplateDefinition = {
  schemaVersion: 'v1',
  kind: 'TEMPLATE',
  id: 'analyze',
  version: 'v1.0.0',
  digest,
  description: 'analyze',
  origin: 'BUILTIN',
  nodes: [
    { name: 'plan', kind: 'AGENT', agent: { id: 'planner', version: 'v1.0.0' } },
    {
      name: 'view',
      kind: 'AGENT',
      agent: { id: 'code-viewer', version: 'v1.0.0' },
      dependsOn: [{ node: 'plan', when: { field: 'action', equals: 'HANDOFF' } }],
      inputFrom: 'HANDOFF',
      output: true,
    },
  ],
};

type Ok = Extract<ReturnType<FakeUnitScript>, { output: unknown }>;
const modelReply = (toolName: string, args: unknown, toolCallId = 'call_1'): Ok => ({
  output: {
    finishReason: 'TOOL_CALLS',
    toolCalls: [{ toolCallId, toolName, arguments: args }],
    hasText: false,
    hasReasoning: false,
  } as UnitReportV1 extends { output: infer O } ? O : never,
  outputRef: modelRef,
});

/** A scripted model: answers each model-call in turn, everything else succeeds. */
function script(replies: readonly Ok[]): FakeUnitScript {
  let model = 0;
  return (request: SubmitUnitRequestV1) => {
    switch (request.unitRef.id) {
      case 'model-call': {
        const reply = replies[Math.min(model, replies.length - 1)];
        model += 1;
        if (reply === undefined) throw new Error('no scripted reply');
        return reply;
      }
      case 'report-publish':
        return { output: { kind: 'REPLY' }, outputRef: artifact('7', MEDIA_TYPES.analysisReport) };
      case 'message-publish':
        return { output: { kind: 'REPLY' }, outputRef: artifact('5', MEDIA_TYPES.markdown) };
      case 'repository-list':
        return {
          output: { path: '.', directoryCount: 0, fileCount: 0, omittedEntries: 0 },
          outputRef: artifact('6', MEDIA_TYPES.fileText),
        };
      case 'context-assemble':
        return {
          output: {
            contextPackId: newId('ctx'),
            tokenCount: 1,
            tokenBudget: 10,
            prefixSha256: digest,
            projectionDigest: digest,
            headDigest: digest,
            elidedEntries: [],
          },
          outputRef: packRef,
        };
      default:
        return { output: { kind: 'REPLY' }, outputRef: packRef };
    }
  };
}

function setup(
  replies: readonly Ok[],
  units: FakeUnitScript = script(replies),
  projectFile?: FakeSessionKernelOptions['projectFile'],
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mao-runner-'));
  const persistence = new FileSessionStore(dataDir);
  const kernel = createFakeSessionKernel({
    units,
    ...(projectFile === undefined ? {} : { projectFile }),
  });
  const runner = new SessionRunner({
    gateway: kernel.gateway,
    store: new SessionLogStore(persistence),
    agents: new Map([
      ['main', binding('main', definitions)],
      ['planner', binding('planner', plannerDefinitions)],
      ['code-viewer', binding('code-viewer', viewerDefinitions)],
    ]),
    templates: new Map([['analyze', analyze]]),
    definitionsDigest: digest,
    definitionVersions: ['main@v1.0.0'],
    config: {
      repeatedIntent: { warnAt: 3, stopAt: 5, window: 20 },
      consecutiveErrorLimit: 5,
      noProgressRounds: 2,
      regenerationLimit: 3,
    },
    runtime: () => ({ sandbox: 'none', currentDate: '2026-10-31' }),
  });
  kernel.onWorkflow(async (envelope) => {
    if ('workflowRunId' in envelope) await runner.handleRunEvent(envelope);
    else if ('sessionId' in envelope) await runner.handleSessionEvent(envelope);
    else await runner.handleSystemEvent(envelope);
  });
  return { kernel, runner, dataDir };
}

const context = { correlationId: newId('cor'), tenantId: 'local', projectId: 'local' };
const prompt = () => ({ inputId: newId('inp'), text: 'hello' });
const begin = async (kernel: ReturnType<typeof createFakeSessionKernel>) => {
  await kernel.interaction.startSession(
    { requestId: newId('req'), mode: 'NEW', prompt: prompt() },
    context,
  );
  await kernel.idle();
};
const types = (records: readonly SessionLogRecord[]) => records.map((record) => record.type);
const count = (records: readonly SessionLogRecord[], type: string) =>
  records.filter((record) => record.type === type).length;

describe('a chat Turn', () => {
  it('replies, then asks for the next input', async () => {
    const { kernel, runner } = setup([modelReply('reply', { text: 'hi' })]);
    await begin(kernel);
    expect(types(runner.records)).toEqual(
      expect.arrayContaining([
        'HUMAN_ANSWERED',
        'TURN_STARTED',
        'AGENT_RUN_REGISTERED',
        'MODEL_TURN',
        'AGENT_RUN_ENDED',
      ]),
    );
    expect(kernel.interactionEvents.at(-1)?.event.type).toBe('HumanRequest');
    expect(
      runner.records.filter((r) => r.type === 'NODE_ENDED').map((r) => 'status' in r && r.status),
    ).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(count(runner.records, 'GRAPH_EXTENDED')).toBe(2);
    expect(count(runner.records, 'TURN_ENDED')).toBe(1);
  });

  it('keeps seq continuous and writes each record before the matching syscall', async () => {
    const { kernel, runner } = setup([modelReply('reply', { text: 'hi' })]);
    await begin(kernel);
    expect(runner.records.map((r) => r.seq)).toEqual(runner.records.map((_, index) => index + 1));
  });

  it('runs a tool round before replying', async () => {
    const { kernel, runner } = setup([
      modelReply('list_files', {}),
      modelReply('reply', { text: 'hi' }),
    ]);
    await begin(kernel);
    expect(count(runner.records, 'MODEL_TURN')).toBe(2);
    expect(
      runner.records.find((r) => r.type === 'UNIT_SUBMITTED' && r.inputSource.kind === 'TOOL_CALL'),
    ).toBeDefined();
  });

  it('does not touch the repository for a Turn that does not need it', async () => {
    const asked: string[] = [];
    const { kernel, runner } = setup([modelReply('reply', { text: 'hi' })], undefined, (path) => {
      asked.push(path);
      return { path, exists: false };
    });
    await begin(kernel);
    expect(count(runner.records, 'MODEL_TURN')).toBe(1);
    expect(asked).toEqual([]);
  });

  it('reads AGENTS.md after the first repository tool, behind its results', async () => {
    const asked: string[] = [];
    const replies = [
      modelReply('list_files', {}),
      modelReply('list_files', { path: 'src' }),
      modelReply('reply', { text: 'hi' }),
    ];
    const answers = script(replies);
    const assembled: SubmitUnitRequestV1[] = [];
    const { kernel, runner } = setup(
      replies,
      (request, index) => {
        if (request.unitRef.id === 'context-assemble') assembled.push(request);
        return answers(request, index);
      },
      (path) => {
        asked.push(path);
        return {
          path,
          exists: true,
          ref: artifact('8', MEDIA_TYPES.fileText),
          sha256: '8'.repeat(64),
          trusted: true,
        };
      },
    );
    await begin(kernel);
    expect(asked).toEqual(['AGENTS.md']);
    const order = types(runner.records);
    expect(order.indexOf('PROJECT_FILE_LOADED')).toBeGreaterThan(order.indexOf('UNIT_COMPLETED'));
    const second = assembled[1]?.input;
    if (second === undefined || !('history' in second)) throw new Error('no second assembly');
    expect(second.history.at(-1)).toMatchObject({ kind: 'PROJECT_INSTRUCTIONS', trusted: true });
    expect(second.history.at(-2)).toMatchObject({ kind: 'TOOL_RESULT' });
  });

  it('continues the conversation in the next Turn with the same history', async () => {
    const { kernel, runner } = setup([modelReply('reply', { text: 'hi' })]);
    await begin(kernel);
    const ask = kernel.interactionEvents.at(-1);
    if (ask?.event.type !== 'HumanRequest' || !('workflowRunId' in ask))
      throw new Error('no request');
    await kernel.interaction.answerHuman(
      {
        requestId: newId('req'),
        sessionId: ask.sessionId,
        workflowRunId: ask.workflowRunId,
        humanRequestId: ask.event.humanRequestId,
        input: prompt(),
      },
      context,
    );
    await kernel.idle();
    expect(count(runner.records, 'TURN_STARTED')).toBe(2);
    expect(count(runner.records, 'AGENT_RUN_REGISTERED')).toBe(2);
    expect(count(runner.records, 'UNIT_SUBMITTED') - count(runner.records, 'UNIT_COMPLETED')).toBe(
      0,
    );
    const orients = runner.records.filter(
      (r) => r.type === 'UNIT_SUBMITTED' && r.unitRef.id === 'repository-orient',
    );
    expect(orients).toHaveLength(1);
  });

  it('keeps the conversation going when main ends degraded', async () => {
    const { kernel, runner } = setup([
      {
        output: {
          finishReason: 'STOP',
          toolCalls: [],
          hasText: true,
          hasReasoning: false,
        } as never,
        outputRef: modelRef,
      },
    ]);
    await begin(kernel);
    expect(runner.records.some((r) => r.type === 'NODE_ENDED' && r.status === 'FAILED')).toBe(true);
    expect(kernel.interactionEvents.at(-1)?.event.type).toBe('HumanRequest');
  });
});

describe('Sessions', () => {
  it('lists the Session with its first prompt as the title', async () => {
    const { kernel } = setup([modelReply('reply', { text: 'hi' })]);
    await begin(kernel);
    await kernel.interaction.listSessions({ requestId: newId('req') }, context);
    await kernel.idle();
    expect(kernel.interactionEvents.at(-1)?.event).toMatchObject({
      type: 'SessionList',
      sessions: [{ turnCount: 1 }],
    });
  });
});

describe('analyze', () => {
  const start = async (kernel: ReturnType<typeof createFakeSessionKernel>) => {
    await kernel.interaction.startRun(
      { requestId: newId('req'), template: { id: 'analyze', version: 'v1.0.0' }, goal: prompt() },
      context,
    );
    await kernel.idle();
  };
  const nodeEnds = (records: readonly SessionLogRecord[]) =>
    records.flatMap((record) =>
      record.type === 'NODE_ENDED' ? [[record.status, record.skipReason]] : [],
    );
  const draft = { summary: 'the summary', conclusions: [], unconfirmed: [] };

  it('hands off from planner to code-viewer and closes with the report', async () => {
    const { kernel, runner } = setup([
      modelReply('handoff', { task: 'look', focusAreas: [], openQuestions: [] }),
      modelReply('finish', draft),
    ]);
    await start(kernel);
    expect(nodeEnds(runner.records)).toEqual([
      ['SUCCEEDED', undefined],
      ['SUCCEEDED', undefined],
      ['SUCCEEDED', undefined],
    ]);
    expect(count(runner.records, 'AGENT_RUN_REGISTERED')).toBe(2);
    expect(kernel.workflowEvents.at(-1)?.event).toMatchObject({
      type: 'RunClosed',
      closeReason: 'COMPLETED',
    });
    expect(JSON.stringify(runner.records)).not.toContain('the summary');
  });

  it('skips code-viewer when planner finishes by itself', async () => {
    const { kernel, runner } = setup([modelReply('finish', draft)]);
    await start(kernel);
    expect(nodeEnds(runner.records)).toEqual([
      ['SUCCEEDED', undefined],
      ['SUCCEEDED', undefined],
      ['SKIPPED', 'NOT_TAKEN'],
    ]);
  });

  it('names the goal by reference only', async () => {
    const seen: SubmitUnitRequestV1[] = [];
    const replies = script([modelReply('finish', draft)]);
    const { kernel } = setup([modelReply('finish', draft)], (request, index) => {
      seen.push(request);
      return replies(request, index);
    });
    await start(kernel);
    const publish = seen.find((request) => request.unitRef.id === 'report-publish');
    expect(publish?.input).toMatchObject({ goalRef: { mediaType: MEDIA_TYPES.fileText } });
    expect(JSON.stringify(publish?.input)).not.toContain('"goal"');
  });
});

describe('an interrupted process', () => {
  const tool = modelReply('list_files', {}, 'tool_call');
  const reply = modelReply('reply', { text: 'done' }, 'reply_call');
  const stamped = (records: readonly SessionLogRecord[]): SessionLogRecord[] => {
    const settled = settleStaleRecords(records).map((record, index) => ({
      ...record,
      seq: records.length + index + 1,
      at: '2026-10-31T00:00:00.000Z',
    }));
    return [...records, ...settled];
  };

  it('leaves a valid history at every point it could stop', async () => {
    const { kernel, runner } = setup([tool, reply]);
    await begin(kernel);
    for (let length = 1; length <= runner.records.length; length += 1) {
      const records = stamped(runner.records.slice(0, length));
      const entries = projectHistory(records, { kind: 'MAIN' });
      const answers = new Set(
        entries.flatMap((entry) =>
          (entry.kind === 'TOOL_RESULT' || entry.kind === 'FEEDBACK') &&
          entry.toolCallId !== undefined
            ? [entry.toolCallId]
            : [],
        ),
      );
      const calls = records.flatMap((record) =>
        record.type === 'MODEL_TURN' ? record.toolCalls.map((call) => call.toolCallId) : [],
      );
      for (const call of calls) expect(answers.has(call), `prefix ${String(length)}`).toBe(true);
      expect(settleStaleRecords(records)).toEqual([]);
    }
  });

  it('keeps everything that finished, and starts a new AgentRun on the next prompt', async () => {
    const seen: SubmitUnitRequestV1[] = [];
    const replies = script([tool, reply, modelReply('reply', { text: 'again' })]);
    const units: FakeUnitScript = (request, index) => {
      seen.push(request);
      return replies(request, index);
    };
    const { kernel, runner, dataDir } = setup([], units);
    await begin(kernel);
    const opened = kernel.workflowEvents.find((event) => 'workflowRunId' in event);
    if (opened === undefined || !('workflowRunId' in opened)) throw new Error('no run');
    const { sessionId } = opened;

    // The process stops right after the second model turn asked to reply.
    const file = join(dataDir, 'sessions', sessionId, 'workflow', 'log.v1.jsonl');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    const secondTurn = lines.reduce<number[]>(
      (found, line, index) => (line.includes('"type":"MODEL_TURN"') ? [...found, index] : found),
      [],
    )[1];
    if (secondTurn === undefined) throw new Error('no second model turn');
    writeFileSync(file, `${lines.slice(0, secondTurn + 1).join('\n')}\n`);
    const firstAgentRun = runner.records.find((r) => r.type === 'AGENT_RUN_REGISTERED');

    await runner.handleSessionEvent({
      eventId: newId('evt'),
      sessionId,
      seq: 99,
      occurredAt: '2026-10-31T00:00:00.000Z',
      event: { type: 'SessionCommand', commandId: newId('scm'), command: 'CLOSE' },
    });
    await kernel.interaction.openSession({ requestId: newId('req'), sessionId }, context);
    await kernel.idle();

    const types_ = types(runner.records);
    expect(types_).toContain('STALE_UNITS_SETTLED');
    const interrupted = runner.records.find((r) => r.type === 'AGENT_RUN_ENDED');
    expect(interrupted).toMatchObject({ outcome: 'INTERRUPTED' });
    // The finished tool result survived, and the unfinished reply got an answer.
    const history = projectHistory(runner.records, { kind: 'MAIN' });
    expect(
      history.filter((entry) => entry.kind === 'TOOL_RESULT' && entry.status === 'OK'),
    ).toHaveLength(1);
    expect(history.filter((entry) => entry.kind === 'FEEDBACK')).toHaveLength(1);

    const ask = kernel.interactionEvents.at(-1);
    if (ask?.event.type !== 'HumanRequest' || !('workflowRunId' in ask))
      throw new Error('no prompt');
    const before = seen.length;
    await kernel.interaction.answerHuman(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId: ask.workflowRunId,
        humanRequestId: ask.event.humanRequestId,
        input: prompt(),
      },
      context,
    );
    await kernel.idle();
    const registered = runner.records.filter((r) => r.type === 'AGENT_RUN_REGISTERED');
    expect(registered).toHaveLength(2);
    expect(registered[1]?.type === 'AGENT_RUN_REGISTERED' && registered[1].agentRunId).not.toBe(
      firstAgentRun?.type === 'AGENT_RUN_REGISTERED' && firstAgentRun.agentRunId,
    );
    expect(
      seen.slice(before).filter((request) => request.unitRef.id === 'repository-list'),
    ).toEqual([]);
  });
});
