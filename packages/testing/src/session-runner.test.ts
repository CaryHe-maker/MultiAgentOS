import {
  MEDIA_TYPES,
  ReplyArgsSchema,
  RepositoryListInputSchema,
  newId,
  type ArtifactRef,
  type SessionLogRecord,
  type SubmitUnitRequestV1,
  type UnitReportV1,
} from '@multiagentos/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore } from '@multiagentos/persistence';
import {
  SessionLogStore,
  SessionRunner,
  type MainDefinitions,
  type MainUnit,
} from '@multiagentos/workflow';
import { describe, expect, it } from 'vitest';
import { createFakeSessionKernel, type FakeUnitScript } from './fakes/fake-session-kernel.js';

const digest = 'a'.repeat(64);
const artifact = (digit: string, mediaType: string): ArtifactRef => {
  const sha256 = digit.repeat(64);
  return { artifactId: `art_${sha256}`, sha256, size: 1, mediaType };
};
const packRef = artifact('1', MEDIA_TYPES.contextPack);
const modelRef = artifact('2', MEDIA_TYPES.modelOutput);
const unit = (id: string): MainUnit => ({
  ref: { kind: 'UNIT', id, version: 'v1.0.0', digest },
  failurePolicy: { NOT_FOUND: 'RETURN_TO_MODEL' },
});
const definitions: MainDefinitions = {
  label: 'main',
  limits: { maxRounds: 5, maxToolCallsPerRound: 4 },
  orient: unit('repository-orient'),
  contextAssemble: unit('context-assemble'),
  modelCall: unit('model-call'),
  messagePublish: unit('message-publish'),
  tools: [
    {
      modelName: 'list_files',
      unit: unit('repository-list'),
      parameters: RepositoryListInputSchema,
    },
  ],
  replyToolName: 'reply',
  replyParameters: ReplyArgsSchema,
};

type Ok = Extract<ReturnType<FakeUnitScript>, { output: unknown }>;
const modelReply = (toolName: string, args: unknown): Ok => ({
  output: {
    finishReason: 'TOOL_CALLS',
    toolCalls: [{ toolCallId: 'call_1', toolName, arguments: args }],
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
      case 'message-publish':
        return { output: { kind: 'REPLY' }, outputRef: artifact('5', MEDIA_TYPES.markdown) };
      case 'repository-list':
        return {
          output: { path: '.', directoryCount: 0, fileCount: 0, omittedEntries: 0 },
          outputRef: artifact('6', MEDIA_TYPES.fileText),
        };
      default:
        return { output: { kind: 'REPLY' }, outputRef: packRef };
    }
  };
}

function setup(replies: readonly Ok[]) {
  const persistence = new FileSessionStore(mkdtempSync(join(tmpdir(), 'mao-runner-')));
  const kernel = createFakeSessionKernel({ units: script(replies) });
  const runner = new SessionRunner({
    gateway: kernel.gateway,
    store: new SessionLogStore(persistence),
    definitions,
    agent: {
      ref: { kind: 'AGENT', id: 'main', version: 'v1.0.0', digest },
      modelRef: { id: 'deepseek-flash', version: 'v2.0.0' },
      effort: 'high',
      toolsDigest: digest,
    },
    definitionsDigest: digest,
    definitionVersions: ['main@v1.0.0'],
    config: {
      repeatedIntent: { warnAt: 3, stopAt: 5, window: 20 },
      consecutiveErrorLimit: 5,
      noProgressRounds: 2,
      regenerationLimit: 3,
    },
    runtime: () => ({ sandbox: 'none', currentDate: '2026-10-31' }),
    reportFault: (error) => {
      throw error;
    },
  });
  kernel.onWorkflow(async (envelope) => {
    if ('workflowRunId' in envelope) await runner.handleRunEvent(envelope);
    else if ('sessionId' in envelope) await runner.handleSessionEvent(envelope);
    else await runner.handleSystemEvent(envelope);
  });
  return { kernel, runner };
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
