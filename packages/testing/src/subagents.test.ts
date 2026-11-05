import {
  ExplorerResultSchema,
  MEDIA_TYPES,
  ReplyArgsSchema,
  RepositoryListInputSchema,
  RunSubagentsArgsSchema,
  WorkerResultSchema,
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
const common = {
  limits: { maxRounds: 8, maxToolCallsPerRound: 4 },
  contextAssemble: unit('context-assemble'),
  modelCall: unit('model-call'),
};

const main: AgentDefinitions = {
  ...common,
  label: 'main',
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
  spawnTool: { toolName: 'run_subagents', parameters: RunSubagentsArgsSchema },
};
const explorer: AgentDefinitions = {
  ...common,
  label: 'explorer',
  tools: [],
  endTools: [
    {
      toolName: 'finish_subagent',
      parameters: ExplorerResultSchema,
      allowedInFinal: true,
      action: 'FINISH_SUBAGENT',
    },
  ],
  onDegraded: 'RETURN_PARTIAL',
};
const worker: AgentDefinitions = {
  ...common,
  label: 'worker',
  tools: [
    {
      modelName: 'write_file',
      executionKind: 'FILE_WRITE',
      unit: unit('file-write'),
      parameters: RepositoryListInputSchema,
    },
    {
      modelName: 'run_command',
      executionKind: 'COMMAND',
      unit: unit('run-command'),
      parameters: RepositoryListInputSchema,
    },
  ],
  endTools: [
    {
      toolName: 'finish_subagent',
      parameters: WorkerResultSchema,
      allowedInFinal: true,
      action: 'FINISH_SUBAGENT',
    },
  ],
  onDegraded: 'RETURN_PARTIAL',
};

const binding = (
  id: string,
  definitions: AgentDefinitions,
  capabilities: readonly ('repo.read' | 'workspace.write' | 'agent.spawn' | 'command.exec')[],
  efforts: readonly ('none' | 'low' | 'high' | 'max')[],
) => ({
  ref: { kind: 'AGENT', id, version: 'v1.0.0', digest } as const,
  modelRef: { id: 'deepseek-flash', version: 'v2.0.0' },
  effort: efforts[0] ?? ('none' as const),
  allowedEfforts: efforts,
  requestedCapabilities: capabilities,
  writeRoots: capabilities.includes('workspace.write') ? ['.'] : [],
  toolsDigest: digest,
  definitions,
});

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

const explorerResult = { summary: 'found it', findings: [] };
const workerResult = (extra: object = {}) => ({
  summary: 'changed',
  changedFiles: ['src/a.ts'],
  status: 'done',
  validation: [],
  ...extra,
});

/** One queue of model replies per Agent; every other Unit succeeds. */
function setup(replies: Record<string, readonly ReturnType<typeof model>[]>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mao-subagents-'));
  const queues = new Map(Object.entries(replies).map(([id, list]) => [id, [...list]]));
  const assembled: SubmitUnitRequest[] = [];
  let records: () => readonly SessionLogRecord[] = () => [];
  const agentOf = (agentRunId: string): string => {
    const registered = records().find(
      (record) => record.type === 'AGENT_RUN_REGISTERED' && record.agentRunId === agentRunId,
    );
    return registered?.type === 'AGENT_RUN_REGISTERED' ? registered.agentRef.id : 'unknown';
  };
  const units: FakeUnitScript = (request) => {
    switch (request.unitRef.id) {
      case 'model-call': {
        const next = queues.get(agentOf(request.agentRunId))?.shift();
        if (next === undefined)
          throw new Error(`no scripted reply for ${agentOf(request.agentRunId)}`);
        return next;
      }
      case 'message-publish':
        return { output: { kind: 'REPLY' }, outputRef: artifact('5', MEDIA_TYPES.markdown) };
      case 'file-write':
        return {
          output: { path: 'src/a.ts', operation: 'CREATED', sha256: 'c'.repeat(64) },
          outputRef: artifact('6', MEDIA_TYPES.fileText),
          executionKind: 'FILE_WRITE',
          changedFiles: ['src/a.ts'],
        };
      case 'run-command':
        return {
          output: {
            exitCode: 0,
            signal: null,
            timedOut: false,
            backend: 'BWRAP',
            sandboxDenials: 0,
          },
          outputRef: artifact('6', MEDIA_TYPES.fileText),
          executionKind: 'COMMAND',
        };
      case 'context-assemble':
        assembled.push(request);
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
        binding('main', main, ['repo.read', 'workspace.write', 'agent.spawn'], ['high', 'none']),
      ],
      ['explorer', binding('explorer', explorer, ['repo.read'], ['none', 'low'])],
      [
        'worker',
        binding(
          'worker',
          worker,
          ['repo.read', 'workspace.write', 'command.exec'],
          ['high', 'low'],
        ),
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
    runtime: () => ({ sandbox: 'none', currentDate: '2026-11-05' }),
  });
  records = () => runner.records;
  kernel.onWorkflow(async (envelope) => {
    if ('workflowRunId' in envelope) await runner.handleRunEvent(envelope);
    else if ('sessionId' in envelope) await runner.handleSessionEvent(envelope);
    else await runner.handleSystemEvent(envelope);
  });
  return { kernel, runner, assembled };
}

const context = { correlationId: newId('cor'), tenantId: 'local', projectId: 'local' };
const begin = async (kernel: ReturnType<typeof createFakeSessionKernel>) => {
  await kernel.interaction.startSession(
    { requestId: newId('req'), mode: 'NEW', prompt: { inputId: newId('inp'), text: 'go' } },
    context,
  );
  await kernel.idle();
};
const ofType = <T extends SessionLogRecord['type']>(
  records: readonly SessionLogRecord[],
  type: T,
): Extract<SessionLogRecord, { type: T }>[] =>
  records.filter(
    (record): record is Extract<SessionLogRecord, { type: T }> => record.type === type,
  );

describe('run_subagents', () => {
  it('starts the tasks, joins their results in the written order, and the caller goes on', async () => {
    const { kernel, runner, assembled } = setup({
      main: [
        model({
          toolName: 'run_subagents',
          args: {
            tasks: [
              { name: 'survey', agent: 'explorer', goal: 'look around' },
              { name: 'check', agent: 'explorer', goal: 'check it', dependsOn: ['survey'] },
            ],
          },
        }),
        model({ toolName: 'reply', args: { text: 'done' } }),
      ],
      explorer: [
        model({ toolName: 'finish_subagent', args: explorerResult }),
        model({ toolName: 'finish_subagent', args: explorerResult }),
      ],
    });
    await begin(kernel);
    const { records } = runner;
    const registered = ofType(records, 'AGENT_RUN_REGISTERED');
    const main = registered.find((record) => record.agentRef.id === 'main');
    const children = registered.filter((record) => record.agentRef.id === 'explorer');
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.parentAgentRunId === main?.agentRunId)).toBe(true);
    // The second task started only after the first had ended.
    const firstEnd = records.findIndex(
      (record) =>
        record.type === 'AGENT_RUN_ENDED' && record.agentRunId === children[0]?.agentRunId,
    );
    const secondStart = records.findIndex(
      (record) =>
        record.type === 'AGENT_RUN_REGISTERED' && record.agentRunId === children[1]?.agentRunId,
    );
    expect(secondStart).toBeGreaterThan(firstEnd);
    expect(ofType(records, 'GRAPH_EXTENDED').map((record) => record.source)).toContain('SPAWN');
    const [joined] = ofType(records, 'SUBAGENTS_JOINED');
    expect(joined?.results.map((result) => [result.name, result.status])).toEqual([
      ['survey', 'DONE'],
      ['check', 'DONE'],
    ]);
    expect(
      ofType(records, 'MODEL_TURN').filter((turn) => turn.agentRunId === main?.agentRunId),
    ).toHaveLength(2);
    expect(kernel.interactionEvents.at(-1)?.event.type).toBe('HumanRequest');
    // The task that waits sees its own task and the result of the one before it, not the prompt.
    const history = (request: SubmitUnitRequest | undefined) =>
      (request?.input as { history: { kind: string; name?: string }[] }).history;
    const checkAssembly = assembled.find(
      (request) => request.agentRunId === children[1]?.agentRunId,
    );
    expect(history(checkAssembly).map((entry) => [entry.kind, entry.name])).toEqual(
      expect.arrayContaining([
        ['TASK', 'check'],
        ['SUBAGENT_RESULT', 'survey'],
      ]),
    );
    expect(history(checkAssembly).some((entry) => entry.kind === 'HUMAN')).toBe(false);
  });

  it('refuses a call that breaks a rule, answers it, and takes the tool away after two', async () => {
    const overlap = {
      tasks: [
        { name: 'one', agent: 'worker', goal: 'x', writeScope: ['src'] },
        { name: 'two', agent: 'worker', goal: 'y', writeScope: ['src/api'] },
      ],
    };
    const { kernel, runner, assembled } = setup({
      main: [
        model({ toolName: 'run_subagents', args: overlap }),
        model({ toolName: 'run_subagents', args: overlap }),
        model({ toolName: 'reply', args: { text: 'by myself' } }),
      ],
    });
    await begin(kernel);
    const { records } = runner;
    expect(ofType(records, 'AGENT_RUN_REGISTERED').map((record) => record.agentRef.id)).toEqual([
      'main',
    ]);
    const answers = ofType(records, 'FEEDBACK').filter(
      (record) => record.code === 'INVALID_ACTION',
    );
    expect(answers).toHaveLength(2);
    expect(answers[0]?.message).toContain('WRITE_SCOPE_OVERLAP');
    expect(answers[1]?.message).toContain('no longer available');
    const withdrawn = assembled.map(
      (request) => (request.input as { withdrawnTools?: string[] }).withdrawnTools,
    );
    expect(withdrawn).toEqual([undefined, undefined, ['run_subagents']]);
    // Two refused calls are not two rounds without progress: the run was not forced to wrap up.
    expect(ofType(records, 'AGENT_WRAP_UP')).toHaveLength(0);
  });

  it('accepts a worker only after it checked what it changed, and notes what it did not report', async () => {
    const { kernel, runner } = setup({
      main: [
        model({
          toolName: 'run_subagents',
          args: {
            tasks: [
              {
                name: 'fix',
                agent: 'worker',
                goal: 'fix it',
                writeScope: ['src'],
                acceptance: ['it builds'],
              },
            ],
          },
        }),
        model({ toolName: 'reply', args: { text: 'done' } }),
      ],
      worker: [
        model({ toolName: 'write_file', args: { path: 'src/a.ts' } }),
        model({
          toolName: 'finish_subagent',
          args: workerResult({ acceptance: [{ index: 0, verdict: 'met' }] }),
        }),
        model({ toolName: 'run_command', args: {} }),
        model({
          toolName: 'finish_subagent',
          args: workerResult({ changedFiles: [], acceptance: [{ index: 0, verdict: 'not_met' }] }),
        }),
      ],
    });
    await begin(kernel);
    const { records } = runner;
    expect(
      ofType(records, 'FEEDBACK')
        .filter((record) => record.code === 'NOT_VERIFIED')
        .map((record) => record.code),
    ).toEqual(['NOT_VERIFIED']);
    const [joined] = ofType(records, 'SUBAGENTS_JOINED');
    expect(joined?.results[0]?.status).toBe('DONE');
    expect(joined?.results[0]?.notes).toEqual([
      'criterion 0 not_met: it builds',
      'changed but not reported: src/a.ts',
    ]);
  });

  it('sends back a result that leaves a criterion unanswered', async () => {
    const { kernel, runner } = setup({
      main: [
        model({
          toolName: 'run_subagents',
          args: {
            tasks: [{ name: 'look', agent: 'explorer', goal: 'x', acceptance: ['a', 'b'] }],
          },
        }),
        model({ toolName: 'reply', args: { text: 'ok' } }),
      ],
      explorer: [
        model({
          toolName: 'finish_subagent',
          args: { ...explorerResult, acceptance: [{ index: 0, verdict: 'met' }] },
        }),
        model({
          toolName: 'finish_subagent',
          args: {
            ...explorerResult,
            acceptance: [
              { index: 0, verdict: 'met' },
              { index: 1, verdict: 'unknown' },
            ],
          },
        }),
      ],
    });
    await begin(kernel);
    const { records } = runner;
    expect(ofType(records, 'FEEDBACK').map((record) => record.code)).toContain('RESULT_INCOMPLETE');
    expect(ofType(records, 'SUBAGENTS_JOINED')[0]?.results[0]?.notes).toEqual([
      'criterion 1 unknown: b',
    ]);
  });
});

describe('the length of a result', () => {
  it('sends back a result that is longer than the caller reads, once it is short enough accepts it', async () => {
    const { kernel, runner } = setup({
      main: [
        model({
          toolName: 'run_subagents',
          args: { tasks: [{ name: 'look', agent: 'explorer', goal: 'x' }] },
        }),
        model({ toolName: 'reply', args: { text: 'ok' } }),
      ],
      explorer: [
        model({
          toolName: 'finish_subagent',
          args: {
            summary: 'x'.repeat(3900),
            findings: [
              { claim: 'y'.repeat(900), evidence: [] },
              { claim: 'z'.repeat(900), evidence: [] },
              { claim: 'w'.repeat(900), evidence: [] },
              { claim: 'v'.repeat(900), evidence: [] },
              { claim: 'u'.repeat(900), evidence: [] },
            ],
          },
        }),
        model({ toolName: 'finish_subagent', args: explorerResult }),
      ],
    });
    await begin(kernel);
    const { records } = runner;
    expect(ofType(records, 'FEEDBACK').map((record) => record.code)).toContain('RESULT_TOO_LONG');
    expect(ofType(records, 'SUBAGENTS_JOINED')[0]?.results[0]?.status).toBe('DONE');
  });
});
