import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  conditionHolds,
  decideLoop,
  edgeState,
  loopBody,
  nodeIdOf,
  nodePath,
  readyNodes,
  settleSkips,
  skippedNodes,
  validateExtension,
} from './graph.js';
import type { Graph, GraphEdge, GraphNode, LoopEdge, NodeRecord, Trigger } from './graph.js';

const node = (name: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  nodeId: name,
  name,
  kind: 'AGENT',
  trigger: 'all_success',
  iteration: 1,
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

const handoff = { field: 'action', equals: 'HANDOFF' };
const analyze: Graph = {
  nodes: [node('prompt', { kind: 'HUMAN' }), node('plan'), node('view')],
  edges: [edge('prompt', 'plan'), edge('plan', 'view', { kind: 'CONDITIONAL', when: handoff })],
};

describe('conditionHolds', () => {
  it('reads nested fields with equals and in', () => {
    expect(conditionHolds({ field: 'a.b', equals: true }, { a: { b: true } })).toBe(true);
    expect(conditionHolds({ field: 'a', in: ['x', 'y'] }, { a: 'y' })).toBe(true);
    expect(conditionHolds({ field: 'a', in: ['x'] }, { a: 'y' })).toBe(false);
  });

  it('never holds for a missing or non-scalar field', () => {
    expect(conditionHolds({ field: 'a.b', equals: true }, { a: 1 })).toBe(false);
    expect(conditionHolds({ field: 'a', equals: 'x' }, undefined)).toBe(false);
    expect(conditionHolds({ field: 'a', in: ['x'] }, { a: ['x'] })).toBe(false);
  });
});

describe('edge states and readiness (M2Design 3.3)', () => {
  it('maps every predecessor state', () => {
    const graph: Graph = { nodes: [node('a'), node('b')], edges: [] };
    const plain = edge('a', 'b');
    const conditional = edge('a', 'b', { kind: 'CONDITIONAL', when: handoff });
    const state = (record: NodeRecord, e = plain): string =>
      edgeState(graph, e, view({ a: record }));
    expect(state({ status: 'RUNNING' })).toBe('WAITING');
    expect(state({ status: 'SUCCEEDED' })).toBe('TAKEN');
    expect(state({ status: 'SUCCEEDED', result: { action: 'HANDOFF' } }, conditional)).toBe(
      'TAKEN',
    );
    expect(state({ status: 'SUCCEEDED', result: { action: 'FINISH' } }, conditional)).toBe(
      'NOT_TAKEN',
    );
    expect(state({ status: 'SKIPPED', skipReason: 'NOT_TAKEN' })).toBe('NOT_TAKEN');
    expect(state({ status: 'SKIPPED', skipReason: 'DEPENDENCY_FAILED' })).toBe('FAILED');
    expect(state({ status: 'FAILED' })).toBe('FAILED');
    expect(state({ status: 'INTERRUPTED' })).toBe('FAILED');
  });

  it('runs analyze as plan then view on a handoff', () => {
    expect(names(readyNodes(analyze, view({})))).toEqual(['prompt']);
    const planned = view({
      prompt: { status: 'SUCCEEDED' },
      plan: { status: 'SUCCEEDED', result: { action: 'HANDOFF' } },
    });
    expect(names(readyNodes(analyze, planned))).toEqual(['view']);
  });

  it('skips view as NOT_TAKEN when plan finishes by itself', () => {
    const planned = view({
      prompt: { status: 'SUCCEEDED' },
      plan: { status: 'SUCCEEDED', result: { action: 'FINISH' } },
    });
    expect(readyNodes(analyze, planned)).toEqual([]);
    expect(skippedNodes(analyze, planned).map(({ node: n, reason }) => [n.name, reason])).toEqual([
      ['view', 'NOT_TAKEN'],
    ]);
  });

  it('waits for every predecessor before skipping, and failure outranks not-taken', () => {
    const graph: Graph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'c', { kind: 'CONDITIONAL', when: handoff }), edge('b', 'c')],
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

describe('validateExtension', () => {
  const rules = { builtInAgents: new Set(['main']), allowConditions: false };
  const empty: Graph = { nodes: [], edges: [] };
  const proposed = (name: string, agentId = 'main') => ({ node: node(name), agentId });

  it('accepts a valid extension', () => {
    const extension = { nodes: [proposed('a'), proposed('b')], edges: [edge('a', 'b')] };
    expect(validateExtension(empty, extension, rules)).toEqual([]);
  });

  it('reports each kind of error', () => {
    const code = (nodes: ReturnType<typeof proposed>[], edges: GraphEdge[] = []): unknown =>
      validateExtension(empty, { nodes, edges }, rules).map((error) => error.code);
    expect(code([proposed('a'), proposed('a')])).toContain('DUPLICATE_NODE');
    expect(code([proposed('a')], [edge('x', 'a')])).toContain('UNKNOWN_DEPENDENCY');
    expect(code([proposed('a', 'unknown')])).toEqual(['UNKNOWN_AGENT']);
    expect(code([proposed('a'), proposed('b')], [edge('a', 'b'), edge('b', 'a')])).toEqual([
      'CYCLE',
    ]);
    expect(
      code(
        [proposed('a'), proposed('b')],
        [edge('a', 'b', { kind: 'CONDITIONAL', when: handoff })],
      ),
    ).toEqual(['CONDITION_NOT_ALLOWED']);
    expect(code([{ node: node('m', { kind: 'INTEGRATE' }), agentId: 'main' }])).toEqual([
      'UNSUPPORTED_NODE_KIND',
    ]);
  });

  it('allows conditions when the rules do', () => {
    const extension = {
      nodes: [proposed('a'), proposed('b')],
      edges: [edge('a', 'b', { kind: 'CONDITIONAL', when: handoff })],
    };
    expect(validateExtension(empty, extension, { ...rules, allowConditions: true })).toEqual([]);
  });

  it('checks the extension against the existing graph', () => {
    const current: Graph = { nodes: [node('a')], edges: [] };
    expect(
      validateExtension(current, { nodes: [proposed('a')], edges: [] }, rules).map((e) => e.code),
    ).toEqual(['DUPLICATE_NODE']);
    expect(
      validateExtension(current, { nodes: [proposed('b')], edges: [edge('a', 'b')] }, rules),
    ).toEqual([]);
  });
});

describe('loops (M2Design 3.2)', () => {
  const body = { loopId: 'l1' };
  const graph: Graph = {
    nodes: [node('t', body), node('s', body), node('after'), node('unrelated')],
    edges: [edge('t', 's'), edge('s', 'after')],
  };
  const loop: LoopEdge = {
    loopId: 'l1',
    source: 's',
    target: 't',
    maxIterations: 2,
    when: { field: 'verdict', equals: 'reject' },
  };
  const source = graph.nodes[1] as GraphNode;
  const copyId = (name: string, iteration: number): string => `${name}#${String(iteration)}`;
  const rejected = view({ s: { status: 'SUCCEEDED', result: { verdict: 'reject' } } });

  it('finds the nodes on the paths from target to source', () => {
    expect(names(loopBody(graph, loop))).toEqual(['t', 's']);
  });

  it('expands the body with the copied target depending on the source', () => {
    const decision = decideLoop(graph, loop, source, rejected, copyId);
    expect(decision).toMatchObject({
      action: 'EXPAND',
      extension: {
        nodes: [
          { node: { nodeId: 't#2', iteration: 2 } },
          { node: { nodeId: 's#2', iteration: 2 } },
        ],
        edges: [edge('s', 't#2'), edge('t#2', 's#2')],
      },
    });
  });

  it('does not expand on success of the condition being false, or on failure', () => {
    const approved = view({ s: { status: 'SUCCEEDED', result: { verdict: 'approve' } } });
    expect(decideLoop(graph, loop, source, approved, copyId)).toEqual({ action: 'NONE' });
    expect(decideLoop(graph, loop, source, view({ s: { status: 'FAILED' } }), copyId)).toEqual({
      action: 'NONE',
    });
  });

  it('is exhausted at maxIterations', () => {
    const secondGraph: Graph = {
      ...graph,
      nodes: [...graph.nodes, node('s#2', { name: 's', iteration: 2, ...body })],
    };
    const secondSource = secondGraph.nodes[4] as GraphNode;
    const secondRejected = view({ 's#2': { status: 'SUCCEEDED', result: { verdict: 'reject' } } });
    expect(decideLoop(secondGraph, loop, secondSource, secondRejected, copyId)).toEqual({
      action: 'EXHAUSTED',
    });
  });

  it('judges nodes outside the loop by its last iteration only', () => {
    const conditional = edge('s', 'after', {
      kind: 'CONDITIONAL',
      when: { field: 'verdict', equals: 'approve' },
    });
    const expanded: Graph = {
      nodes: [
        node('t', body),
        node('s', body),
        node('t#2', { name: 't', iteration: 2, ...body }),
        node('s#2', { name: 's', iteration: 2, ...body }),
        node('after'),
      ],
      edges: [edge('t', 's'), conditional, edge('s', 't#2'), edge('t#2', 's#2')],
    };
    const middle = view({
      t: { status: 'SUCCEEDED' },
      s: { status: 'SUCCEEDED', result: { verdict: 'reject' } },
      't#2': { status: 'RUNNING' },
    });
    expect(edgeState(expanded, conditional, middle)).toBe('WAITING');
    expect(skippedNodes(expanded, middle)).toEqual([]);
    const done = new Map(middle).set('t#2', { status: 'SUCCEEDED' }).set('s#2', {
      status: 'SUCCEEDED',
      result: { verdict: 'approve' },
    });
    expect(names(readyNodes(expanded, done))).toEqual(['after']);
  });
});

describe('node identifiers', () => {
  it('derives the same ID from the same path', () => {
    const path = nodePath('wfr_1', 2, 'review', 3);
    expect(path).toBe('wfr_1/2/review#3');
    expect(nodeIdOf(path)).toMatch(/^nod_[0-9a-f]{32}$/);
    expect(nodeIdOf(path)).toBe(nodeIdOf(nodePath('wfr_1', 2, 'review', 3)));
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
