import {
  newId,
  type GraphNodeRecord,
  type SessionLogRecord,
  type TemplateDefinition,
} from '@multiagentos/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { edgeState, readyNodes, settleSkips, takenOver } from './graph.js';
import type { Graph, GraphEdge, GraphNode, NodeRecord } from './graph.js';
import {
  childMissionId,
  childrenOf,
  projectMissions,
  rootMissionId,
  siblingsOf,
} from './mission-tree.js';
import {
  chatGrowthRevision,
  compileTemplate,
  initialChatRevision,
  spawnRevision,
  type GraphRevision,
} from './session-graph.js';

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

describe('a segment that slept (Orchestration 3.3)', () => {
  // `a1` is a task's first segment, `a2` the one that took over; `b` depends on the task.
  const graph: Graph = {
    nodes: [node('a1'), node('a2'), node('b')],
    edges: [edge('a1', 'b'), edge('a1', 'a2', { kind: 'CONTINUES' })],
  };
  const asleep: Graph = { nodes: [node('a1'), node('b')], edges: [edge('a1', 'b')] };

  it('holds a dependent back while the task sleeps, without skipping it', () => {
    const states = view({ a1: { status: 'YIELDED' } });
    expect(edgeState(asleep, edge('a1', 'b'), states)).toBe('WAITING');
    expect(readyNodes(asleep, states)).toEqual([]);
    expect(settleSkips(asleep, states).skipped).toEqual([]);
  });

  it('is read through the segment that took over, however many times it slept', () => {
    expect(edgeState(graph, edge('a1', 'b'), view({ a1: { status: 'YIELDED' } }))).toBe(
      'WAITING',
    );
    const done = view({ a1: { status: 'YIELDED' }, a2: { status: 'SUCCEEDED' } });
    expect(edgeState(graph, edge('a1', 'b'), done)).toBe('TAKEN');
    expect(readyNodes(graph, done).map((each) => each.name)).toEqual(['b']);
    const failed = view({ a1: { status: 'YIELDED' }, a2: { status: 'FAILED' } });
    expect(settleSkips(graph, failed).skipped.map((each) => each.node.name)).toEqual(['b']);
  });

  it('starts the segment that takes over at once: CONTINUES decides no readiness', () => {
    const states = view({ a1: { status: 'YIELDED' } });
    expect(readyNodes(graph, states).map((each) => each.name)).toEqual(['a2']);
  });

  it('keeps a caller that went to sleep behind the tasks it dispatched', () => {
    const spawned: Graph = {
      nodes: [node('caller'), node('task')],
      edges: [edge('caller', 'task', { kind: 'DELEGATE' })],
    };
    const delegate = edge('caller', 'task', { kind: 'DELEGATE' });
    expect(edgeState(spawned, delegate, view({ caller: { status: 'YIELDED' } }))).toBe('TAKEN');
    expect(edgeState(spawned, delegate, view({ caller: { status: 'FAILED' } }))).toBe('FAILED');
  });

  it('follows a chain of segments to the last, and stops on a loop of edges', () => {
    const chain: Graph = {
      nodes: [node('s1'), node('s2'), node('s3')],
      edges: [
        edge('s1', 's2', { kind: 'CONTINUES' }),
        edge('s2', 's3', { kind: 'CONTINUES' }),
      ],
    };
    const states = view({ s1: { status: 'YIELDED' }, s2: { status: 'YIELDED' } });
    expect(takenOver(chain, node('s1'), states)?.name).toBe('s3');
    const looped: Graph = {
      nodes: [node('x'), node('y')],
      edges: [edge('x', 'y', { kind: 'CONTINUES' }), edge('y', 'x', { kind: 'CONTINUES' })],
    };
    const both = view({ x: { status: 'YIELDED' }, y: { status: 'YIELDED' } });
    expect(takenOver(looped, node('x'), both)).toBeUndefined();
  });
});

const run = newId('wfr');
const session = newId('ses');
const mainRef = { id: 'main', version: 'v1.0.0' };
const workerRef = { id: 'worker', version: 'v1.0.0' };
const at = '2026-11-12T00:00:00.000Z';
let seq = 0;
const extended = (revision: number, content: GraphRevision): SessionLogRecord => ({
  type: 'GRAPH_EXTENDED',
  seq: ++seq,
  at,
  workflowRunId: run,
  revision,
  source: 'TEMPLATE',
  nodes: [...content.nodes],
  edges: [...content.edges],
});
const started = (nodeId: string): SessionLogRecord => ({
  type: 'NODE_STARTED',
  seq: ++seq,
  at,
  workflowRunId: run,
  nodeId,
  path: 'p',
});
const agentOf = (revision: GraphRevision, name: string): GraphNodeRecord => {
  const found = revision.nodes.find((each) => each.name === name && each.kind === 'AGENT');
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};
const spec = (name: string) => ({
  name,
  agentRef: workerRef,
  goal: `do ${name}`,
  dependsOn: [],
  spawn: { writeScope: [name], acceptance: [], inputs: [], tokens: 1000 },
});

describe('the MissionTree read from the graph (Orchestration 3.1, 3.2)', () => {
  const root = rootMissionId(session, 'chat');

  it('makes every main of a chat a step of one root task, across runs', () => {
    expect(rootMissionId(session, 'chat')).toBe(root);
    expect(rootMissionId(newId('ses'), 'chat')).not.toBe(root);
    const first = initialChatRevision(run, mainRef, root);
    const main1 = agentOf(first, 'main');
    const growth = chatGrowthRevision(run, 2, main1.nodeId, mainRef, root);
    const main2 = agentOf(growth, 'main');
    const missions = projectMissions([
      extended(1, first),
      started(main1.nodeId),
      extended(2, growth),
      started(main2.nodeId),
    ]);
    expect([...missions.keys()]).toEqual([root]);
    const mission = missions.get(root);
    expect(mission?.segments).toEqual([main1.nodeId, main2.nodeId]);
    expect(mission?.depth).toBe(0);
    expect(mission?.parentId).toBeUndefined();
    expect(mission?.name).toBe('main');
  });

  it('puts the tasks of run_subagents below the task of their caller, by name and call', () => {
    const first = initialChatRevision(run, mainRef, root);
    const caller = agentOf(first, 'main');
    const spawned = spawnRevision(
      run,
      2,
      { nodeId: caller.nodeId, call: { toolCallId: 'call_1' }, missionId: root },
      [spec('api'), spec('ui')],
    );
    const api = agentOf(spawned, 'api');
    expect(api.mission).toEqual({ id: childMissionId(root, 'call_1', 'api'), parentId: root });
    const missions = projectMissions([extended(1, first), extended(2, spawned)]);
    expect(childrenOf(missions, root).map((each) => each.name)).toEqual(['api', 'ui']);
    expect(siblingsOf(missions, childMissionId(root, 'call_1', 'api')).map((m) => m.name)).toEqual(
      ['ui'],
    );
    expect(missions.get(childMissionId(root, 'call_1', 'ui'))?.depth).toBe(1);
    expect(missions.get(childMissionId(root, 'call_1', 'ui'))?.agentId).toBe('worker');
    // Same names in another call are other tasks.
    expect(childMissionId(root, 'call_2', 'api')).not.toBe(childMissionId(root, 'call_1', 'api'));
  });

  it('says a task has ended only from MISSION_ENDED', () => {
    const first = initialChatRevision(run, mainRef, root);
    const records = [
      extended(1, first),
      {
        type: 'MISSION_ENDED',
        seq: ++seq,
        at,
        workflowRunId: run,
        missionId: root,
        status: 'SUCCEEDED',
      } as const,
    ];
    expect(projectMissions(records.slice(0, 1)).get(root)?.ended).toBeUndefined();
    expect(projectMissions(records).get(root)?.ended).toBe('SUCCEEDED');
  });

  it('makes the first AGENT node of a template the root and the others tasks below it', () => {
    const template: TemplateDefinition = {
      schemaVersion: 'v1',
      kind: 'TEMPLATE',
      id: 'analyze',
      version: 'v1.0.0',
      description: 'plan then view',
      nodes: [
        { name: 'plan', kind: 'AGENT', agent: { id: 'planner', version: 'v1.0.0' } },
        {
          name: 'view',
          kind: 'AGENT',
          agent: { id: 'code-viewer', version: 'v1.0.0' },
          dependsOn: ['plan'],
        },
      ],
      origin: 'BUILT_IN',
      digest: 'a'.repeat(64),
    } as unknown as TemplateDefinition;
    const templateRoot = rootMissionId(session, 'analyze');
    const { revision } = compileTemplate(run, template, templateRoot);
    expect(agentOf(revision, 'plan').mission).toEqual({ id: templateRoot });
    expect(agentOf(revision, 'view').mission?.parentId).toBe(templateRoot);
    const missions = projectMissions([extended(1, revision)]);
    expect(childrenOf(missions, templateRoot).map((each) => each.name)).toEqual(['view']);
  });

  it('gives the same tree for every prefix of the log as it grows (replay)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), (steps) => {
        const records: SessionLogRecord[] = [];
        let current = initialChatRevision(run, mainRef, root);
        records.push(extended(1, current));
        for (let index = 0; index < steps; index += 1) {
          const agent = agentOf(current, 'main');
          records.push(started(agent.nodeId));
          current = chatGrowthRevision(run, index + 2, agent.nodeId, mainRef, root);
          records.push(extended(index + 2, current));
        }
        const all = projectMissions(records);
        expect(all.get(root)?.segments).toHaveLength(steps);
        for (let end = 1; end <= records.length; end += 1) {
          const prefix = projectMissions(records.slice(0, end));
          expect([...prefix.keys()]).toEqual([root]);
        }
      }),
    );
  });
});
