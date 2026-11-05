import type { SessionLogRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import {
  edgeState,
  readyNodes,
  settleSkips,
  validateExtension,
  wakeableNodes,
  withWaiting,
} from './graph.js';
import type { Graph, GraphEdge, GraphNode, NodeRecord, NodeView } from './graph.js';
import { chatGrowthPoint, projectGraph, spawnRevision } from './session-graph.js';

const call = { toolCallId: 'call_1', delegationId: 'dlg_1' };
const node = (name: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  nodeId: name,
  name,
  kind: 'AGENT',
  trigger: 'all_success',
  iteration: 1,
  ...extra,
});
const edge = (from: string, to: string, kind: GraphEdge['kind'], withCall = false): GraphEdge => ({
  from,
  to,
  kind,
  ...(withCall ? { call } : {}),
});
const view = (entries: Record<string, NodeRecord>): NodeView => new Map(Object.entries(entries));
const names = (nodes: readonly { readonly name: string }[]): string[] => nodes.map((n) => n.name);

/** main dispatches a and b; b waits for a; both come back to main. */
const graph: Graph = {
  nodes: [node('main'), node('a'), node('b')],
  edges: [
    edge('a', 'b', 'DEPENDS'),
    edge('main', 'a', 'DELEGATE', true),
    edge('a', 'main', 'RESUME', true),
    edge('main', 'b', 'DELEGATE', true),
    edge('b', 'main', 'RESUME', true),
  ],
};

describe('a call in the task graph (M2Design 3.1, 3.3)', () => {
  it('lets a task start once its caller runs, and the caller is the last link', () => {
    const running = view({ main: { status: 'RUNNING' } });
    expect(names(readyNodes(graph, running))).toEqual(['a']);
    // Before the caller started nothing was dispatched; after it ended nobody is left to serve.
    expect(
      edgeState(graph, edge('main', 'a', 'DELEGATE', true), view({ main: { status: 'PENDING' } })),
    ).toBe('WAITING');
    const gone = view({ main: { status: 'FAILED' } });
    expect(edgeState(graph, edge('main', 'a', 'DELEGATE', true), gone)).toBe('FAILED');
    expect(settleSkips(graph, gone).skipped.map(({ node: skipped }) => skipped.name)).toEqual([
      'a',
      'b',
    ]);
  });

  it('does not let a RESUME edge hold back the caller, or make a cycle', () => {
    // main depends on nothing that comes back, and the returning edges are no part of readiness.
    expect(names(readyNodes(graph, view({})))).toEqual(['main']);
    const rules = { builtInAgents: new Set(['explorer']), allowConditions: false };
    const proposed = { node: node('a'), agentId: 'explorer' };
    expect(
      validateExtension(
        { nodes: [node('main')], edges: [] },
        {
          nodes: [proposed],
          edges: [edge('main', 'a', 'DELEGATE', true), edge('a', 'main', 'RESUME', true)],
        },
        rules,
      ),
    ).toEqual([]);
    // A forward edge back to the caller is a cycle; only RESUME may point back.
    expect(
      validateExtension(
        { nodes: [node('main')], edges: [] },
        {
          nodes: [proposed],
          edges: [edge('main', 'a', 'DELEGATE', true), edge('a', 'main', 'DEPENDS')],
        },
        rules,
      ),
    ).toEqual([{ code: 'CYCLE' }]);
  });

  it('marks a running node WAITING while a call has not come back, and RUNNING again after', () => {
    const running = view({ main: { status: 'RUNNING' } });
    expect(withWaiting(graph, running).get('main')?.status).toBe('WAITING');
    const back = view({ main: { status: 'RUNNING', resumed: ['call_1'] } });
    expect(withWaiting(graph, back).get('main')?.status).toBe('RUNNING');
    // Only a node that dispatched something can wait, and only while it runs.
    expect(withWaiting(graph, view({ a: { status: 'RUNNING' } })).get('a')?.status).toBe('RUNNING');
    expect(withWaiting(graph, view({ main: { status: 'SUCCEEDED' } })).get('main')?.status).toBe(
      'SUCCEEDED',
    );
  });

  it('wakes the caller when every task of the call has ended, however it ended', () => {
    const waiting = (a: NodeRecord['status'], b: NodeRecord['status']) =>
      withWaiting(graph, view({ main: { status: 'RUNNING' }, a: { status: a }, b: { status: b } }));
    expect(wakeableNodes(graph, waiting('SUCCEEDED', 'RUNNING'))).toEqual([]);
    expect(wakeableNodes(graph, waiting('PENDING', 'PENDING'))).toEqual([]);
    const woken = wakeableNodes(graph, waiting('FAILED', 'SKIPPED'));
    expect(woken.map(({ node: n, call: c }) => [n.name, c.toolCallId])).toEqual([
      ['main', 'call_1'],
    ]);
  });

  it('wakes a caller once for a call, and again for the next call', () => {
    const second = { toolCallId: 'call_2', delegationId: 'dlg_2' };
    const next: Graph = {
      nodes: [...graph.nodes, node('c')],
      edges: [
        ...graph.edges,
        { from: 'main', to: 'c', kind: 'DELEGATE', call: second },
        { from: 'c', to: 'main', kind: 'RESUME', call: second },
      ],
    };
    const ended: Record<string, NodeRecord> = {
      a: { status: 'SUCCEEDED' },
      b: { status: 'SUCCEEDED' },
      c: { status: 'RUNNING' },
    };
    const first = withWaiting(
      next,
      view({ ...ended, main: { status: 'RUNNING', resumed: ['call_1'] } }),
    );
    expect(wakeableNodes(next, first)).toEqual([]);
    const both = withWaiting(
      next,
      view({
        ...ended,
        c: { status: 'SUCCEEDED' },
        main: { status: 'RUNNING', resumed: ['call_1'] },
      }),
    );
    expect(wakeableNodes(next, both).map(({ call: c }) => c.toolCallId)).toEqual(['call_2']);
  });
});

describe('a call in the log', () => {
  const at = '2026-11-06T00:00:00.000Z';
  const base = { at, workflowRunId: 'wfr_a', turnId: 'trn_a' } as const;
  let seq = 0;
  const record = (body: object): SessionLogRecord =>
    ({ ...base, seq: (seq += 1), ...body }) as SessionLogRecord;
  const spec = (name: string, dependsOn: string[] = []) => ({
    name,
    agentRef: { id: 'explorer', version: 'v1.0.0' },
    goal: `look at ${name}`,
    dependsOn,
    spawn: { writeScope: [], acceptance: [], inputs: [], tokens: 1000 },
  });

  it('builds the revision of a call with DELEGATE and RESUME edges in the written order', () => {
    const revision = spawnRevision('wfr_a', 2, { nodeId: 'nod_main', call }, [
      spec('one'),
      spec('two', ['one']),
    ]);
    expect(revision.nodes.map((n) => n.name)).toEqual(['one', 'two']);
    const kinds = revision.edges.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'DEPENDS')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'DELEGATE')).toHaveLength(2);
    expect(revision.edges.filter((e) => e.kind === 'RESUME').map((e) => e.to)).toEqual([
      'nod_main',
      'nod_main',
    ]);
    expect(
      revision.edges.every((e) => e.kind === 'DEPENDS' || e.call?.toolCallId === 'call_1'),
    ).toBe(true);
  });

  it('projects WAITING from the edges and the records, and RUNNING after NODE_RESUMED', () => {
    seq = 0;
    const revision = spawnRevision('wfr_a', 2, { nodeId: 'nod_main', call }, [spec('one')]);
    const mainNode = {
      nodeId: 'nod_main',
      path: 'wfr_a/1/main#1',
      name: 'main',
      kind: 'AGENT' as const,
      trigger: 'all_success' as const,
      iteration: 1,
    };
    const log = [
      record({
        type: 'GRAPH_EXTENDED',
        revision: 1,
        source: 'TEMPLATE',
        nodes: [mainNode],
        edges: [],
      }),
      record({ type: 'NODE_STARTED', nodeId: 'nod_main', path: 'wfr_a/1/main#1' }),
      record({
        type: 'GRAPH_EXTENDED',
        revision: 2,
        source: 'SPAWN',
        nodes: revision.nodes,
        edges: revision.edges,
      }),
    ];
    expect(projectGraph(log, 'wfr_a').view.get('nod_main')?.status).toBe('WAITING');
    const resumed = [...log, record({ type: 'NODE_RESUMED', nodeId: 'nod_main', call })];
    expect(projectGraph(resumed, 'wfr_a').view.get('nod_main')?.status).toBe('RUNNING');
  });

  it('does not take a task, or a main that dispatched, for the next step of a chat', () => {
    seq = 0;
    const revision = spawnRevision('wfr_a', 2, { nodeId: 'nod_main', call }, [spec('one')]);
    const mainNode = {
      nodeId: 'nod_main',
      path: 'wfr_a/1/main#1',
      name: 'main',
      kind: 'AGENT' as const,
      trigger: 'all_success' as const,
      iteration: 1,
    };
    const log = [
      record({
        type: 'GRAPH_EXTENDED',
        revision: 1,
        source: 'TEMPLATE',
        nodes: [mainNode],
        edges: [],
      }),
      record({ type: 'NODE_STARTED', nodeId: 'nod_main', path: 'p' }),
      record({
        type: 'GRAPH_EXTENDED',
        revision: 2,
        source: 'SPAWN',
        nodes: revision.nodes,
        edges: revision.edges,
      }),
      record({ type: 'NODE_STARTED', nodeId: revision.nodes[0]?.nodeId, path: 'p' }),
      record({ type: 'NODE_ENDED', nodeId: revision.nodes[0]?.nodeId, status: 'SUCCEEDED' }),
    ];
    // The task ended, main still waits: nothing grows.
    expect(chatGrowthPoint(projectGraph(log, 'wfr_a'))).toBeUndefined();
    const ended = [
      ...log,
      record({ type: 'NODE_RESUMED', nodeId: 'nod_main', call }),
      record({ type: 'NODE_ENDED', nodeId: 'nod_main', status: 'SUCCEEDED' }),
    ];
    expect(chatGrowthPoint(projectGraph(ended, 'wfr_a'))).toBe('nod_main');
  });
});
