import {
  AskUserArgsSchema,
  MEDIA_TYPES,
  ReplyArgsSchema,
  UpdateTodosArgsSchema,
  newId,
  type ArtifactRef,
  type SessionLogRecord,
  type SubmitUnitRequest,
  type UnitReport,
} from '@multiagentos/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore } from '@multiagentos/persistence';
import {
  SessionLogStore,
  SessionRunner,
  type AgentDefinitions,
  type AgentUnit,
} from '@multiagentos/workflow';
import { describe, expect, it } from 'vitest';
import { createFakeSessionKernel, type FakeUnitScript } from './fakes/fake-session-kernel.js';

/**
 * What a user does to a run while it goes on (M2Design 4.3-4.5, 3.4), through the real runner and
 * a stand-in Kernel: pausing and continuing, a note slipped in, a question that the agent waits on,
 * and an abort. Whatever the interface does here is also what the log must say afterwards.
 */
const digest = 'a'.repeat(64);
const artifact = (digit: string, mediaType: string): ArtifactRef => {
  const sha256 = digit.repeat(64);
  return { artifactId: `art_${sha256}`, sha256, size: 1, mediaType };
};
const packRef = artifact('1', MEDIA_TYPES.contextPack);
const modelRef = artifact('2', MEDIA_TYPES.modelOutput);
const unit = (id: string): AgentUnit => ({
  ref: { kind: 'UNIT', id, version: 'v1.0.0', digest },
  failurePolicy: {},
});
const main: AgentDefinitions = {
  label: 'main',
  limits: { maxRounds: 8, maxToolCallsPerRound: 4 },
  contextAssemble: unit('context-assemble'),
  modelCall: unit('model-call'),
  publish: unit('message-publish'),
  tools: [],
  endTools: [
    {
      toolName: 'reply',
      parameters: ReplyArgsSchema,
      allowedInFinal: true,
      action: 'PUBLISH_REPLY',
    },
  ],
  onDegraded: 'PUBLISH_NOTICE',
  todoTool: { toolName: 'update_todos', parameters: UpdateTodosArgsSchema },
  askTool: { toolName: 'ask_user', parameters: AskUserArgsSchema },
};

type Call = { toolName: string; args: unknown };
const model = (...calls: Call[]) => ({
  output: {
    finishReason: 'TOOL_CALLS',
    toolCalls: calls.map((call, index) => ({
      toolCallId: `call_${String(index + 1)}`,
      toolName: call.toolName,
      arguments: call.args,
    })),
    hasText: false,
    hasReasoning: false,
  } as UnitReport extends { output: infer O } ? O : never,
  outputRef: modelRef,
});
const reply = () => model({ toolName: 'reply', args: { text: 'done' } });
const todos = () =>
  model({
    toolName: 'update_todos',
    args: { todos: [{ content: 'think', status: 'in_progress' }] },
  });

const context = { correlationId: newId('cor'), tenantId: 'local', projectId: 'local' };
const ofType = <T extends SessionLogRecord['type']>(
  records: readonly SessionLogRecord[],
  type: T,
): Extract<SessionLogRecord, { type: T }>[] =>
  records.filter(
    (record): record is Extract<SessionLogRecord, { type: T }> => record.type === type,
  );

/**
 * The model replies are a queue; `during` runs when the Unit with that id of that round is
 * delivered, which is how a test does something to the run "while it works".
 */
function setup(
  replies: readonly ReturnType<typeof model>[],
  during: (unitId: string, round: number) => void = () => undefined,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mao-pause-'));
  const queue = [...replies];
  const assembled: SubmitUnitRequest[] = [];
  const units: FakeUnitScript = (request) => {
    switch (request.unitRef.id) {
      case 'model-call': {
        during('model-call', assembled.length);
        const next = queue.shift();
        if (next === undefined) throw new Error('no scripted reply');
        return next;
      }
      case 'message-publish':
        return { output: { kind: 'REPLY' }, outputRef: artifact('5', MEDIA_TYPES.markdown) };
      case 'context-assemble':
        assembled.push(request);
        during('context-assemble', assembled.length);
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
  const kernel = createFakeSessionKernel({ units });
  const runner = new SessionRunner({
    gateway: kernel.gateway,
    store: new SessionLogStore(new FileSessionStore(dataDir)),
    agents: new Map([
      [
        'main',
        {
          ref: { kind: 'AGENT', id: 'main', version: 'v1.0.0', digest } as const,
          modelRef: { id: 'deepseek-flash', version: 'v2.0.0' },
          effort: 'high' as const,
          allowedEfforts: ['high' as const],
          requestedCapabilities: ['repo.read' as const],
          writeRoots: [],
          toolsDigest: digest,
          definitions: main,
        },
      ],
    ]),
    templates: new Map(),
    definitionsDigest: digest,
    definitionVersions: ['main@v1.0.0'],
    config: {
      repeatedIntent: { warnAt: 3, stopAt: 5, window: 20 },
      maxNestedInstructions: 8,
      maxSubagentsPerCall: 4,
      maxDependencyDepth: 2,
      maxTasks: 12,
      maxSpawnCalls: 4,
      consecutiveErrorLimit: 5,
      noProgressRounds: 2,
      regenerationLimit: 3,
    },
    runtime: () => ({ sandbox: 'none', currentDate: '2026-11-06' }),
  });
  kernel.onWorkflow(async (envelope) => {
    if ('workflowRunId' in envelope) await runner.handleRunEvent(envelope);
    else if ('sessionId' in envelope) await runner.handleSessionEvent(envelope);
    else await runner.handleSystemEvent(envelope);
  });
  return { kernel, runner, assembled };
}

const begin = async (kernel: ReturnType<typeof createFakeSessionKernel>) => {
  await kernel.interaction.startSession(
    { requestId: newId('req'), mode: 'NEW', prompt: { inputId: newId('inp'), text: 'go' } },
    context,
  );
  await kernel.idle();
};
const ids = (kernel: ReturnType<typeof createFakeSessionKernel>) => {
  const started = kernel.workflowEvents.find(
    (event) => 'workflowRunId' in event && event.event.type === 'RunStart',
  );
  if (started === undefined || !('workflowRunId' in started)) throw new Error('no run');
  return { sessionId: started.sessionId, workflowRunId: started.workflowRunId };
};
const textOf = async (
  kernel: ReturnType<typeof createFakeSessionKernel>,
  ref: ArtifactRef,
): Promise<string> => {
  const content = await kernel.interaction.readArtifact(
    { requestId: newId('req'), sessionId: ids(kernel).sessionId, ref },
    context,
  );
  if (content.outcome !== 'ACCEPTED' || !('text' in content)) throw new Error('unreadable');
  return content.text;
};
const humanTexts = async (
  kernel: ReturnType<typeof createFakeSessionKernel>,
  request: SubmitUnitRequest | undefined,
): Promise<string[]> => {
  const history = (request?.input as { history: { kind: string; contentRef?: ArtifactRef }[] })
    .history;
  const out: string[] = [];
  for (const entry of history)
    if (entry.kind === 'HUMAN' && entry.contentRef !== undefined)
      out.push(await textOf(kernel, entry.contentRef));
  return out;
};

describe('ask_user', () => {
  it('waits for the answer without submitting a Unit, and reads the answer as the call result', async () => {
    const { kernel, runner, assembled } = setup([
      model({ toolName: 'ask_user', args: { kind: 'ask', question: 'which one?' } }),
      reply(),
    ]);
    await begin(kernel);
    const request = kernel.interactionEvents.find(
      (event) =>
        'event' in event && event.event.type === 'HumanRequest' && event.event.kind === 'ask',
    );
    if (request === undefined || !('event' in request) || request.event.type !== 'HumanRequest')
      throw new Error('no question was asked');
    expect(request.event).toMatchObject({ kind: 'ask', question: 'which one?' });
    // The caller's node waits, and its AgentRun submitted nothing since the call.
    const { workflowRunId } = ids(kernel);
    const callAt = runner.records.findIndex(
      (record) => record.type === 'GRAPH_EXTENDED' && record.source === 'ASK',
    );
    expect(callAt).toBeGreaterThan(0);
    expect(ofType(runner.records.slice(callAt), 'UNIT_SUBMITTED')).toEqual([]);
    expect(ofType(runner.records, 'NODE_RESUMED')).toEqual([]);

    const answer = { inputId: newId('inp'), text: 'the first' };
    expect(
      await kernel.interaction.answerHuman(
        {
          requestId: newId('req'),
          sessionId: ids(kernel).sessionId,
          workflowRunId,
          humanRequestId: request.event.humanRequestId,
          input: answer,
        },
        context,
      ),
    ).toMatchObject({ outcome: 'ACCEPTED' });
    await kernel.idle();
    expect(ofType(runner.records, 'HUMAN_ANSWERED').at(-1)).toMatchObject({
      kind: 'ask',
      origin: 'requested',
    });
    expect(ofType(runner.records, 'NODE_RESUMED')).toHaveLength(1);
    // The next assembly holds the answer as the result of the call.
    const entry = (
      assembled.at(-1)?.input as { history: { kind: string; toolCallId?: string }[] }
    ).history.find((each) => each.kind === 'HUMAN_ANSWER');
    expect(entry).toMatchObject({ kind: 'HUMAN_ANSWER', toolCallId: 'call_1', question: 'ask' });
    expect(ofType(runner.records, 'AGENT_RUN_ENDED')[0]).toMatchObject({ outcome: 'CLOSED' });
  });

  it('sends a review without an artifact back, and the agent goes on', async () => {
    const { kernel, runner } = setup([
      model({ toolName: 'ask_user', args: { kind: 'review', question: 'ok?' } }),
      reply(),
    ]);
    await begin(kernel);
    expect(
      ofType(runner.records, 'FEEDBACK').find((record) => record.code === 'INVALID_ACTION'),
    ).toMatchObject({ toolCallId: 'call_1' });
    expect(ofType(runner.records, 'GRAPH_EXTENDED').map((record) => record.source)).not.toContain(
      'ASK',
    );
    expect(ofType(runner.records, 'AGENT_RUN_ENDED')[0]).toMatchObject({ outcome: 'CLOSED' });
  });
});

describe('steer', () => {
  it('gives a note slipped in to the next assembly of its target, and nothing else changes', async () => {
    let said = false;
    const ref: { kernel?: ReturnType<typeof createFakeSessionKernel> } = {};
    const { kernel, assembled, runner } = setup([todos(), reply()], (unitId, round) => {
      if (unitId !== 'context-assemble' || round !== 1 || said || ref.kernel === undefined) return;
      said = true;
      void ref.kernel.interaction.steerRun(
        {
          requestId: newId('req'),
          ...ids(ref.kernel),
          input: { inputId: newId('inp'), text: 'look at b.ts too' },
        },
        context,
      );
    });
    ref.kernel = kernel;
    await begin(kernel);
    expect(said).toBe(true);
    const answered = ofType(runner.records, 'HUMAN_ANSWERED').filter(
      (record) => record.kind === 'steer',
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ origin: 'unrequested' });
    expect(answered[0]?.attachedAgentRunId).toBeDefined();
    // Not in the assembly that was already out, in the next one, and after the first prompt.
    expect(await humanTexts(kernel, assembled[0])).toEqual(['go']);
    expect(await humanTexts(kernel, assembled[1])).toEqual(['go', 'look at b.ts too']);
    expect(ofType(runner.records, 'AGENT_RUN_ENDED')[0]).toMatchObject({ outcome: 'CLOSED' });
  });
});

describe('pause and continue', () => {
  it('holds what a pause cancelled and goes on with the note that came with the continuation', async () => {
    let paused = false;
    const ref: { kernel?: ReturnType<typeof createFakeSessionKernel> } = {};
    const { kernel, assembled, runner } = setup([reply()], (unitId, round) => {
      if (unitId !== 'context-assemble' || round !== 1 || paused || ref.kernel === undefined)
        return;
      paused = true;
      void ref.kernel.interaction.pauseRun(
        { requestId: newId('req'), ...ids(ref.kernel) },
        context,
      );
    });
    ref.kernel = kernel;
    await begin(kernel);
    // The assembly that a pause cancelled is held: no model call, no round spent.
    expect(ofType(runner.records, 'UNIT_INTERRUPTED')).toMatchObject([{ reason: 'PAUSED' }]);
    expect(ofType(runner.records, 'RUN_PAUSED')).toHaveLength(1);
    expect(assembled).toHaveLength(1);
    expect(ofType(runner.records, 'AGENT_RUN_ENDED')).toEqual([]);

    const note = { inputId: newId('inp'), text: 'use the other way' };
    expect(
      await kernel.interaction.resumeRun(
        { requestId: newId('req'), ...ids(kernel), steer: { input: note } },
        context,
      ),
    ).toMatchObject({ outcome: 'ACCEPTED' });
    await kernel.idle();
    expect(ofType(runner.records, 'RUN_RESUMED')).toMatchObject([{ steerInputId: note.inputId }]);
    // Assembled again from the log as it is now: the note is in it.
    expect(assembled).toHaveLength(2);
    expect(await humanTexts(kernel, assembled[1])).toEqual(['go', 'use the other way']);
    expect(ofType(runner.records, 'AGENT_RUN_ENDED')[0]).toMatchObject({ outcome: 'CLOSED' });
    // Nothing a pause did counted as a failure.
    expect(ofType(runner.records, 'MODEL_ATTEMPT_FAILED')).toEqual([]);
  });
});

describe('abort', () => {
  it('ends the Turn and goes on with the conversation, with the node and the run recorded as interrupted', async () => {
    let aborted = false;
    const ref: { kernel?: ReturnType<typeof createFakeSessionKernel> } = {};
    const { kernel, runner } = setup([todos(), reply()], (unitId) => {
      if (unitId !== 'model-call' || aborted || ref.kernel === undefined) return;
      aborted = true;
      void ref.kernel.interaction.interruptRun(
        { requestId: newId('req'), ...ids(ref.kernel) },
        context,
      );
    });
    ref.kernel = kernel;
    await begin(kernel);
    expect(ofType(runner.records, 'RUN_INTERRUPTED')).toMatchObject([{ reason: 'USER_ABORT' }]);
    expect(
      ofType(runner.records, 'NODE_ENDED').find((record) => record.status === 'INTERRUPTED'),
    ).toBeDefined();
    expect(ofType(runner.records, 'TURN_ENDED')).toMatchObject([{ reason: 'ABORTED' }]);
    // The run stays open for the next message, which asks for open input again.
    expect(ofType(runner.records, 'WORKFLOW_RUN_ENDED')).toEqual([]);
    const next = ofType(runner.records, 'HUMAN_REQUESTED').at(-1);
    expect(next).toMatchObject({ kind: 'prompt' });
    await kernel.interaction.answerHuman(
      {
        requestId: newId('req'),
        ...ids(kernel),
        humanRequestId: next?.humanRequestId ?? '',
        input: { inputId: newId('inp'), text: 'again' },
      },
      context,
    );
    await kernel.idle();
    expect(ofType(runner.records, 'TURN_STARTED')).toHaveLength(2);
    expect(ofType(runner.records, 'AGENT_RUN_ENDED').at(-1)).toMatchObject({ outcome: 'CLOSED' });
  });
});
