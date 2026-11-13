/**
 * The MissionTree (Orchestration 3): tasks read from the graph the log records. A task is the
 * chain of AGENT nodes that carry its id; its segments run in the order they started, one at a
 * time; its parent is written on its nodes; it has ended when a `MISSION_ENDED` says so. Every
 * function here is a pure function of the records, so a replay finds the same tree.
 */
import { pathDerivedId, type NodeMission, type SessionLogRecord } from '@multiagentos/contracts';
import { isRolledBack, rewoundRanges } from '../context/rolled-back.js';

export interface MissionView {
  readonly missionId: string;
  readonly parentId?: string;
  /** 0 for the root task, then one more for every level below it. */
  readonly depth: number;
  /** Name of the first node of the task: the task name of a SubAgent, `main` for the root of chat. */
  readonly name: string;
  /** The Agent the task runs (the one of its first node). */
  readonly agentId: string;
  /** What it is responsible for, as its caller wrote it (Orchestration 3.7); none for a root. */
  readonly role?: string;
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
  readonly role?: string;
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
  // The tasks as they were at the cut of every rewind (Orchestration 7.5).
  const rewound = rewoundRanges(records);
  for (const record of records) {
    if (isRolledBack(record.seq, rewound)) continue;
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
          ...(node.spawn?.role === undefined ? {} : { role: node.spawn.role }),
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
        ...(each.role === undefined ? {} : { role: each.role }),
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

/** Lines of the tree a task is shown, at most this many (Orchestration 3.7). */
const MAX_TREE_LINES = 30;

/**
 * The part of the tree a task sees (Orchestration 3.7, D26): its parent, its siblings and its own
 * subtasks, one line each with the role and the state. Tasks above the parent, the subtasks of its
 * siblings and those below its own subtasks are not shown: the plan of the work tells the whole.
 * `stateOf` tells the state of a task from the log; the text is material, never an instruction.
 */
export function treeView(
  missions: ReadonlyMap<string, MissionView>,
  own: string,
  stateOf: (mission: MissionView) => string,
): string {
  const me = missions.get(own);
  if (me === undefined) return 'This task is not in the task tree.';
  const lines: string[] = [];
  let hidden = 0;
  const line = (mission: MissionView, depth: number, note = '') => {
    if (lines.length >= MAX_TREE_LINES) {
      hidden += 1;
      return;
    }
    const role = mission.role === undefined ? '' : ` — ${mission.role}`;
    lines.push(
      `${'  '.repeat(depth)}- ${mission.name} (${mission.agentId})${role} — ${stateOf(mission)}${note}`,
    );
  };
  const parent = me.parentId === undefined ? undefined : missions.get(me.parentId);
  if (parent !== undefined)
    line(
      parent,
      0,
      parent.parentId === undefined
        ? ' (your parent; the root: the goal of the user)'
        : ' (your parent)',
    );
  const depth = parent === undefined ? 0 : 1;
  const level = parent === undefined ? [me] : childrenOf(missions, parent.missionId);
  for (const mission of level) {
    line(mission, depth, mission.missionId === own ? '   <- you' : '');
    if (mission.missionId === own)
      for (const child of childrenOf(missions, own)) line(child, depth + 1);
  }
  const tail = hidden > 0 ? `\n(${String(hidden)} more not shown)` : '';
  return `The work you are part of (task — role — state):\n${lines.join('\n')}${tail}`;
}

/**
 * How the tree shows a task's state, from the log: not started, running, asleep, or ended with its
 * status. A pure function of the records it is given.
 */
export function missionStateOf(
  records: readonly SessionLogRecord[],
): (mission: MissionView) => string {
  const nodeEnd = new Map<string, string>();
  for (const record of records)
    if (record.type === 'NODE_ENDED') nodeEnd.set(record.nodeId, record.status);
  return (mission) => {
    if (mission.ended !== undefined) return `ended (${mission.ended.toLowerCase()})`;
    const last = mission.segments.at(-1);
    if (last === undefined) return 'not started';
    return nodeEnd.get(last) === 'YIELDED' ? 'asleep' : 'running';
  };
}
