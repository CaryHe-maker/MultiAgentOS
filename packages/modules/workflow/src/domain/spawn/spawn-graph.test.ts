import type { SessionLogRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { projectGraph, spawnRevision } from '../graph/session-graph.js';
import { callOf, callResultsOf, spawnNodeOf, spawnedIn, taskScopeOf } from './spawn-graph.js';

const call = { toolCallId: 'call_1', delegationId: 'dlg_1' };
const at = '2026-11-06T00:00:00.000Z';
let seq = 0;
const record = (body: object, turnId = 'trn_a'): SessionLogRecord =>
  ({ at, workflowRunId: 'wfr_a', turnId, seq: (seq += 1), ...body }) as SessionLogRecord;
const spec = (name: string, dependsOn: string[] = []) => ({
  name,
  agentRef: { id: 'explorer', version: 'v1.0.0' },
  goal: `look at ${name}`,
  dependsOn,
  spawn: { writeScope: [], acceptance: ['say so'], inputs: [], tokens: 1000 },
});

const revision = spawnRevision(
  'wfr_a',
  2,
  { nodeId: 'nod_main', call, missionId: 'msc_rootmission' },
  [spec('one'), spec('two', ['one'])],
);
const extended = () =>
  record({
    type: 'GRAPH_EXTENDED',
    revision: 2,
    source: 'SPAWN',
    nodes: revision.nodes,
    edges: revision.edges,
  });

describe('what the tasks of a call look like in the log', () => {
  it('finds the caller and delegation of a task from its DELEGATE edge', () => {
    const projected = projectGraph([extended()], 'wfr_a');
    const [one] = revision.nodes;
    expect(callOf(projected, one?.nodeId ?? '')).toEqual({
      callerNodeId: 'nod_main',
      delegationId: 'dlg_1',
    });
    expect(callOf(projected, 'nod_main')).toBeUndefined();
  });

  it('answers no call with joined results: a spawn has no RESUME edges any more (D14)', () => {
    const records = [extended()];
    expect(callResultsOf(records, 'wfr_a', 'nod_main', 'call_1')).toEqual([]);
  });

  it('gives a task what it must do and only the results of the tasks it depends on', () => {
    const [one, two] = revision.nodes;
    const projected = projectGraph([extended()], 'wfr_a');
    const scope = taskScopeOf(
      [extended()],
      'wfr_a',
      projected,
      two ?? revision.nodes[0]!,
      two?.spawn ?? spec('x').spawn,
    );
    expect(scope.name).toBe('two');
    expect(scope.acceptance).toEqual(['say so']);
    expect(scope.dependencies.map((entry) => entry.name)).toEqual(['one']);
    expect(
      taskScopeOf([extended()], 'wfr_a', projected, one ?? revision.nodes[0]!, spec('x').spawn)
        .dependencies,
    ).toEqual([]);
  });

  it('counts what the work since an input has dispatched from the graph revisions alone', () => {
    const records = [extended(), extended(), extended()];
    const since = records[1]?.seq ?? 0;
    expect(spawnedIn(records, since)).toEqual({ tasks: 4, calls: 2 });
    expect(spawnedIn(records, (records[2]?.seq ?? 0) + 1)).toEqual({ tasks: 0, calls: 0 });
  });

  it('writes the task as the caller asked, with the share the Kernel granted', () => {
    const task = {
      name: 't',
      goal: 'g',
      agent: 'worker',
      writeRoots: ['api'],
      effort: 'low',
    } as never;
    expect(spawnNodeOf(task, { tokens: 500, clamped: 'MIN' })).toEqual({
      writeScope: ['api'],
      // No role given: the start of the goal stands for it (Orchestration 3.7).
      role: 'g',
      acceptance: [],
      inputs: [],
      effort: 'low',
      tokens: 500,
      clamped: 'MIN',
    });
  });

  it('keeps the role and a scope lent without commands (D17, D18)', () => {
    const task = {
      name: 'ui',
      goal: 'build the pages\nwith tests',
      role: 'responsible for the frontend',
      agent: 'worker',
      writeRoots: ['web'],
      commands: false,
    } as never;
    expect(spawnNodeOf(task, { tokens: 500 })).toMatchObject({
      role: 'responsible for the frontend',
      commands: false,
    });
    const unnamed = {
      name: 'x',
      goal: 'first line\nsecond',
      agent: 'worker',
      writeRoots: [],
    } as never;
    expect(spawnNodeOf(unnamed, { tokens: 1 })).toMatchObject({ role: 'first line' });
  });
});
