import type {
  ArtifactRef,
  GraphNodeRecord,
  SessionLogRecord,
  SubagentTask,
} from '@multiagentos/contracts';
import { registeredOf } from '../handover/handover.js';
import { outcomeOf, type TaskOutcome } from './task-results.js';
import type { TaskScope } from '../context/history-projection.js';
import type { ProjectedGraph } from '../graph/session-graph.js';

/**
 * What the tasks of a `run_subagents` call look like in the graph and in the log (M2Design 3.1,
 * 3.6): who dispatched a task, what a task is given, what the caller learns when it is woken, and
 * how much a Turn has dispatched. All of it a pure function of the log.
 */

/** The `DELEGATE` edge that led to a task: its caller's node, and the delegation. */
export function callOf(
  graph: ProjectedGraph,
  nodeId: string,
): { readonly callerNodeId: string; readonly delegationId?: string } | undefined {
  const edge = graph.graph.edges.find((each) => each.to === nodeId && each.kind === 'DELEGATE');
  return edge?.call === undefined
    ? undefined
    : {
        callerNodeId: edge.from,
        ...(edge.call.delegationId === undefined ? {} : { delegationId: edge.call.delegationId }),
      };
}

type RecordOf<T extends SessionLogRecord['type']> = Extract<SessionLogRecord, { type: T }>;

/** What the user answered to the question of a call to `ask_user`. */
export interface CallAnswer {
  readonly kind: 'ask' | 'confirm' | 'review';
  readonly contentRef: ArtifactRef;
}

export interface CallResult {
  readonly name: string;
  readonly agent: string;
  readonly status: TaskOutcome['status'];
  readonly notes: readonly string[];
  readonly outputRef?: ArtifactRef;
  readonly toolCallId?: string;
  /** The handover that carries the result and what the task listed, and what is in it. */
  readonly referenceId?: string;
  readonly references?: readonly { readonly toolCallId: string; readonly tool: string }[];
}

/** What a task handed over, as an entry shows it: the reference id and the items of the handover. */
export function handoverFieldsOf(
  records: readonly SessionLogRecord[],
  outcome: TaskOutcome,
): { referenceId?: string; references?: { toolCallId: string; tool: string }[] } {
  const handover =
    outcome.referenceId === undefined ? undefined : registeredOf(records, outcome.referenceId);
  return handover === undefined
    ? {}
    : {
        referenceId: handover.referenceId,
        references: handover.items.map(({ toolCallId, tool }) => ({ toolCallId, tool })),
      };
}

/**
 * What the user said to a question of a call, from the record of the answer; undefined while no
 * answer was given (a question the run was interrupted on has none).
 */
export function answerOf(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
  callerNodeId: string,
  toolCallId: string,
): CallAnswer | undefined {
  const resume = records
    .filter((record): record is RecordOf<'GRAPH_EXTENDED'> => record.type === 'GRAPH_EXTENDED')
    .filter((record) => record.workflowRunId === workflowRunId)
    .flatMap((record) => record.edges)
    .find(
      (edge) =>
        edge.kind === 'RESUME' && edge.to === callerNodeId && edge.call?.toolCallId === toolCallId,
    );
  if (resume === undefined) return undefined;
  const answered = records.find(
    (record): record is RecordOf<'HUMAN_ANSWERED'> =>
      record.type === 'HUMAN_ANSWERED' &&
      record.workflowRunId === workflowRunId &&
      record.nodeId === resume.from &&
      record.kind !== 'prompt' &&
      record.kind !== 'steer',
  );
  return answered === undefined || answered.kind === 'prompt' || answered.kind === 'steer'
    ? undefined
    : { kind: answered.kind, contentRef: answered.contentRef };
}

/**
 * What the caller of a call is told when it is woken: the outcome of every node on a `RESUME`
 * edge of that call, in the order the caller wrote the tasks (the order of the edges). A task that
 * has no outcome is reported as failed rather than left out.
 */
export function callResultsOf(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
  callerNodeId: string,
  toolCallId: string,
): CallResult[] {
  const extensions = records.filter(
    (record): record is RecordOf<'GRAPH_EXTENDED'> =>
      record.type === 'GRAPH_EXTENDED' && record.workflowRunId === workflowRunId,
  );
  const nodes = new Map(
    extensions.flatMap((record) => record.nodes).map((node) => [node.nodeId, node]),
  );
  return extensions
    .flatMap((record) => record.edges)
    .filter(
      (edge) =>
        edge.kind === 'RESUME' && edge.to === callerNodeId && edge.call?.toolCallId === toolCallId,
    )
    .flatMap((edge) => {
      const node = nodes.get(edge.from);
      if (node === undefined) return [];
      const outcome = outcomeOf(records, workflowRunId, node.nodeId) ?? {
        status: 'FAILED' as const,
        notes: [],
      };
      return [
        {
          name: node.name,
          agent: node.agentRef?.id ?? 'unknown',
          status: outcome.status,
          notes: outcome.notes,
          ...(outcome.outputRef === undefined ? {} : { outputRef: outcome.outputRef }),
          ...(outcome.toolCallId === undefined ? {} : { toolCallId: outcome.toolCallId }),
          ...handoverFieldsOf(records, outcome),
        },
      ];
    });
}

/** What a SubAgent is given: its task, and the results of the tasks it waits for (M2Design 3.6). */
export function taskScopeOf(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
  graph: ProjectedGraph,
  node: GraphNodeRecord,
  spawn: NonNullable<GraphNodeRecord['spawn']>,
): TaskScope {
  const dependencies = graph.graph.edges
    .filter((edge) => edge.to === node.nodeId && edge.kind === 'DEPENDS')
    .flatMap((edge) => {
      const before = graph.nodes.get(edge.from);
      if (before === undefined) return [];
      const outcome: TaskOutcome = outcomeOf(records, workflowRunId, before.nodeId) ?? {
        status: 'FAILED',
        notes: [],
      };
      return [
        {
          seq: 0,
          category: 'PINNED' as const,
          kind: 'SUBAGENT_RESULT' as const,
          name: before.name,
          agent: before.agentRef?.id ?? 'unknown',
          status: outcome.status,
          notes: [...outcome.notes],
          ...(outcome.outputRef === undefined ? {} : { outputRef: outcome.outputRef }),
          ...(outcome.toolCallId === undefined ? {} : { toolCallId: outcome.toolCallId }),
          ...handoverFieldsOf(records, outcome),
        },
      ];
    });
  return {
    name: node.name,
    agent: node.agentRef?.id ?? 'unknown',
    goal: node.goal ?? '',
    acceptance: spawn.acceptance,
    writeScope: spawn.writeScope,
    inputs: spawn.inputs,
    dependencies,
  };
}

/** The task as the graph holds it, from what the caller wrote and what the Kernel granted. */
export function spawnNodeOf(
  task: SubagentTask & { readonly writeRoots: readonly string[] },
  share: { readonly tokens: number; readonly clamped?: 'MIN' | 'MAX' } | undefined,
): NonNullable<GraphNodeRecord['spawn']> {
  return {
    writeScope: [...task.writeRoots],
    acceptance: [...(task.acceptance ?? [])],
    inputs: [...(task.inputs ?? [])],
    ...(task.effort === undefined ? {} : { effort: task.effort }),
    tokens: share?.tokens ?? 1,
    ...(share?.clamped === undefined ? {} : { clamped: share.clamped }),
  };
}

/** What a Turn has dispatched so far: the limits of `run_subagents` count it (M2Design 3.6). */
export function spawnedIn(
  records: readonly SessionLogRecord[],
  turnId: string | undefined,
): { readonly tasks: number; readonly calls: number } {
  const spawns = records.filter(
    (record): record is RecordOf<'GRAPH_EXTENDED'> =>
      record.type === 'GRAPH_EXTENDED' && record.source === 'SPAWN' && record.turnId === turnId,
  );
  return { tasks: spawns.reduce((sum, each) => sum + each.nodes.length, 0), calls: spawns.length };
}

/**
 * What a task has dispatched so far: the limits of `run_subagents` count it per task, so a lead
 * below the root has limits of its own (Orchestration 9.3).
 */
export function spawnedBy(
  records: readonly SessionLogRecord[],
  missionId: string,
): { readonly tasks: number; readonly calls: number } {
  const spawns = records.filter(
    (record): record is RecordOf<'GRAPH_EXTENDED'> =>
      record.type === 'GRAPH_EXTENDED' &&
      record.source === 'SPAWN' &&
      record.nodes.some((node) => node.mission?.parentId === missionId),
  );
  return { tasks: spawns.reduce((sum, each) => sum + each.nodes.length, 0), calls: spawns.length };
}
