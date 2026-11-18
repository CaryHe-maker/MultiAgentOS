import type { DefinitionRef, SessionLogRecord } from '@multiagentos/contracts';
import { projectMissions } from '../domain/graph/mission-tree.js';
import { projectGraph } from '../domain/graph/session-graph.js';

/** A long task the last process left in the middle, and where it can go on from (7.6). */
export interface InterruptedRun {
  readonly workflowRunId: string;
  readonly templateRef: DefinitionRef;
  readonly checkpointId: string;
  readonly label: string;
  readonly spentTokens: number;
}

/**
 * What a Session's log says of its last long task (Orchestration 7.6): it is one to go on with when
 * the process stopped under it (the run ended as PROCESS_EXITED), its root had not delivered, and
 * the user has said nothing since (an input of theirs is the choice not to go on). It goes on from
 * its latest checkpoint that was taken, or from the input it started from. A pure function of the
 * records.
 */
export function interruptedRunOf(records: readonly SessionLogRecord[]): InterruptedRun | undefined {
  let started: { readonly workflowRunId: string; readonly templateRef: DefinitionRef } | undefined;
  for (const record of records) {
    if (record.type === 'WORKFLOW_RUN_STARTED' && record.mode === 'ORCHESTRATION')
      started =
        record.templateRef === undefined
          ? undefined
          : { workflowRunId: record.workflowRunId, templateRef: record.templateRef };
    if (record.type === 'WORKFLOW_RUN_RESUMED')
      started = { workflowRunId: record.workflowRunId, templateRef: record.templateRef };
  }
  if (started === undefined) return undefined;
  const { workflowRunId } = started;
  const ended = [...records]
    .reverse()
    .find(
      (record) =>
        (record.type === 'WORKFLOW_RUN_ENDED' || record.type === 'WORKFLOW_RUN_RESUMED') &&
        record.workflowRunId === workflowRunId,
    );
  if (ended?.type !== 'WORKFLOW_RUN_ENDED' || ended.closeReason !== 'PROCESS_EXITED')
    return undefined;
  if (
    records.some(
      (record) =>
        record.seq > ended.seq && record.type === 'HUMAN_ANSWERED' && record.kind === 'prompt',
    )
  )
    return undefined;
  const graph = projectGraph(records, workflowRunId);
  const root = [...projectMissions(records).values()].find(
    (mission) =>
      mission.parentId === undefined && mission.nodeIds.some((nodeId) => graph.nodes.has(nodeId)),
  );
  if (root === undefined || root.ended !== undefined) return undefined;
  // The latest checkpoint the run took, or the input it started from.
  const taken = new Set(
    records.flatMap((record) =>
      record.type === 'CHECKPOINT_TAKEN' &&
      record.workflowRunId === workflowRunId &&
      record.outcome === 'TAKEN'
        ? [record.checkpointId]
        : [],
    ),
  );
  const cut = [...records]
    .reverse()
    .find(
      (record) =>
        (record.type === 'CHECKPOINT_REQUESTED' &&
          record.workflowRunId === workflowRunId &&
          taken.has(record.checkpointId)) ||
        (record.type === 'HUMAN_ANSWERED' &&
          record.workflowRunId === workflowRunId &&
          record.kind === 'prompt' &&
          record.checkpointId !== undefined),
    );
  const checkpoint =
    cut?.type === 'CHECKPOINT_REQUESTED'
      ? { checkpointId: cut.checkpointId, label: cut.label }
      : cut?.type === 'HUMAN_ANSWERED' && cut.checkpointId !== undefined
        ? { checkpointId: cut.checkpointId, label: 'user input' }
        : undefined;
  if (checkpoint === undefined) return undefined;
  let spentTokens = 0;
  for (const record of records)
    if (record.type === 'MODEL_TURN' && record.workflowRunId === workflowRunId)
      spentTokens += (record.usage?.inputTokens ?? 0) + (record.usage?.outputTokens ?? 0);
  return { ...started, ...checkpoint, spentTokens };
}
