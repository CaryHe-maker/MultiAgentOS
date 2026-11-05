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

const revision = spawnRevision('wfr_a', 2, { nodeId: 'nod_main', call }, [
  spec('one'),
  spec('two', ['one']),
]);
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

  it('reports every task of a call in the written order, a task without an outcome as failed', () => {
    const records = [extended()];
    expect(
      callResultsOf(records, 'wfr_a', 'nod_main', 'call_1').map((r) => [r.name, r.status]),
    ).toEqual([
      ['one', 'FAILED'],
      ['two', 'FAILED'],
    ]);
    expect(callResultsOf(records, 'wfr_a', 'nod_main', 'call_other')).toEqual([]);
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

  it('counts what a Turn has dispatched from the graph revisions alone', () => {
    const records = [
      extended(),
      extended(),
      { ...extended(), turnId: 'trn_b' } as SessionLogRecord,
    ];
    expect(spawnedIn(records, 'trn_a')).toEqual({ tasks: 4, calls: 2 });
    expect(spawnedIn(records, 'trn_c')).toEqual({ tasks: 0, calls: 0 });
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
      acceptance: [],
      inputs: [],
      effort: 'low',
      tokens: 500,
      clamped: 'MIN',
    });
  });
});
