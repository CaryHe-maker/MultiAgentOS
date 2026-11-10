import { newId, type ArtifactRef, type SessionLogRecord } from '@multiagentos/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { projectHistory, divergedNote } from './history-projection.js';

const projectMainHistory = (records: readonly SessionLogRecord[]) =>
  projectHistory(records, { kind: 'MAIN' });

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

describe('project instructions', () => {
  const loaded = (workflowRunId: string, digit: string, trusted?: boolean) => ({
    type: 'PROJECT_FILE_LOADED',
    workflowRunId,
    path: 'AGENTS.md',
    ref: ref(digit),
    sha256: digit.repeat(64),
    ...(trusted === undefined ? {} : { trusted }),
  });
  const instructions = (records: Parameters<typeof stamped>[0]) =>
    projectHistory(stamped(records), { kind: 'MAIN' }).filter(
      (entry) => entry.kind === 'PROJECT_INSTRUCTIONS',
    );

  it('appends them where they were read, pinned, and treats unknown trust as untrusted', () => {
    expect(instructions([loaded(run, '1')])).toMatchObject([
      { category: 'PINNED', path: 'AGENTS.md', ref: ref('1'), trusted: false },
    ]);
  });

  it('shows the same content once, and what changed takes the place of what it replaces', () => {
    expect(instructions([loaded(run, '1', true), loaded(secondRun, '1', true)])).toHaveLength(1);
    const changed = instructions([
      loaded(run, '1', true),
      loaded(secondRun, '1', true),
      loaded(secondRun, '2'),
    ]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ ref: ref('2') });
  });
});

describe('a template node', () => {
  const handoff = { outputRef: ref('7'), toolCallId: 'call_9' };

  it('sees the goal, its handoff and its own steps only', () => {
    const entries = projectHistory(conversation, {
      kind: 'NODE',
      workflowRunId: run,
      agentRunId: viewerRun,
      handoff,
    });
    expect(entries.map((entry) => entry.kind)).toEqual(['HUMAN', 'HANDOFF']);
    expect(entries.every((entry) => entry.category === 'PINNED')).toBe(true);
    expect(entries[1]).toMatchObject(handoff);
  });

  it('does not see the steps of another Agent', () => {
    const entries = projectHistory(conversation, {
      kind: 'NODE',
      workflowRunId: run,
      agentRunId: viewerRun,
    });
    expect(JSON.stringify(entries)).not.toContain('call_1');
  });
});

describe('compaction in a projection (M2Design 9.6)', () => {
  const assembled = newId('req');
  const head = 'b'.repeat(64);
  const modelRequest = newId('req');
  const resultRequest = newId('req');
  const submittedAssembly = {
    type: 'UNIT_SUBMITTED',
    turnId: turn,
    requestId: assembled,
    path: 'agr_abcdef/round-1/0#1',
    agentRunId: mainRun,
    unitRunId: `unr_${'c'.repeat(32)}`,
    unitRef: { kind: 'UNIT', id: 'context-assemble', version: 'v1.0.0', digest },
    inputSource: { kind: 'AGENT_RUN', agentRunId: mainRun },
  };
  const log = (extra: readonly object[] = []) =>
    stamped([
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
      context('2026-10-31'),
      submittedAssembly,
      {
        type: 'CONTEXT_ASSEMBLED',
        turnId: turn,
        requestId: assembled,
        projectionDigest: digest,
        headDigest: head,
        tokenCount: 100,
        tokenBudget: 1000,
      },
      {
        type: 'MODEL_TURN',
        turnId: turn,
        agentRunId: mainRun,
        requestId: modelRequest,
        outputRef: ref('1'),
        toolCalls: [{ toolName: 'read_file', toolCallId, argsDigest: digest }],
        replayable: false,
        usage: { inputTokens: 1234, outputTokens: 56 },
      },
      submitted(resultRequest, mainRun, toolCallId),
      {
        type: 'UNIT_COMPLETED',
        turnId: turn,
        requestId: resultRequest,
        status: 'OK',
        output: {},
        outputRef: ref('3'),
        fullRef: ref('4'),
        budget,
      },
      ...extra,
    ]);

  it('hands over what the provider counted and the request of each result, in the material only', () => {
    const material = projectHistory(log(), { kind: 'MAIN' }, { material: true });
    expect(material.find((entry) => entry.kind === 'MODEL_TURN')).toMatchObject({
      measured: { inputTokens: 1234, outputTokens: 56, headDigest: head },
    });
    expect(material.find((entry) => entry.kind === 'TOOL_RESULT')).toMatchObject({
      requestId: resultRequest,
      fullRef: ref('4'),
    });
    const shown = projectMainHistory(log());
    expect(JSON.stringify(shown)).not.toContain('measured');
    expect(JSON.stringify(shown)).not.toContain(ref('4').artifactId);
  });

  const compacted = (target: object) => ({
    type: 'CONTEXT_COMPACTED',
    turnId: turn,
    compactionId: newId('cmp'),
    target,
    fromSeq: 2,
    toSeq: 9,
    keptSeqs: [2],
    summaryRef: ref('5'),
    summaryInput: { mode: 'PREFIX', omittedEntries: 0 },
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
  });

  it('replaces the range of the target with the summary and keeps what was chosen', () => {
    const entries = projectMainHistory(log([compacted({ kind: 'MAIN' })]));
    expect(entries.map((entry) => entry.kind)).toEqual(['SUMMARY', 'HUMAN']);
    expect(entries[0]).toMatchObject({ kind: 'SUMMARY', contentRef: ref('5') });
  });

  it('leaves the other targets alone', () => {
    const other = compacted({ kind: 'AGENT_RUN', agentRunId: viewerRun });
    expect(projectMainHistory(log([other])).map((entry) => entry.kind)).not.toContain('SUMMARY');
    const mine = compacted({ kind: 'AGENT_RUN', agentRunId: mainRun });
    expect(projectMainHistory(log([mine])).map((entry) => entry.kind)).not.toContain('SUMMARY');
  });

  it('shows the cut result where the result was, and the revoked summary replaces nothing', () => {
    const summary = compacted({ kind: 'MAIN' });
    const records = log([
      {
        type: 'TOOL_RESULTS_PRUNED',
        turnId: turn,
        compactionId: newId('cmp'),
        target: { kind: 'MAIN' },
        items: [
          {
            requestId: resultRequest,
            toolCallId,
            prunedRef: ref('6'),
            readableRef: ref('4'),
            omittedBytes: 99,
          },
        ],
      },
      summary,
      {
        type: 'CONTEXT_COMPACTION_REVOKED',
        compactionId: summary.compactionId,
        reason: 'TURN_REVERTED',
      },
    ]);
    const entries = projectMainHistory(records);
    expect(entries.find((entry) => entry.kind === 'TOOL_RESULT')).toMatchObject({
      prunedAt: expect.any(Number) as number,
      outputRef: ref('6'),
    });
    expect(entries.map((entry) => entry.kind)).not.toContain('SUMMARY');
  });

  it('only ever appends between two prefixes of a log once a summary is in it (invariant 27)', () => {
    const records = log([compacted({ kind: 'MAIN' })]);
    const more = stamped([
      ...records.map((record) => {
        const rest: Record<string, unknown> = { ...record };
        delete rest['seq'];
        return rest;
      }),
      { type: 'TURN_ENDED', turnId: turn, reason: 'COMPLETED' },
      { type: 'WORKFLOW_RUN_ENDED', closeReason: 'ENDED_BY_USER' },
    ]);
    const shorter = projectMainHistory(records);
    const longer = projectMainHistory(more);
    expect(longer.slice(0, shorter.length)).toEqual(shorter);
  });
});

describe('divergedNote', () => {
  it('names the files that changed, as many as fit in a note, and counts the rest', () => {
    const few = divergedNote(['a.ts', 'b.ts']);
    expect(few).toContain('a.ts, b.ts');
    expect(few).not.toContain('more');

    const many = Array.from({ length: 300 }, (_, index) => `src/module-${String(index)}/file.ts`);
    const note = divergedNote(many);
    // A note is at most 2000 characters in the history; more is not a valid history at all.
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(note).toContain('src/module-0/file.ts');
    expect(note).toMatch(/\(and \d+ more; use git status to see them all\)/u);

    const long = divergedNote(['x'.repeat(5000)]);
    expect(long.length).toBeLessThanOrEqual(2000);
  });
});
