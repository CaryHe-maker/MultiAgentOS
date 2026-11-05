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
  };
}

const depends = (from: GraphNodeRecord, to: GraphNodeRecord): GraphEdgeRecord => ({
  from: from.nodeId,
  to: to.nodeId,
  kind: 'DEPENDS',
});

/** `HUMAN(prompt) -> main`, the first revision of a Turn-chat run. */
export function initialChatRevision(workflowRunId: string, mainRef: DefinitionRef): GraphRevision {
  const prompt = nodeOf(workflowRunId, 1, { name: 'prompt', kind: 'HUMAN' });
  const main = nodeOf(workflowRunId, 1, { name: 'main', kind: 'AGENT', agentRef: mainRef });
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
): GraphRevision {
  const prompt = nodeOf(workflowRunId, revision, {
    name: 'prompt',
    kind: 'HUMAN',
    trigger: 'all_done',
  });
  const main = nodeOf(workflowRunId, revision, { name: 'main', kind: 'AGENT', agentRef: mainRef });
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

/** The AgentRun that dispatches the tasks of a call, and waits for them. */
export interface Caller {
  readonly nodeId: string;
  readonly call: EdgeCall;
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
  const calls = nodes.flatMap((node): GraphEdgeRecord[] => [
    { from: caller.nodeId, to: node.nodeId, kind: 'DELEGATE', call: caller.call },
    { from: node.nodeId, to: caller.nodeId, kind: 'RESUME', call: caller.call },
  ]);
  return { nodes, edges: [...dependencies, ...calls] };
}

/** Adds the root `HUMAN(prompt)`, which every node without a predecessor depends on (3.8). */
export function compileTemplate(
  workflowRunId: string,
  template: TemplateDefinition,
): { readonly revision: GraphRevision; readonly errors: readonly GraphValidationError[] } {
  const root = nodeOf(workflowRunId, 1, { name: 'prompt', kind: 'HUMAN' });
  const byName = new Map<string, GraphNodeRecord>();
  for (const node of template.nodes) {
    byName.set(
      node.name,
      node.kind === 'AGENT'
        ? nodeOf(workflowRunId, 1, {
            name: node.name,
            kind: 'AGENT',
            agentRef: node.agent,
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
  return { revision: { nodes: [root, ...byName.values()], edges }, errors };
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
});

/** Stage 1 rules; later stages widen them in the same function (Module/Workflow 6.1). */
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
