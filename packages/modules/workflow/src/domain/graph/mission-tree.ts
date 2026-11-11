/**
 * The MissionTree (Orchestration 3): tasks read from the graph the log records. A task is the
 * chain of AGENT nodes that carry its id; its segments run in the order they started, one at a
 * time; its parent is written on its nodes; it has ended when a `MISSION_ENDED` says so. Every
 * function here is a pure function of the records, so a replay finds the same tree.
 */
import { pathDerivedId, type NodeMission, type SessionLogRecord } from '@multiagentos/contracts';

export interface MissionView {
  readonly missionId: string;
  readonly parentId?: string;
  /** 0 for the root task, then one more for every level below it. */
  readonly depth: number;
  /** Name of the first node of the task: the task name of a SubAgent, `main` for the root of chat. */
  readonly name: string;
  /** The Agent the task runs (the one of its first node). */
  readonly agentId: string;
  /** Every node of the task, in the order the log added them. */
  readonly nodeIds: readonly string[];
  /** The nodes that started, in the order they started: its segments. */
  readonly segments: readonly string[];
  readonly ended?: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
}

/** The root task of a Session's graphs of one kind: the same across runs (Orchestration 3.2). */
export const rootMissionId = (sessionId: string, templateId: string): string =>
  pathDerivedId('msc', `${sessionId}/root/${templateId}`);

/** A task `run_subagents` started: named by the call that started it and its name in that call. */
export const childMissionId = (parentId: string, toolCallId: string, name: string): string =>
  pathDerivedId('msc', `${parentId}/${toolCallId}/${name}`);

/** A task a template compiled under its root: one per node and iteration. */
export const templateMissionId = (rootId: string, name: string, iteration: number): string =>
  pathDerivedId('msc', `${rootId}/template/${name}#${String(iteration)}`);

interface Building {
  readonly missionId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly agentId: string;
  readonly nodeIds: string[];
  readonly segments: string[];
  ended?: MissionView['ended'];
}

/** Every task of the Session, by id; tasks of other runs too, since the root of chat spans runs. */
export function projectMissions(
  records: readonly SessionLogRecord[],
): ReadonlyMap<string, MissionView> {
  const building = new Map<string, Building>();
  const missionOfNode = new Map<string, string>();
  for (const record of records) {
    if (record.type === 'GRAPH_EXTENDED') {
      for (const node of record.nodes) {
        const mission: NodeMission | undefined = node.mission;
        if (mission === undefined || node.kind !== 'AGENT') continue;
        missionOfNode.set(node.nodeId, mission.id);
        const found = building.get(mission.id);
        if (found !== undefined) {
          found.nodeIds.push(node.nodeId);
          continue;
        }
        building.set(mission.id, {
          missionId: mission.id,
          ...(mission.parentId === undefined ? {} : { parentId: mission.parentId }),
          name: node.name,
          agentId: node.agentRef?.id ?? 'unknown',
          nodeIds: [node.nodeId],
          segments: [],
        });
      }
    } else if (record.type === 'NODE_STARTED') {
      const missionId = missionOfNode.get(record.nodeId);
      if (missionId !== undefined) building.get(missionId)?.segments.push(record.nodeId);
    } else if (record.type === 'MISSION_ENDED') {
      const found = building.get(record.missionId);
      if (found !== undefined) found.ended = record.status;
    }
  }
  const depthOf = (missionId: string, seen: Set<string> = new Set()): number => {
    const parentId = building.get(missionId)?.parentId;
    if (parentId === undefined || seen.has(missionId)) return 0;
    seen.add(missionId);
    return depthOf(parentId, seen) + 1;
  };
  return new Map(
    [...building.values()].map((each) => [
      each.missionId,
      {
        missionId: each.missionId,
        ...(each.parentId === undefined ? {} : { parentId: each.parentId }),
        depth: depthOf(each.missionId),
        name: each.name,
        agentId: each.agentId,
        nodeIds: [...each.nodeIds],
        segments: [...each.segments],
        ...(each.ended === undefined ? {} : { ended: each.ended }),
      },
    ]),
  );
}

/** The tasks directly below `missionId`, in the order the log added them. */
export function childrenOf(
  missions: ReadonlyMap<string, MissionView>,
  missionId: string,
): readonly MissionView[] {
  return [...missions.values()].filter((each) => each.parentId === missionId);
}

/** The other tasks below the same parent. */
export function siblingsOf(
  missions: ReadonlyMap<string, MissionView>,
  missionId: string,
): readonly MissionView[] {
  const parentId = missions.get(missionId)?.parentId;
  if (parentId === undefined) return [];
  return childrenOf(missions, parentId).filter((each) => each.missionId !== missionId);
}

/** The task a node is a segment of, from the records; undefined for a HUMAN node. */
export function missionOfNode(
  records: readonly SessionLogRecord[],
  nodeId: string,
): string | undefined {
  for (const record of records)
    if (record.type === 'GRAPH_EXTENDED')
      for (const node of record.nodes) if (node.nodeId === nodeId) return node.mission?.id;
  return undefined;
}
