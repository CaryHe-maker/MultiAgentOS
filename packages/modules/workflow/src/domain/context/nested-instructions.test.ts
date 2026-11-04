import { newId, type SessionLogRecord } from '@multiagentos/contracts';
import { testArtifactRef } from '@multiagentos/contracts/test-support';
import { describe, expect, it } from 'vitest';
import { MAX_NESTED_INSTRUCTIONS, instructionsToLoad } from './nested-instructions.js';

const workflowRunId = newId('wfr');
const agentRunId = newId('agr');
const turnId = newId('trn');
const main = { kind: 'MAIN' } as const;
let seq = 0;
const line = (fields: object, run = workflowRunId) => {
  seq += 1;
  return {
    at: '2026-11-04T00:00:00.000Z',
    workflowRunId: run,
    seq,
    ...fields,
  } as unknown as SessionLogRecord;
};
const read = (nested: readonly string[], owner = agentRunId, run = workflowRunId) => {
  const requestId = newId('req');
  return [
    line({ type: 'UNIT_SUBMITTED', requestId, agentRunId: owner }, run),
    line(
      {
        type: 'UNIT_COMPLETED',
        requestId,
        status: 'OK',
        output: { path: 'x', nestedInstructions: nested },
      },
      run,
    ),
  ];
};
const loaded = (path: string, run = workflowRunId) =>
  line(
    {
      type: 'PROJECT_FILE_LOADED',
      path,
      ref: testArtifactRef(),
      sha256: 'a'.repeat(64),
      agentRunId,
    },
    run,
  );
const toLoad = (records: readonly SessionLogRecord[]) =>
  instructionsToLoad(records, main, workflowRunId, agentRunId).map((item) => item.path);

describe('instructionsToLoad', () => {
  it('asks for what a read passed, outermost first, once', () => {
    const records = read(['a/AGENTS.md', 'a/b/AGENTS.md']);
    expect(toLoad(records)).toEqual(['a/AGENTS.md', 'a/b/AGENTS.md']);
    expect(toLoad([...records, loaded('a/AGENTS.md'), loaded('a/b/AGENTS.md')])).toEqual([]);
    expect(
      toLoad([
        ...records,
        loaded('a/AGENTS.md'),
        loaded('a/b/AGENTS.md'),
        ...read(['a/AGENTS.md']),
      ]),
    ).toEqual([]);
  });

  it('reads again in a later run', () => {
    const before = newId('wfr');
    expect(toLoad([loaded('a/AGENTS.md', before), ...read(['a/AGENTS.md'])])).toEqual([
      'a/AGENTS.md',
    ]);
  });

  it('keeps to its own projection', () => {
    const other = newId('agr');
    const node = { kind: 'NODE', workflowRunId, agentRunId } as const;
    expect(
      instructionsToLoad(read(['a/AGENTS.md'], other), node, workflowRunId, agentRunId),
    ).toEqual([]);
  });

  it('notes what is beyond the limit, and does not ask again', () => {
    const paths = Array.from(
      { length: MAX_NESTED_INSTRUCTIONS + 2 },
      (_, i) => `d${String(i)}/AGENTS.md`,
    );
    const items = instructionsToLoad(read(paths), main, workflowRunId, agentRunId);
    expect(items.filter((item) => item.skip).map((item) => item.path)).toEqual(paths.slice(-2));
    const noted = line({
      type: 'PROJECT_FILE_LOADED',
      path: 'd9/AGENTS.md',
      agentRunId,
      skipped: 'LIMIT',
    });
    expect(toLoad([noted, ...read(['d9/AGENTS.md'])])).toEqual([]);
  });

  it('reads again what an approved write changed, only if it was loaded', () => {
    const write = (path: string) => {
      const requestId = newId('req');
      return [
        line({ type: 'UNIT_SUBMITTED', requestId, agentRunId }),
        line({
          type: 'UNIT_COMPLETED',
          requestId,
          status: 'OK',
          output: { path, operation: 'EDITED', sha256: 'b'.repeat(64) },
        }),
      ];
    };
    expect(toLoad(write('a/AGENTS.md'))).toEqual([]);
    expect(toLoad([loaded('a/AGENTS.md'), ...write('a/AGENTS.md')])).toEqual(['a/AGENTS.md']);
    expect(toLoad([loaded('a/AGENTS.md'), ...write('a/AGENTS.md'), loaded('a/AGENTS.md')])).toEqual(
      [],
    );
  });

  it('does not count a load in a reverted Turn', () => {
    const records = [
      line({ type: 'TURN_STARTED', turnId }),
      loaded('a/AGENTS.md'),
      line({ type: 'WORKSPACE_REVERTED', revertedTurnIds: [turnId] }),
      ...read(['a/AGENTS.md']),
    ];
    expect(toLoad(records)).toEqual(['a/AGENTS.md']);
  });
});
