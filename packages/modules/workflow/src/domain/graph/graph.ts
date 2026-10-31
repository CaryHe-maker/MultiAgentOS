import { createHash } from 'node:crypto';

/**
 * The TaskGraph as pure functions of what the session log records (M2Design 3.1-3.3): readiness,
 * skipping and loop expansion read only nodes, edges and finished nodes' structured results, so
 * replaying any log prefix gives the same answer as the run that wrote it.
 */
export type NodeKind = 'AGENT' | 'HUMAN';
export type Trigger = 'all_success' | 'all_done';
export type NodeStatus =
  'PENDING' | 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'INTERRUPTED';
export type SkipReason = 'DEPENDENCY_FAILED' | 'NOT_TAKEN';

export interface GraphNode {
  readonly nodeId: string;
  /** Name within its revision; unique together with `iteration`. */
  readonly name: string;
  readonly kind: NodeKind | 'INTEGRATE';
  readonly trigger: Trigger;
  readonly iteration: number;
  /** The loop whose body holds this node; absent outside loops. */
  readonly loopId?: string;
}

export interface EdgeCondition {
  readonly field: string;
  readonly equals?: string | boolean;
  readonly in?: readonly (string | boolean)[];
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'DEPENDS' | 'CONDITIONAL';
  readonly when?: EdgeCondition;
}

/** A back edge from `source` to its ancestor `target`; never part of readiness (M2Design 3.2). */
export interface LoopEdge {
  readonly loopId: string;
  readonly source: string;
  readonly target: string;
  readonly maxIterations: number;
  readonly when?: EdgeCondition;
}

export interface Graph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface NodeRecord {
  readonly status: NodeStatus;
  readonly skipReason?: SkipReason;
  /** The structured result conditions read: a confirmation, a review, a planner's `action`. */
  readonly result?: unknown;
}

/** Nodes with no record are PENDING. */
export type NodeView = ReadonlyMap<string, NodeRecord>;

export type EdgeState = 'WAITING' | 'TAKEN' | 'NOT_TAKEN' | 'FAILED';

export function nodeIdOf(path: string): string {
  return `nod_${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 32)}`;
}

export function nodePath(
  workflowRunId: string,
  revision: number,
  name: string,
  iteration: number,
): string {
  return `${workflowRunId}/${String(revision)}/${name}#${String(iteration)}`;
}

/** Evaluates a declarative predicate; a missing field never satisfies it. */
export function conditionHolds(condition: EdgeCondition, result: unknown): boolean {
  let value: unknown = result;
  for (const key of condition.field.split('.')) {
    if (typeof value !== 'object' || value === null) return false;
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value !== 'string' && typeof value !== 'boolean') return false;
  return condition.in !== undefined ? condition.in.includes(value) : condition.equals === value;
}

function statusOf(view: NodeView, nodeId: string): NodeRecord {
  return view.get(nodeId) ?? { status: 'PENDING' };
}

/**
 * The predecessor an edge reads. A node outside a loop depends on the loop's last iteration, so
 * an iteration that will be expanded never skips it (M2Design 3.2).
 */
function effectiveSource(graph: Graph, edge: GraphEdge): GraphNode | undefined {
  const source = graph.nodes.find((node) => node.nodeId === edge.from);
  const target = graph.nodes.find((node) => node.nodeId === edge.to);
  if (source === undefined || source.loopId === undefined || source.loopId === target?.loopId) {
    return source;
  }
  return graph.nodes
    .filter((node) => node.name === source.name && node.loopId === source.loopId)
    .reduce((last, node) => (node.iteration > last.iteration ? node : last), source);
}

export function edgeState(graph: Graph, edge: GraphEdge, view: NodeView): EdgeState {
  const source = effectiveSource(graph, edge);
  if (source === undefined) return 'WAITING';
  const record = statusOf(view, source.nodeId);
  switch (record.status) {
    case 'PENDING':
    case 'READY':
    case 'RUNNING':
      return 'WAITING';
    case 'SUCCEEDED':
      return edge.when === undefined || conditionHolds(edge.when, record.result)
        ? 'TAKEN'
        : 'NOT_TAKEN';
    case 'SKIPPED':
      return record.skipReason === 'NOT_TAKEN' ? 'NOT_TAKEN' : 'FAILED';
    case 'FAILED':
    case 'INTERRUPTED':
      return 'FAILED';
  }
}

function incomingStates(graph: Graph, node: GraphNode, view: NodeView): EdgeState[] {
  return graph.edges
    .filter((edge) => edge.to === node.nodeId)
    .map((edge) => edgeState(graph, edge, view));
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
    return [
      { node, reason: states.includes('FAILED') ? 'DEPENDENCY_FAILED' : 'NOT_TAKEN' } as const,
    ];
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

export type GraphValidationCode =
  | 'DUPLICATE_NODE'
  | 'UNKNOWN_DEPENDENCY'
  | 'CYCLE'
  | 'UNKNOWN_AGENT'
  | 'CONDITION_NOT_ALLOWED'
  | 'UNSUPPORTED_NODE_KIND'
  | 'INVALID_LOOP';

export interface GraphValidationError {
  readonly code: GraphValidationCode;
  readonly node?: string;
}

export interface ProposedNode {
  readonly node: GraphNode;
  /** Absent for HUMAN nodes. */
  readonly agentId?: string;
}

export interface GraphExtension {
  readonly nodes: readonly ProposedNode[];
  readonly edges: readonly GraphEdge[];
}

export interface ExtensionRules {
  readonly builtInAgents: ReadonlySet<string>;
  /** Stage 1 allows conditional edges only in built-in templates. */
  readonly allowConditions: boolean;
}

/** Every revision goes through here, whatever its source (M2Design 3.2). */
export function validateExtension(
  current: Graph,
  extension: GraphExtension,
  rules: ExtensionRules,
): readonly GraphValidationError[] {
  const errors: GraphValidationError[] = [];
  const known = new Set(current.nodes.map((node) => node.nodeId));
  for (const { node, agentId } of extension.nodes) {
    if (node.kind === 'INTEGRATE') errors.push({ code: 'UNSUPPORTED_NODE_KIND', node: node.name });
    if (known.has(node.nodeId)) errors.push({ code: 'DUPLICATE_NODE', node: node.name });
    known.add(node.nodeId);
    if (node.kind === 'AGENT' && (agentId === undefined || !rules.builtInAgents.has(agentId))) {
      errors.push({ code: 'UNKNOWN_AGENT', node: node.name });
    }
  }
  for (const edge of extension.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) {
      errors.push({ code: 'UNKNOWN_DEPENDENCY', node: edge.to });
    }
    if (edge.kind === 'CONDITIONAL' && !rules.allowConditions) {
      errors.push({ code: 'CONDITION_NOT_ALLOWED', node: edge.to });
    }
  }
  const merged: Graph = {
    nodes: [...current.nodes, ...extension.nodes.map(({ node }) => node)],
    edges: [...current.edges, ...extension.edges],
  };
  if (known.size === merged.nodes.length && hasCycle(merged)) errors.push({ code: 'CYCLE' });
  return errors;
}

function hasCycle(graph: Graph): boolean {
  const indegree = new Map(graph.nodes.map((node) => [node.nodeId, 0]));
  for (const edge of graph.edges) {
    if (indegree.has(edge.to)) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([nodeId]) => nodeId);
  let visited = 0;
  for (let nodeId = queue.pop(); nodeId !== undefined; nodeId = queue.pop()) {
    visited += 1;
    for (const edge of graph.edges) {
      if (edge.from !== nodeId || !indegree.has(edge.to)) continue;
      const degree = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, degree);
      if (degree === 0) queue.push(edge.to);
    }
  }
  return visited !== graph.nodes.length;
}

function reachable(edges: readonly GraphEdge[], start: string, follow: 'from' | 'to'): Set<string> {
  const seen = new Set([start]);
  const stack = [start];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    for (const edge of edges) {
      const [here, next] = follow === 'to' ? [edge.from, edge.to] : [edge.to, edge.from];
      if (here === current && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** The nodes on every path from the loop's target to its source, in graph order. */
export function loopBody(graph: Graph, loop: LoopEdge): readonly GraphNode[] {
  const after = reachable(graph.edges, loop.target, 'to');
  const before = reachable(graph.edges, loop.source, 'from');
  return graph.nodes.filter((node) => after.has(node.nodeId) && before.has(node.nodeId));
}

export type LoopDecision =
  | { readonly action: 'NONE' }
  | { readonly action: 'EXHAUSTED' }
  | { readonly action: 'EXPAND'; readonly extension: GraphExtension };

/**
 * What the loop does once its source's iteration `k` has ended (M2Design 3.2). Nothing expands
 * unless the source SUCCEEDED and the condition holds; the copy's target depends on `source#k`.
 */
export function decideLoop(
  graph: Graph,
  loop: LoopEdge,
  source: GraphNode,
  view: NodeView,
  newNodeId: (name: string, iteration: number) => string,
): LoopDecision {
  const record = statusOf(view, source.nodeId);
  if (record.status !== 'SUCCEEDED') return { action: 'NONE' };
  if (loop.when !== undefined && !conditionHolds(loop.when, record.result))
    return { action: 'NONE' };
  if (source.iteration >= loop.maxIterations) return { action: 'EXHAUSTED' };

  const body = loopBody(graph, loop).filter((node) => node.iteration === source.iteration);
  const copies = new Map(
    body.map((node) => [node.nodeId, newNodeId(node.name, node.iteration + 1)]),
  );
  const target = body.find(
    (node) => node.name === graph.nodes.find((n) => n.nodeId === loop.target)?.name,
  );
  const copiedTarget = target === undefined ? undefined : copies.get(target.nodeId);
  if (copiedTarget === undefined) return { action: 'NONE' };
  const inner = graph.edges.flatMap((edge) => {
    const from = copies.get(edge.from);
    const to = copies.get(edge.to);
    return from === undefined || to === undefined ? [] : [{ ...edge, from, to }];
  });
  return {
    action: 'EXPAND',
    extension: {
      nodes: body.map((node) => ({
        node: {
          ...node,
          nodeId: copies.get(node.nodeId) ?? node.nodeId,
          iteration: node.iteration + 1,
        },
      })),
      edges: [{ from: source.nodeId, to: copiedTarget, kind: 'DEPENDS' }, ...inner],
    },
  };
}
