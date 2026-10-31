import { newId, type ArtifactRef, type SessionLogRecord } from '@multiagentos/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { projectInstructions, projectMainHistory } from './main-projection.js';

const at = '2026-10-31T00:00:00.000Z';
const ref = (digit: string): ArtifactRef => {
  const sha256 = digit.repeat(64);
  return { artifactId: `art_${sha256}`, sha256, size: 1, mediaType: 'text/plain' };
};
const budget = { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' } as const;
const run = newId('wfr');
const secondRun = newId('wfr');
const turn = newId('trn');
const secondTurn = newId('trn');
const mainRun = newId('agr');
const viewerRun = newId('agr');
const digest = 'a'.repeat(64);
const unitRef = { kind: 'UNIT', id: 'file-read', version: 'v1.0.0', digest } as const;
const agentRef = (id: string) => ({ kind: 'AGENT', id, version: 'v1.0.0', digest }) as const;

const stamped = (entries: readonly object[]): SessionLogRecord[] =>
  entries.map(
    (entry, index) => ({ workflowRunId: run, at, ...entry, seq: index + 1 }) as SessionLogRecord,
  );
const submitted = (requestId: string, agentRunId: string, toolCallId: string, turnId = turn) => ({
  type: 'UNIT_SUBMITTED',
  turnId,
  requestId,
  path: 'agr_abcdef/round-1/1#1',
  agentRunId,
  unitRunId: `unr_${'b'.repeat(32)}`,
  unitRef,
  inputSource: { kind: 'TOOL_CALL', modelTurnRequestId: newId('req'), toolCallId },
});
const context = (date: string) => ({
  type: 'REQUEST_CONTEXT',
  turnId: turn,
  agentRunId: mainRun,
  modelRef: { id: 'deepseek-flash', version: 'v2.0.0' },
  thinking: 'high',
  toolsDigest: digest,
  runtimeContext: { workingDirectory: '/repo', sandbox: 'none', currentDate: date },
});
const human = (turnId: string, digit: string) => ({
  type: 'HUMAN_ANSWERED',
  turnId,
  nodeId: `nod_${digit.repeat(32)}`,
  kind: 'prompt',
  origin: 'initial',
  inputId: newId('inp'),
  contentRef: ref(digit),
});

const requestId = newId('req');
const toolCallId = 'call_1';
const conversation = stamped([
  {
    type: 'SESSION_STARTED',
    formatVersion: 1,
    repositoryRoot: '/repo',
    definitionsDigest: digest,
    definitionVersions: [],
    workflowRunId: undefined,
  },
  { type: 'TURN_STARTED', turnId: turn, promptNodeId: `nod_${'c'.repeat(32)}` },
  human(turn, 'c'),
  {
    type: 'AGENT_RUN_REGISTERED',
    turnId: turn,
    agentRunId: mainRun,
    nodeId: `nod_${'d'.repeat(32)}`,
    agentRef: agentRef('main'),
    effort: 'high',
  },
  {
    type: 'AGENT_RUN_REGISTERED',
    turnId: turn,
    agentRunId: viewerRun,
    nodeId: `nod_${'e'.repeat(32)}`,
    agentRef: agentRef('code-viewer'),
    effort: 'none',
  },
  context('2026-10-31'),
  {
    type: 'MODEL_TURN',
    turnId: turn,
    agentRunId: mainRun,
    requestId: newId('req'),
    outputRef: ref('1'),
    toolCalls: [{ toolName: 'read_file', toolCallId, argsDigest: digest }],
    reasoningRef: ref('2'),
    replayable: true,
  },
  {
    type: 'MODEL_ATTEMPT_FAILED',
    turnId: turn,
    requestId: newId('req'),
    reasonCode: 'PROVIDER_ERROR',
  },
  submitted(requestId, mainRun, toolCallId),
  {
    type: 'UNIT_COMPLETED',
    turnId: turn,
    requestId,
    status: 'OK',
    output: {},
    outputRef: ref('3'),
    fullRef: ref('4'),
    budget,
  },
  submitted(newId('req'), viewerRun, 'other'),
  context('2026-10-31'),
  { type: 'TURN_ENDED', turnId: turn, reason: 'COMPLETED' },
  { type: 'WORKFLOW_RUN_ENDED', closeReason: 'ENDED_BY_USER' },
  {
    type: 'WORKFLOW_RUN_STARTED',
    workflowRunId: secondRun,
    mode: 'CHAT',
    preset: 'standard',
    initialInput: false,
  },
  {
    type: 'TURN_STARTED',
    workflowRunId: secondRun,
    turnId: secondTurn,
    promptNodeId: `nod_${'f'.repeat(32)}`,
  },
  { ...human(secondTurn, 'f'), workflowRunId: secondRun },
]);

describe('projectMainHistory', () => {
  const entries = projectMainHistory(conversation);

  it('crosses runs and keeps log order', () => {
    expect(entries.map((entry) => entry.kind)).toEqual([
      'HUMAN',
      'NOTE',
      'MODEL_TURN',
      'TOOL_RESULT',
      'HUMAN',
    ]);
    expect(entries.map((entry) => entry.seq)).toEqual(
      [...entries.map((e) => e.seq)].sort((a, b) => a - b),
    );
  });

  it('pins the prompt of the current Turn only', () => {
    expect(
      entries.filter((entry) => entry.category === 'PINNED').map((entry) => entry.turnId),
    ).toEqual([secondTurn]);
  });

  it('uses the preview and never the full output', () => {
    const result = entries.find((entry) => entry.kind === 'TOOL_RESULT');
    expect(result).toMatchObject({
      toolCallId,
      toolName: 'read_file',
      status: 'OK',
      outputRef: ref('3'),
    });
    expect(JSON.stringify(entries)).not.toContain(ref('4').artifactId);
  });

  it('carries the model and the replay decision of a model turn', () => {
    expect(entries.find((entry) => entry.kind === 'MODEL_TURN')).toMatchObject({
      modelId: 'deepseek-flash',
      reasoningRef: ref('2'),
      replayable: true,
    });
  });

  it('adds a runtime note only when it changed', () => {
    const changed = stamped([...conversation, context('2026-11-01')]);
    const notes = projectMainHistory(changed).filter((entry) => entry.kind === 'NOTE');
    expect(notes).toHaveLength(2);
  });

  it('leaves out other agents and failed attempts', () => {
    expect(JSON.stringify(entries)).not.toContain('other');
  });

  it('shows interrupted work', () => {
    const interrupted = stamped([
      ...conversation.slice(0, 9),
      { type: 'UNIT_INTERRUPTED', turnId: turn, requestId, reason: 'x' },
      { type: 'STALE_UNITS_SETTLED', requestIds: [requestId], turnIds: [], workflowRunIds: [] },
    ]);
    expect(projectMainHistory(interrupted).slice(-2)).toMatchObject([
      { kind: 'TOOL_RESULT', status: 'INTERRUPTED' },
      { kind: 'NOTE' },
    ]);
  });

  it('only ever appends between two prefixes of a log (invariant 27)', () => {
    const content = (entry: { category: string }) => ({ ...entry, category: '' });
    fc.assert(
      fc.property(fc.nat(conversation.length), fc.nat(conversation.length), (a, b) => {
        const [short, long] = a < b ? [a, b] : [b, a];
        const earlier = projectMainHistory(conversation.slice(0, short)).map(content);
        const later = projectMainHistory(conversation.slice(0, long)).map(content);
        expect(later.slice(0, earlier.length)).toEqual(earlier);
      }),
    );
  });
});

describe('projectInstructions', () => {
  const loaded = (workflowRunId: string, digit: string, trusted?: boolean) => ({
    type: 'PROJECT_FILE_LOADED',
    workflowRunId,
    path: 'AGENTS.md',
    ref: ref(digit),
    sha256: digit.repeat(64),
    ...(trusted === undefined ? {} : { trusted }),
  });

  it('takes the latest load of the run and treats unknown trust as untrusted', () => {
    const records = stamped([
      loaded(run, '1', true),
      loaded(run, '2'),
      loaded(secondRun, '3', true),
    ]);
    expect(projectInstructions(records, run)).toMatchObject({ ref: ref('2'), trusted: false });
    expect(projectInstructions([], run)).toBeUndefined();
  });
});
