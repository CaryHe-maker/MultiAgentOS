import { newId, type SessionLogRecord } from '@multiagentos/contracts';
import { testArtifactRef } from '@multiagentos/contracts/test-support';
import { describe, expect, it } from 'vitest';
import { fileBaselines, toolInputOf } from './tool-inputs.js';

const base = { at: '2026-11-04T00:00:00.000Z', workflowRunId: newId('wfr'), turnId: newId('trn') };
const budget = { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' } as const;
const agentRunId = newId('agr');
let seq = 0;
const line = <T extends object>(fields: T) => {
  seq += 1;
  return { ...base, seq, ...fields } as unknown as SessionLogRecord;
};
const sha = (c: string) => c.repeat(64);

const submitted = (requestId: string, toolCallId: string, path?: string, turnId = base.turnId) =>
  line({
    type: 'UNIT_SUBMITTED',
    turnId,
    requestId,
    agentRunId,
    inputSource: {
      kind: 'TOOL_CALL',
      modelTurnRequestId: newId('req'),
      toolCallId,
      ...(path === undefined ? {} : { workflowFields: { path } }),
    },
  });
const completed = (requestId: string, fields: object) =>
  line({ type: 'UNIT_COMPLETED', requestId, status: 'OK', budget, ...fields });

const main = { kind: 'MAIN' } as const;
const registered = line({
  type: 'AGENT_RUN_REGISTERED',
  agentRunId,
  agentRef: { id: 'main' },
});

describe('fileBaselines', () => {
  it('takes the digest of the whole file from a read, and the new one from a write', () => {
    const records = [
      completed(newId('req'), { output: { path: 'a.ts', fileSha256: sha('a') } }),
      completed(newId('req'), { output: { path: 'b.ts', fileSha256: sha('b') } }),
      completed(newId('req'), { output: { path: 'b.ts', operation: 'EDITED', sha256: sha('c') } }),
    ];
    expect(fileBaselines(records).get('a.ts')).toEqual({ kind: 'SHA', sha256: sha('a') });
    expect(fileBaselines(records).get('b.ts')).toEqual({ kind: 'SHA', sha256: sha('c') });
  });

  it('remembers a path read as missing', () => {
    const requestId = newId('req');
    const records = [
      submitted(requestId, 'call_1', 'gone.ts'),
      line({
        type: 'UNIT_COMPLETED',
        requestId,
        status: 'REJECTED',
        reasonCode: 'NOT_FOUND',
        budget,
      }),
    ];
    expect(fileBaselines(records).get('gone.ts')).toEqual({ kind: 'ABSENT' });
  });

  it('forgets everything after an undo, and a diverged file', () => {
    const read = (path: string) =>
      completed(newId('req'), { output: { path, fileSha256: sha('a') } });
    expect(
      fileBaselines([
        read('a.ts'),
        line({ type: 'WORKSPACE_REVERTED', revertedTurnIds: [base.turnId] }),
      ]).size,
    ).toBe(0);
    const diverged = fileBaselines([
      read('a.ts'),
      read('b.ts'),
      line({ type: 'WORKSPACE_DIVERGED', files: ['a.ts'] }),
    ]);
    expect([...diverged.keys()]).toEqual(['b.ts']);
  });
});

describe('toolInputOf for a command', () => {
  const main = { kind: 'MAIN' } as unknown as Parameters<typeof toolInputOf>[3];

  it('fills what the model leaves out: the root, two minutes, no network', () => {
    expect(toolInputOf('COMMAND', { command: 'npm test' }, [], main)).toEqual({
      ok: true,
      input: { command: 'npm test', workdir: '', timeoutMs: 120_000, network: false },
      workflowFields: { command: 'npm test', workdir: '', timeoutMs: 120_000, network: false },
    });
  });

  it('keeps what the model asked for, with the work directory normalised', () => {
    expect(
      toolInputOf(
        'COMMAND',
        { command: 'curl x', workdir: './pkg//a', timeoutMs: 5_000, network: true },
        [],
        main,
      ),
    ).toMatchObject({
      ok: true,
      input: { workdir: 'pkg/a', timeoutMs: 5_000, network: true },
    });
  });

  it.each(['../x', '/etc', 'a/../../b', 'C:/x'])('refuses the work directory %s', (workdir) => {
    expect(toolInputOf('COMMAND', { command: 'ls', workdir }, [], main)).toMatchObject({
      ok: false,
    });
  });
});

describe('toolInputOf', () => {
  const known = [completed(newId('req'), { output: { path: 'a.ts', fileSha256: sha('a') } })];

  it('fills in what the model cannot give for a write', () => {
    expect(toolInputOf('FILE_WRITE', { path: './a.ts', content: 'x' }, known, main)).toMatchObject({
      ok: true,
      input: { baseSha: sha('a') },
      workflowFields: { baseSha: sha('a') },
    });
    expect(toolInputOf('FILE_WRITE', { path: 'new.ts', content: 'x' }, known, main)).toMatchObject({
      ok: true,
      input: { expectAbsent: true },
    });
  });

  it('an edit needs a read first', () => {
    const args = { path: 'a.ts', oldString: 'a', newString: 'b' };
    expect(toolInputOf('FILE_EDIT', args, known, main)).toMatchObject({
      ok: true,
      input: { ...args, baseSha: sha('a') },
    });
    expect(toolInputOf('FILE_EDIT', { ...args, path: 'b.ts' }, known, main)).toMatchObject({
      ok: false,
      message: expect.stringContaining('read the file') as string,
    });
  });

  it('notes the path of a read, so a missing file is known from the log', () => {
    expect(toolInputOf('FILE_READ', { path: 'src//a.ts' }, [], main)).toMatchObject({
      workflowFields: { path: 'src/a.ts' },
    });
  });

  describe('read_output', () => {
    const fullRef = testArtifactRef();
    const requestId = newId('req');
    const log = [
      registered,
      submitted(requestId, 'call_1'),
      completed(requestId, { output: {}, fullRef }),
    ];

    it('translates the id into the full output, which the model never sees', () => {
      expect(toolInputOf('OUTPUT_READ', { toolCallId: 'call_1' }, log, main)).toEqual({
        ok: true,
        input: { toolCallId: 'call_1', fullRef },
        workflowFields: { fullRef },
      });
    });

    it('says when there is no such call, or nothing was cut', () => {
      expect(toolInputOf('OUTPUT_READ', { toolCallId: 'call_9' }, log, main)).toMatchObject({
        ok: false,
        message: expect.stringContaining('no tool call') as string,
      });
      const uncut = newId('req');
      const whole = [...log, submitted(uncut, 'call_2'), completed(uncut, { output: {} })];
      expect(toolInputOf('OUTPUT_READ', { toolCallId: 'call_2' }, whole, main)).toMatchObject({
        ok: false,
        message: expect.stringContaining('not cut') as string,
      });
    });

    it('does not reach a reverted Turn, and takes the latest of a repeated id', () => {
      const reverted = line({ type: 'WORKSPACE_REVERTED', revertedTurnIds: [base.turnId] });
      expect(
        toolInputOf('OUTPUT_READ', { toolCallId: 'call_1' }, [...log, reverted], main),
      ).toMatchObject({ ok: false });
      const later = testArtifactRef('later');
      const again = newId('req');
      expect(
        toolInputOf(
          'OUTPUT_READ',
          { toolCallId: 'call_1' },
          [...log, submitted(again, 'call_1'), completed(again, { output: {}, fullRef: later })],
          main,
        ),
      ).toMatchObject({ input: { fullRef: later } });
    });

    it('a node reads only its own AgentRun', () => {
      const other = {
        kind: 'NODE',
        workflowRunId: base.workflowRunId,
        agentRunId: newId('agr'),
      } as const;
      expect(toolInputOf('OUTPUT_READ', { toolCallId: 'call_1' }, log, other)).toMatchObject({
        ok: false,
      });
    });
  });
});
