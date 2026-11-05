import type {
  ArtifactRef,
  GraphNodeRecord,
  SessionLogRecord,
  SubagentTask,
} from '@multiagentos/contracts';
import { outcomeOf, type TaskOutcome } from './task-results.js';
import type { TaskScope } from '../context/history-projection.js';
import type { ProjectedGraph } from '../graph/session-graph.js';

/** A `run_subagents` call whose tasks have not all ended: its caller waits (M2Design 3.6). */
export interface Waiting {
  readonly toolCallId: string;
  readonly delegationId: string;
  /** In the order the caller wrote them: the results are joined in this order. */
  readonly tasks: readonly {
    readonly name: string;
    readonly nodeId: string;
    readonly agent: string;
  }[];
}

type JoinedResult = Extract<SessionLogRecord, { type: 'SUBAGENTS_JOINED' }>['results'][number];

/**
 * How the tasks of a call came out, once every one has ended; undefined while one is still on.
 * A pure function of the log, so the same log gives the same join.
 */
export function joinedResults(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
  waiting: Waiting,
): JoinedResult[] | undefined {
  const results: JoinedResult[] = [];
  for (const task of waiting.tasks) {
    const outcome = outcomeOf(records, workflowRunId, task.nodeId);
    if (outcome === undefined) return undefined;
    results.push({
      name: task.name,
      agent: task.agent,
      status: outcome.status,
      notes: [...outcome.notes],
      ...(outcome.outputRef === undefined ? {} : { outputRef: outcome.outputRef }),
      ...(outcome.toolCallId === undefined ? {} : { resultToolCallId: outcome.toolCallId }),
    });
  }
  return results;
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
    .filter((edge) => edge.to === node.nodeId)
    .flatMap((edge) => {
      const before = graph.nodes.get(edge.from);
      if (before === undefined) return [];
      const outcome: TaskOutcome = outcomeOf(records, workflowRunId, before.nodeId) ?? {
        status: 'FAILED',
        notes: [],
      };
      const outputRef: ArtifactRef | undefined = outcome.outputRef;
      return [
        {
          seq: 0,
          category: 'PINNED' as const,
          kind: 'SUBAGENT_RESULT' as const,
          name: before.name,
          agent: before.agentRef?.id ?? 'unknown',
          status: outcome.status,
          notes: [...outcome.notes],
          ...(outputRef === undefined ? {} : { outputRef }),
          ...(outcome.toolCallId === undefined ? {} : { toolCallId: outcome.toolCallId }),
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
  link: {
    readonly parentAgentRunId: string;
    readonly delegationId: string;
    readonly callToolCallId: string;
  },
  share: { readonly tokens: number; readonly clamped?: 'MIN' | 'MAX' } | undefined,
): NonNullable<GraphNodeRecord['spawn']> {
  return {
    ...link,
    writeScope: [...task.writeRoots],
    acceptance: [...(task.acceptance ?? [])],
    inputs: [...(task.inputs ?? [])],
    ...(task.effort === undefined ? {} : { effort: task.effort }),
    tokens: share?.tokens ?? 1,
    ...(share?.clamped === undefined ? {} : { clamped: share.clamped }),
  };
}
