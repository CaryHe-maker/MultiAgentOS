import type {
  DefinitionRef,
  GraphEdgeRecord,
  GraphNodeRecord,
  SessionLogRecord,
  TemplateDefinition,
} from '@multiagentos/contracts';
import {
  isTerminal,
  nodeIdOf,
  nodePath,
  readyNodes,
  settleSkips,
  validateExtension,
  wakeableNodes,
  withWaiting,
  type EdgeCall,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type GraphValidationError,
  type NodeRecord,
  type NodeView,
  type SkippedNode,
  type Wake,
} from './graph.js';
import { childMissionId, templateMissionId } from './mission-tree.js';

/**
 * The TaskGraph as the session log records it (M2Design 3.2, 3.8): building revisions for `chat`
 * and built-in templates, and reading the graph and node states back from the records.
 */
export interface GraphRevision {
  readonly nodes: readonly GraphNodeRecord[];
  readonly edges: readonly GraphEdgeRecord[];
}

interface NodeSpec {
  readonly name: string;
  readonly kind: 'AGENT' | 'HUMAN';
  readonly trigger?: GraphNodeRecord['trigger'];
  readonly agentRef?: DefinitionRef;
  readonly goal?: string;
  readonly inputFrom?: 'HANDOFF';
  readonly output?: boolean;
  readonly spawn?: GraphNodeRecord['spawn'];
  readonly ask?: GraphNodeRecord['ask'];
  readonly mission?: GraphNodeRecord['mission'];
}

function nodeOf(workflowRunId: string, revision: number, spec: NodeSpec): GraphNodeRecord {
  const path = nodePath(workflowRunId, revision, spec.name, 1);
  return {
    nodeId: nodeIdOf(path),
    path,
    name: spec.name,
    kind: spec.kind,
    trigger: spec.trigger ?? 'all_success',
    iteration: 1,
    ...(spec.agentRef === undefined ? {} : { agentRef: spec.agentRef }),
    ...(spec.goal === undefined ? {} : { goal: spec.goal }),
    ...(spec.inputFrom === undefined ? {} : { inputFrom: spec.inputFrom }),
    ...(spec.output === undefined ? {} : { output: spec.output }),
    ...(spec.spawn === undefined ? {} : { spawn: spec.spawn }),
    ...(spec.ask === undefined ? {} : { ask: spec.ask }),
    ...(spec.mission === undefined ? {} : { mission: spec.mission }),
  };
}

const depends = (from: GraphNodeRecord, to: GraphNodeRecord): GraphEdgeRecord => ({
  from: from.nodeId,
  to: to.nodeId,
  kind: 'DEPENDS',
});

/**
 * `HUMAN(prompt) -> main`, the first revision of a Turn-chat run. Every main is a step of the one
 * root task of the chat (Orchestration 3.5), whose id the Session gives.
 */
export function initialChatRevision(
  workflowRunId: string,
  mainRef: DefinitionRef,
  rootMission: string,
): GraphRevision {
  const prompt = nodeOf(workflowRunId, 1, { name: 'prompt', kind: 'HUMAN' });
  const main = nodeOf(workflowRunId, 1, {
    name: 'main',
    kind: 'AGENT',
    agentRef: mainRef,
    mission: { id: rootMission },
  });
  return { nodes: [prompt, main], edges: [depends(prompt, main)] };
}

/**
 * The pair `chat` adds whenever main ended, however it ended: the next open input runs under
 * `all_done`, so a failed or interrupted main does not end the conversation (M2Design 3.1).
 */
export function chatGrowthRevision(
  workflowRunId: string,
  revision: number,
  endedMainNodeId: string,
  mainRef: DefinitionRef,
  rootMission: string,
): GraphRevision {
  const prompt = nodeOf(workflowRunId, revision, {
    name: 'prompt',
    kind: 'HUMAN',
    trigger: 'all_done',
  });
  const main = nodeOf(workflowRunId, revision, {
    name: 'main',
    kind: 'AGENT',
    agentRef: mainRef,
    mission: { id: rootMission },
  });
  return {
    nodes: [prompt, main],
    edges: [{ from: endedMainNodeId, to: prompt.nodeId, kind: 'DEPENDS' }, depends(prompt, main)],
  };
}

/** One task of `run_subagents` as the graph holds it. */
export interface SpawnTaskSpec {
  readonly name: string;
  readonly agentRef: DefinitionRef;
  readonly goal: string;
  readonly dependsOn: readonly string[];
  readonly spawn: NonNullable<GraphNodeRecord['spawn']>;
}

/** The segment that dispatches the tasks of a call, and the task it is a segment of. */
export interface Caller {
  readonly nodeId: string;
  readonly call: EdgeCall;
  readonly missionId: string;
}

/**
 * The revision a `run_subagents` call adds (M2Design 3.1, 3.6): one node per task, in the order the
 * caller wrote them; `DEPENDS` between tasks; from the caller to each task a `DELEGATE` edge, and
 * back from each a `RESUME` edge. The caller waits, so it is the last link of the tasks it started.
 */
export function spawnRevision(
  workflowRunId: string,
  revision: number,
  caller: Caller,
  tasks: readonly SpawnTaskSpec[],
): GraphRevision {
  const nodes = tasks.map((task) =>
    nodeOf(workflowRunId, revision, {
      name: task.name,
      kind: 'AGENT',
      agentRef: task.agentRef,
      goal: task.goal,
      spawn: task.spawn,
      mission: {
        id: childMissionId(caller.missionId, caller.call.toolCallId, task.name),
        parentId: caller.missionId,
      },
    }),
  );
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const dependencies = tasks.flatMap((task) =>
    task.dependsOn.flatMap((name) => {
      const from = byName.get(name);
      const to = byName.get(task.name);
      return from === undefined || to === undefined ? [] : [depends(from, to)];
    }),
  );
  // The caller does not wait on an edge: it goes on, or sleeps until its tasks end (D14).
  const calls = nodes.map((node): GraphEdgeRecord => ({
    from: caller.nodeId,
    to: node.nodeId,
    kind: 'DELEGATE',
    call: caller.call,
  }));
  return { nodes, edges: [...dependencies, ...calls] };
}

/**
 * The segment that takes over a task that slept (Orchestration 4.3): the same task, Agent and
 * goal, joined to the segment it follows by a `CONTINUES` edge. It is ready the moment it is added.
 */
export function continuationRevision(
  workflowRunId: string,
  revision: number,
  yielded: GraphNodeRecord,
): GraphRevision {
  const node = nodeOf(workflowRunId, revision, {
    name: yielded.name,
    kind: 'AGENT',
    ...(yielded.agentRef === undefined ? {} : { agentRef: yielded.agentRef }),
    ...(yielded.goal === undefined ? {} : { goal: yielded.goal }),
    ...(yielded.mission === undefined ? {} : { mission: yielded.mission }),
  });
  return {
    nodes: [node],
    edges: [{ from: yielded.nodeId, to: node.nodeId, kind: 'CONTINUES' }],
  };
}

/**
 * The revision an `ask_user` call adds (M2Design 3.1, 3.4): one HUMAN node that asks, joined to the
 * caller by the same pair of edges as a task, so the caller waits for the answer like it waits for a
 * SubAgent. The call has no reservation behind it, so its edges carry the tool call alone.
 */
export function askRevision(
  workflowRunId: string,
  revision: number,
  caller: { readonly nodeId: string; readonly toolCallId: string },
  ask: NonNullable<GraphNodeRecord['ask']>,
): GraphRevision {
  const node = nodeOf(workflowRunId, revision, { name: 'ask', kind: 'HUMAN', ask });
  const call = { toolCallId: caller.toolCallId };
  return {
    nodes: [node],
    edges: [
      { from: caller.nodeId, to: node.nodeId, kind: 'DELEGATE', call },
      { from: node.nodeId, to: caller.nodeId, kind: 'RESUME', call },
    ],
  };
}

/**
 * The HUMAN(steer) node of a note slipped in while the run goes on (M2Design 4.5): made and ended
 * in one step, with no edge, so nothing waits for it and no readiness follows from it. Whom it is
 * for stands in the log (`HUMAN_ANSWERED.attachedAgentRunId`), not in the graph.
 */
export function steerRevision(workflowRunId: string, revision: number): GraphRevision {
  return { nodes: [nodeOf(workflowRunId, revision, { name: 'steer', kind: 'HUMAN' })], edges: [] };
}

/** Adds the root `HUMAN(prompt)`, which every node without a predecessor depends on (3.8). */
export function compileTemplate(
  workflowRunId: string,
  template: TemplateDefinition,
  rootMission: string,
): { readonly revision: GraphRevision; readonly errors: readonly GraphValidationError[] } {
  const root = nodeOf(workflowRunId, 1, { name: 'prompt', kind: 'HUMAN' });
  const byName = new Map<string, GraphNodeRecord>();
  const owners = ownerSteps(template);
  for (const node of template.nodes) {
    byName.set(
      node.name,
      node.kind === 'AGENT'
        ? nodeOf(workflowRunId, 1, {
            name: node.name,
            kind: 'AGENT',
            agentRef: node.agent,
            mission: owners.has(node.name)
              ? { id: rootMission }
              : { id: templateMissionId(rootMission, node.name, 1), parentId: rootMission },
            ...(node.goal === undefined ? {} : { goal: node.goal }),
            ...(node.inputFrom === undefined ? {} : { inputFrom: node.inputFrom }),
            ...(node.output === undefined ? {} : { output: node.output }),
          })
        : nodeOf(workflowRunId, 1, { name: node.name, kind: 'HUMAN' }),
    );
  }
  const edges: GraphEdgeRecord[] = [];
  const errors: GraphValidationError[] = [];
  for (const node of template.nodes) {
    const target = byName.get(node.name);
    if (target === undefined) continue;
    const dependencies = node.kind === 'AGENT' ? (node.dependsOn ?? []) : [];
    if (dependencies.length === 0) edges.push(depends(root, target));
    for (const dependency of dependencies) {
      const name = typeof dependency === 'string' ? dependency : dependency.node;
      const source = byName.get(name);
      if (source === undefined) {
        errors.push({ code: 'UNKNOWN_DEPENDENCY', node: node.name });
      } else if (typeof dependency === 'string') {
        edges.push(depends(source, target));
      } else {
        const { field, equals, in: anyOf } = dependency.when;
        edges.push({
          from: source.nodeId,
          to: target.nodeId,
          kind: 'CONDITIONAL',
          when: {
            field,
            ...(equals === undefined ? {} : { equals }),
            ...(anyOf === undefined ? {} : { in: [...anyOf] }),
          },
        });
      }
    }
  }
  errors.push(...ownerOrderErrors(template, owners));
  return { revision: { nodes: [root, ...byName.values()], edges }, errors };
}

/**
 * The steps of a template's root task (Orchestration 3.5): the nodes marked `role: owner` when the
 * template names its owner; otherwise its first AGENT node alone. Every other AGENT node is a task
 * below the root.
 */
export function ownerSteps(template: TemplateDefinition): ReadonlySet<string> {
  const agents = template.nodes.filter((node) => node.kind === 'AGENT');
  if (template.owner === undefined) return new Set(agents.slice(0, 1).map((node) => node.name));
  return new Set(
    agents.filter((node) => node.kind === 'AGENT' && node.role === 'owner').map((n) => n.name),
  );
}

/**
 * The steps of the root task must follow one another: any two of them are joined by a path of
 * dependencies, so the root never has two segments that could run at once (Orchestration 3.5).
 */
function ownerOrderErrors(
  template: TemplateDefinition,
  owners: ReadonlySet<string>,
): GraphValidationError[] {
  const before = new Map<string, readonly string[]>();
  for (const node of template.nodes)
    if (node.kind === 'AGENT')
      before.set(
        node.name,
        (node.dependsOn ?? []).map((each) => (typeof each === 'string' ? each : each.node)),
      );
  const ancestors = (name: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(before.get(name) ?? [])];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(before.get(next) ?? []));
    }
    return seen;
  };
  const steps = [...owners];
  const errors: GraphValidationError[] = [];
  if (template.owner !== undefined && steps.length === 0) errors.push({ code: 'OWNER_NOT_LINEAR' });
  for (const [index, left] of steps.entries())
    for (const right of steps.slice(index + 1))
      if (!ancestors(left).has(right) && !ancestors(right).has(left))
        errors.push({ code: 'OWNER_NOT_LINEAR', node: right });
  return errors;
}

const toGraphEdge = ({ from, to, kind, when, call }: GraphEdgeRecord): GraphEdge => ({
  from,
  to,
  kind,
  ...(when === undefined ? {} : { when }),
  ...(call === undefined ? {} : { call }),
});

const toGraphNode = (node: GraphNodeRecord): GraphNode => ({
  nodeId: node.nodeId,
  name: node.name,
  kind: node.kind,
  trigger: node.trigger,
  iteration: node.iteration,
  ...(node.loopId === undefined ? {} : { loopId: node.loopId }),
  ...(node.mission === undefined ? {} : { missionId: node.mission.id }),
});

/** The rules of an extension; the same function checks every extension (Module/Workflow 6.1). */
export function validateRevision(
  current: Graph,
  revision: GraphRevision,
  rules: { readonly builtInAgents: ReadonlySet<string>; readonly allowConditions: boolean },
): readonly GraphValidationError[] {
  return validateExtension(
    current,
    {
      nodes: revision.nodes.map((node) => ({
        node: toGraphNode(node),
        ...(node.agentRef === undefined ? {} : { agentId: node.agentRef.id }),
      })),
      edges: revision.edges.map(toGraphEdge),
    },
    rules,
  );
}

export interface ProjectedGraph {
  readonly graph: Graph;
  readonly view: NodeView;
  readonly nodes: ReadonlyMap<string, GraphNodeRecord>;
  readonly lastRevision: number;
}

/** The graph of one run at any log prefix: a pure function of the records. */
export function projectGraph(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
): ProjectedGraph {
  const nodes = new Map<string, GraphNodeRecord>();
  const edges: GraphEdgeRecord[] = [];
  const view = new Map<string, NodeRecord>();
  let lastRevision = 0;
  for (const record of records) {
    if (!('workflowRunId' in record) || record.workflowRunId !== workflowRunId) continue;
    if (record.type === 'GRAPH_EXTENDED') {
      lastRevision = record.revision;
      for (const node of record.nodes) nodes.set(node.nodeId, node);
      edges.push(...record.edges);
    } else if (record.type === 'NODE_STARTED') {
      view.set(record.nodeId, { status: 'RUNNING' });
    } else if (record.type === 'NODE_RESUMED') {
      const before = view.get(record.nodeId);
      view.set(record.nodeId, {
        status: 'RUNNING',
        resumed: [...(before?.resumed ?? []), record.call.toolCallId],
      });
    } else if (record.type === 'NODE_ENDED') {
      view.set(record.nodeId, {
        status: record.status,
        ...(record.skipReason === undefined ? {} : { skipReason: record.skipReason }),
        ...(record.result === undefined ? {} : { result: record.result }),
      });
    }
  }
  const graph: Graph = {
    nodes: [...nodes.values()].map(toGraphNode),
    edges: edges.map(toGraphEdge),
  };
  return { graph, view: withWaiting(graph, view), nodes, lastRevision };
}

export interface Advance {
  readonly skipped: readonly SkippedNode[];
  readonly ready: readonly GraphNode[];
  /** Nodes that wait and whose call is over (M2Design 3.3). */
  readonly wake: readonly Wake[];
}

/** Steps 4 and 5 of M2Design 3.3: skips first, because they can change what is ready. */
export function advanceGraph(graph: Graph, view: NodeView): Advance {
  const settled = settleSkips(graph, view);
  return {
    skipped: settled.skipped,
    ready: readyNodes(graph, settled.view),
    wake: wakeableNodes(graph, settled.view),
  };
}

/** The main node that ended without a next prompt yet, which is when `chat` grows. */
export function chatGrowthPoint(projected: ProjectedGraph): string | undefined {
  const { graph, view, nodes } = projected;
  return graph.nodes.find(
    (node) =>
      isTerminal(view.get(node.nodeId)?.status ?? 'PENDING') &&
      // A main that went to sleep is not done: the segment that takes over it is.
      view.get(node.nodeId)?.status !== 'YIELDED' &&
      // Only a step of the root task grows a chat; a segment of a task below never does.
      nodes.get(node.nodeId)?.mission?.parentId === undefined &&
      nodes.get(node.nodeId)?.kind === 'AGENT' &&
      // Nothing follows it by dependency: a call that leads on to tasks is no next step.
      !graph.edges.some(
        (edge) =>
          edge.from === node.nodeId && (edge.kind === 'DEPENDS' || edge.kind === 'CONDITIONAL'),
      ) &&
      // A task answers to its caller; only what no call started can be a main.
      !graph.edges.some((edge) => edge.to === node.nodeId && edge.kind === 'DELEGATE'),
  )?.nodeId;
}
