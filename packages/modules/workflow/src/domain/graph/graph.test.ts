import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { edgeState, nodeIdOf, nodePath, readyNodes, settleSkips, skippedNodes } from './graph.js';
import type { Graph, GraphEdge, GraphNode, NodeRecord, Trigger } from './graph.js';

const node = (name: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  nodeId: name,
  name,
  kind: 'AGENT',
  trigger: 'all_success',
  ...extra,
});
const edge = (from: string, to: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({
  from,
  to,
  kind: 'DEPENDS',
  ...extra,
});
const view = (entries: Record<string, NodeRecord>): ReadonlyMap<string, NodeRecord> =>
  new Map(Object.entries(entries));
const names = (nodes: readonly GraphNode[]): string[] => nodes.map((entry) => entry.name);

describe('edge states and readiness (M2Design 3.3)', () => {
  it('maps every predecessor state', () => {
    const graph: Graph = { nodes: [node('a'), node('b')], edges: [] };
    const state = (record: NodeRecord): string =>
      edgeState(graph, edge('a', 'b'), view({ a: record }));
    expect(state({ status: 'RUNNING' })).toBe('WAITING');
    expect(state({ status: 'SUCCEEDED' })).toBe('TAKEN');
    expect(state({ status: 'SKIPPED', skipReason: 'DEPENDENCY_FAILED' })).toBe('FAILED');
    expect(state({ status: 'FAILED' })).toBe('FAILED');
    expect(state({ status: 'INTERRUPTED' })).toBe('FAILED');
  });

  it('waits for every predecessor before skipping', () => {
    const graph: Graph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'c'), edge('b', 'c')],
    };
    const waiting = view({ a: { status: 'SUCCEEDED' }, b: { status: 'RUNNING' } });
    expect(skippedNodes(graph, waiting)).toEqual([]);
    const ended = view({ a: { status: 'SUCCEEDED' }, b: { status: 'FAILED' } });
    expect(skippedNodes(graph, ended)[0]?.reason).toBe('DEPENDENCY_FAILED');
  });

  it('starts an all_done node whatever its predecessors became', () => {
    const graph: Graph = {
      nodes: [node('main'), node('next', { kind: 'HUMAN', trigger: 'all_done' })],
      edges: [edge('main', 'next')],
    };
    expect(names(readyNodes(graph, view({ main: { status: 'RUNNING' } })))).toEqual([]);
    expect(names(readyNodes(graph, view({ main: { status: 'FAILED' } })))).toEqual(['next']);
    expect(skippedNodes(graph, view({ main: { status: 'FAILED' } }))).toEqual([]);
  });

  it('passes skips downstream', () => {
    const graph: Graph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('b', 'c')],
    };
    const { skipped, view: settled } = settleSkips(graph, view({ a: { status: 'FAILED' } }));
    expect(skipped.map(({ node: n }) => n.name)).toEqual(['b', 'c']);
    expect(settled.get('c')).toEqual({ status: 'SKIPPED', skipReason: 'DEPENDENCY_FAILED' });
  });
});

describe('node identifiers', () => {
  it('derives the same ID from the same path', () => {
    const path = nodePath('wfr_1', 2, 'review');
    expect(path).toBe('wfr_1/2/review');
    expect(nodeIdOf(path)).toMatch(/^nod_[0-9a-f]{32}$/);
    expect(nodeIdOf(path)).toBe(nodeIdOf(nodePath('wfr_1', 2, 'review')));
  });
});

describe('replaying any log prefix', () => {
  type Outcome = 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
  interface Spec {
    readonly triggers: readonly Trigger[];
    readonly parents: readonly (readonly number[])[];
    readonly outcomes: readonly Outcome[];
  }
  const specs: fc.Arbitrary<Spec> = fc.integer({ min: 1, max: 12 }).chain((size) =>
    fc.record({
      triggers: fc.array(fc.constantFrom<Trigger>('all_success', 'all_done'), {
        minLength: size,
        maxLength: size,
      }),
      parents: fc.tuple(
        ...Array.from({ length: size }, (_, index) =>
          fc.uniqueArray(fc.nat(Math.max(index - 1, 0)), { maxLength: index }),
        ),
      ),
      outcomes: fc.array(fc.constantFrom<Outcome>('SUCCEEDED', 'FAILED', 'INTERRUPTED'), {
        minLength: size,
        maxLength: size,
      }),
    }),
  );
  const build = (spec: Spec): Graph => ({
    nodes: spec.triggers.map((trigger, index) => node(`n${String(index)}`, { trigger })),
    edges: spec.parents.flatMap((parents, index) =>
      parents
        .filter((parent) => parent < index)
        .map((parent) => edge(`n${String(parent)}`, `n${String(index)}`)),
    ),
  });

  it('gives the same ready set as the run, and every run terminates', () => {
    fc.assert(
      fc.property(specs, (spec) => {
        const graph = build(spec);
        const log: [string, NodeRecord][] = [];
        const replay = (prefix: number): ReadonlyMap<string, NodeRecord> =>
          new Map(log.slice(0, prefix));
        let live: ReadonlyMap<string, NodeRecord> = new Map();
        for (;;) {
          const settled = settleSkips(graph, live);
          for (const { node: skipped, reason } of settled.skipped) {
            log.push([skipped.nodeId, { status: 'SKIPPED', skipReason: reason }]);
          }
          live = settled.view;
          const ready = readyNodes(graph, live);
          expect(ready).toEqual(readyNodes(graph, replay(log.length)));
          const next = ready[0];
          if (next === undefined) break;
          const index = graph.nodes.indexOf(next);
          const record: NodeRecord = { status: spec.outcomes[index] ?? 'SUCCEEDED' };
          log.push([next.nodeId, record]);
          live = new Map(live).set(next.nodeId, record);
        }
        expect(live.size).toBe(graph.nodes.length);
        for (let prefix = 0; prefix <= log.length; prefix += 1) {
          const again = replay(prefix);
          expect(readyNodes(graph, again)).toEqual(readyNodes(graph, new Map(again)));
        }
      }),
    );
  });
});
