/**
 * The TaskGraph as pure functions of what the session log records (M2Design 3.1-3.3): readiness
 * and skipping read only nodes, edges and how finished nodes ended, so replaying any log prefix
 * gives the same answer as the run that wrote it.
 */
import { pathDerivedId } from '@multiagentos/contracts';

export type NodeKind = 'AGENT' | 'HUMAN';
export type Trigger = 'all_success' | 'all_done';
export type NodeStatus =
  | 'PENDING'
  | 'RUNNING'
  /**
   * Running, with a call it dispatched that has not come back (M2Design 3.1). It is only a state of
   * the node, read from the edges and the log: the AgentRun does not know it. While it lasts the
   * node submits no new Unit.
   */
  | 'WAITING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED'
  | 'INTERRUPTED'
  /**
   * The segment went to wait before its work was done (Orchestration 3.3): ended for the node,
   * not for its task. An edge from it reads the segment that took over (`CONTINUES`).
   */
  | 'YIELDED';

/** Ended for good: nothing more happens to the node. */
export const isTerminal = (status: NodeStatus): boolean =>
  status !== 'PENDING' && status !== 'RUNNING' && status !== 'WAITING';
export type SkipReason = 'DEPENDENCY_FAILED';

export interface GraphNode {
  readonly nodeId: string;
  /** Unique within its revision. */
  readonly name: string;
  readonly kind: NodeKind;
  readonly trigger: Trigger;
  /** Of an AGENT node: the task it is a segment of (Orchestration 3.2). */
  readonly missionId?: string;
}

/** The call a `DELEGATE` or `RESUME` edge belongs to: the model's tool call and the Kernel's reservation. */
export interface EdgeCall {
  readonly toolCallId: string;
  /** Only a call to SubAgents has one: the Kernel's reservation that funds it. */
  readonly delegationId?: string;
}

/**
 * `DEPENDS` decides when a node first starts. `DELEGATE` runs from a node that is
 * running to a node it dispatched, and `RESUME` back from that node to the caller, saying the call
 * came back. A `RESUME` edge does not start anything: it takes no part in readiness or in the check
 * for cycles (M2Design 3.1). What the caller does while it waits is the AgentRun's business.
 */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'DEPENDS' | 'DELEGATE' | 'RESUME' | 'CONTINUES';
  readonly call?: EdgeCall;
}

/**
 * The edges readiness reads. `CONTINUES` only says which segment took over a task: the segment it
 * leads to is ready the moment it is added (Orchestration 4.3).
 */
const decidesReadiness = (edge: GraphEdge): boolean =>
  edge.kind !== 'RESUME' && edge.kind !== 'CONTINUES';

export interface Graph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface NodeRecord {
  readonly status: NodeStatus;
  readonly skipReason?: SkipReason;
  /** The calls of this node that came back, by the tool call that made them. */
  readonly resumed?: readonly string[];
}

/** Nodes with no record are PENDING. */
export type NodeView = ReadonlyMap<string, NodeRecord>;

export type EdgeState = 'WAITING' | 'TAKEN' | 'FAILED';

export function nodeIdOf(path: string): string {
  return pathDerivedId('nod', path);
}

export function nodePath(workflowRunId: string, revision: number, name: string): string {
  return `${workflowRunId}/${String(revision)}/${name}`;
}

function statusOf(view: NodeView, nodeId: string): NodeRecord {
  return view.get(nodeId) ?? { status: 'PENDING' };
}

/**
 * The segment that stands for `node` now: a segment that slept is read through the segments that
 * took over its task, the last of them (Orchestration 3.3). Undefined while its task still sleeps.
 */
export function takenOver(graph: Graph, node: GraphNode, view: NodeView): GraphNode | undefined {
  let current: GraphNode | undefined = node;
  const seen = new Set<string>();
  while (current !== undefined && statusOf(view, current.nodeId).status === 'YIELDED') {
    if (seen.has(current.nodeId)) return undefined;
    seen.add(current.nodeId);
    const from: string = current.nodeId;
    const next = graph.edges.find((edge) => edge.kind === 'CONTINUES' && edge.from === from);
    current =
      next === undefined
        ? undefined
        : graph.nodes.find((candidate) => candidate.nodeId === next.to);
  }
  return current;
}

export function edgeState(graph: Graph, edge: GraphEdge, view: NodeView): EdgeState {
  const effective = graph.nodes.find((node) => node.nodeId === edge.from);
  // A DELEGATE edge reads its caller as it is: the segment that dispatched, not its successor.
  const source =
    effective === undefined || edge.kind === 'DELEGATE'
      ? effective
      : takenOver(graph, effective, view);
  if (source === undefined) return 'WAITING';
  const record = statusOf(view, source.nodeId);
  if (edge.kind === 'DELEGATE') {
    // Taken while the caller runs: it dispatched this node. A caller that went to sleep still
    // stands behind it (its task goes on, Orchestration 4.1); one that ended for good leaves nobody
    // to serve.
    if (record.status === 'YIELDED') return 'TAKEN';
    if (isTerminal(record.status)) return 'FAILED';
    return record.status === 'RUNNING' || record.status === 'WAITING' ? 'TAKEN' : 'WAITING';
  }
  switch (record.status) {
    case 'PENDING':
    case 'RUNNING':
    case 'WAITING':
    case 'YIELDED':
      return 'WAITING';
    case 'SUCCEEDED':
      return 'TAKEN';
    case 'SKIPPED':
    case 'FAILED':
    case 'INTERRUPTED':
      return 'FAILED';
  }
}

function incomingStates(graph: Graph, node: GraphNode, view: NodeView): EdgeState[] {
  return graph.edges
    .filter((edge) => edge.to === node.nodeId && decidesReadiness(edge))
    .map((edge) => edgeState(graph, edge, view));
}

export interface Wake {
  readonly node: GraphNode;
  readonly call: EdgeCall;
}

/** The calls a node dispatched, with the nodes that answer each, in the order of the edges. */
function callsOf(graph: Graph, nodeId: string): { call: EdgeCall; sources: string[] }[] {
  const calls = new Map<string, { call: EdgeCall; sources: string[] }>();
  for (const edge of graph.edges)
    if (edge.kind === 'RESUME' && edge.to === nodeId && edge.call !== undefined) {
      const entry = calls.get(edge.call.toolCallId) ?? { call: edge.call, sources: [] };
      entry.sources.push(edge.from);
      calls.set(edge.call.toolCallId, entry);
    }
  return [...calls.values()];
}

/**
 * A node that runs is WAITING while a call it dispatched has not come back, that is, while it has
 * a `DELEGATE` call without a `NODE_RESUMED` (M2Design 3.1). The status is read from the edges and
 * the records, never written down, so it cannot disagree with them.
 */
export function withWaiting(graph: Graph, view: NodeView): NodeView {
  const next = new Map(view);
  for (const node of graph.nodes) {
    const record = statusOf(view, node.nodeId);
    if (record.status !== 'RUNNING') continue;
    const open = callsOf(graph, node.nodeId).some(
      ({ call }) => !(record.resumed ?? []).includes(call.toolCallId),
    );
    if (open) next.set(node.nodeId, { ...record, status: 'WAITING' });
  }
  return next;
}

/**
 * The calls that came back: a waiting node whose `RESUME` edges of one call all start from nodes
 * that have ended, however they ended (`all_done`, M2Design 3.3). A pure function of the graph and
 * the view.
 */
export function wakeableNodes(graph: Graph, view: NodeView): readonly Wake[] {
  return graph.nodes.flatMap((node) => {
    const { status, resumed = [] } = statusOf(view, node.nodeId);
    if (status !== 'WAITING') return [];
    return callsOf(graph, node.nodeId)
      .filter(
        ({ call, sources }) =>
          !resumed.includes(call.toolCallId) &&
          sources.every((source) => isTerminal(statusOf(view, source).status)),
      )
      .map(({ call }) => ({ node, call }));
  });
}

export function readyNodes(graph: Graph, view: NodeView): readonly GraphNode[] {
  return graph.nodes.filter((node) => {
    if (statusOf(view, node.nodeId).status !== 'PENDING') return false;
    const states = incomingStates(graph, node, view);
    return node.trigger === 'all_success'
      ? states.every((state) => state === 'TAKEN')
      : !states.includes('WAITING');
  });
}

export interface SkippedNode {
  readonly node: GraphNode;
  readonly reason: SkipReason;
}

export function skippedNodes(graph: Graph, view: NodeView): readonly SkippedNode[] {
  return graph.nodes.flatMap((node) => {
    if (statusOf(view, node.nodeId).status !== 'PENDING' || node.trigger !== 'all_success')
      return [];
    const states = incomingStates(graph, node, view);
    if (states.includes('WAITING') || states.every((state) => state === 'TAKEN')) return [];
    return [{ node, reason: 'DEPENDENCY_FAILED' } as const];
  });
}

/** Records skips until none is left, since a skip passes downstream (M2Design 3.3, step 4). */
export function settleSkips(
  graph: Graph,
  view: NodeView,
): {
  readonly view: NodeView;
  readonly skipped: readonly SkippedNode[];
} {
  const settled = new Map(view);
  const skipped: SkippedNode[] = [];
  for (
    let next = skippedNodes(graph, settled);
    next.length > 0;
    next = skippedNodes(graph, settled)
  ) {
    for (const entry of next) {
      settled.set(entry.node.nodeId, { status: 'SKIPPED', skipReason: entry.reason });
      skipped.push(entry);
    }
  }
  return { view: settled, skipped };
}

/** What a template's graph can get wrong when it is compiled (Orchestration 3.5). */
export interface GraphValidationError {
  readonly code:
    | 'UNKNOWN_DEPENDENCY'
    /** Two steps of a template's root task could run at once. */
    | 'OWNER_NOT_LINEAR';
  readonly node?: string;
}
