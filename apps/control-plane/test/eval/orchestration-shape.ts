/**
 * How a mission run organised its work, read from the Session log alone (Orchestration 3.9, D39):
 * what root started (tasks, specialists), what it did itself, and for every specialist whether it
 * kept to its playbook. The submission study (Phase2Plan 7) records it for every run, and
 * reads it again from the archived logs, so a change of a measure needs no new run.
 *
 * What a playbook allows its root, beyond what the runner already enforces (the Agents, numbers
 * and order of its tasks, and not finishing as done before the phases ran):
 * - fix-verify (fixer): run the check before the first fix and after the last one; change no file
 *   itself (the worker fixes).
 * - review (reviewer): change no file.
 */

type Row = Readonly<Record<string, unknown>>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const seqOf = (record: Row): number => (typeof record['seq'] === 'number' ? record['seq'] : 0);

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export interface ToolUse {
  readonly seq: number;
  readonly tool: string;
  /** The files it changed, as the Kernel saw them (a write tool, or a command). */
  readonly changed: readonly string[];
  readonly status?: string;
}

export interface SpecialistShape {
  readonly name: string;
  readonly template: string;
  readonly missionId: string;
  readonly status?: string;
  /** Its tasks, by Agent, in the order they were started. */
  readonly children: readonly { readonly agent: string; readonly status?: string }[];
  /** Calls of its root the runner sent back for the playbook (PLAYBOOK, PLAYBOOK_UNFINISHED). */
  readonly sentBack: Readonly<Record<string, number>>;
  /** Tool calls of its root: what it did itself. */
  readonly ownWrites: number;
  readonly ownChangedFiles: readonly string[];
  readonly ownCommands: number;
  /** Where the root broke its playbook; empty when it kept to it. */
  readonly violations: readonly string[];
}

/** One task of the run (root included): what it cost and which tools it called. */
export interface TaskStats {
  readonly name: string;
  readonly agent: string;
  /** The name of the task that started it; absent for root. */
  readonly parent?: string;
  /** Set on a specialist: its template. */
  readonly template?: string;
  /** Set on a task a specialist started: the template of that specialist. */
  readonly inside?: string;
  readonly status?: string;
  /** Its AgentRuns: one per segment (a task that slept has several). */
  readonly segments: number;
  readonly modelRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** How often it called each tool. */
  readonly tools: Readonly<Record<string, number>>;
  /** Its tool calls that did not end OK: `<tool>:<status>`. */
  readonly notOk: Readonly<Record<string, number>>;
  /** What the runner sent back or answered it with, by code (FEEDBACK). */
  readonly feedback: Readonly<Record<string, number>>;
  readonly changedFiles: number;
  /**
   * Its context compactions (Phase2Plan 4.7): tool results pruned and histories summarised, and the
   * largest input of one of its model calls, so a run shows whether the trigger fits the limits.
   */
  readonly compactions: { readonly pruned: number; readonly summarised: number };
  readonly peakInputTokens: number;
}

export interface RunShape {
  readonly rootMissionId?: string;
  /** Every task, root first, then in the order they were started. */
  readonly tasks: readonly TaskStats[];
  /** The specialists started (Orchestration D39), with how each kept to its playbook. */
  readonly specialists: readonly SpecialistShape[];
  /** Calls of `run_subagents` by root. */
  readonly runSubagentsCalls: number;
  /** Every task of the run (specialists and their tasks too), by Agent. */
  readonly tasksByAgent: Readonly<Record<string, number>>;
  /** Root's own work. */
  readonly rootWrites: number;
  readonly rootCommands: number;
  /** Deepest level of the task tree under root (1: root's own tasks). */
  readonly depth: number;
}

interface Mission {
  readonly id: string;
  readonly parentId?: string;
  readonly name: string;
  readonly agent: string;
  readonly startedSeq: number;
  readonly specialist?: { readonly template: string };
}

export function shapeOf(log: readonly Row[]): RunShape {
  const missions = new Map<string, Mission>();
  const endedAt = new Map<string, { seq: number; status: string }>();
  const missionOfRun = new Map<string, string>();
  const runsOf = new Map<string, string[]>();
  const uses = new Map<string, ToolUse[]>();
  const callOfRequest = new Map<string, string>();
  const useOfCall = new Map<string, { run: string; index: number }>();
  const sentBack = new Map<string, Record<string, number>>();
  const feedback = new Map<string, Record<string, number>>();
  const usage = new Map<
    string,
    { requests: number; input: number; output: number; peak: number }
  >();
  const compacted = new Map<string, { pruned: number; summarised: number }>();
  const agentOfRun = new Map<string, string>();
  let rootMissionId: string | undefined;

  for (const record of log) {
    switch (record['type']) {
      case 'GRAPH_EXTENDED': {
        if (record['source'] !== 'SPAWN') break;
        for (const node of (record['nodes'] as Row[] | undefined) ?? []) {
          const mission = node['mission'] as { id?: string; parentId?: string } | undefined;
          if (mission?.id === undefined || mission.parentId === undefined) continue;
          const spawn = node['spawn'] as
            { specialist?: { template?: { id?: string } } } | undefined;
          missions.set(mission.id, {
            id: mission.id,
            parentId: mission.parentId,
            name: text(node['name']),
            agent: text((node['agentRef'] as { id?: string } | undefined)?.id),
            startedSeq: seqOf(record),
            ...(spawn?.specialist === undefined
              ? {}
              : { specialist: { template: text(spawn.specialist.template?.id) } }),
          });
        }
        break;
      }
      case 'AGENT_RUN_REGISTERED': {
        const missionId = text(record['missionId']);
        const run = text(record['agentRunId']);
        if (missionId === '') break;
        missionOfRun.set(run, missionId);
        agentOfRun.set(run, text((record['agentRef'] as { id?: string } | undefined)?.id));
        runsOf.set(missionId, [...(runsOf.get(missionId) ?? []), run]);
        if (
          rootMissionId === undefined &&
          record['parentAgentRunId'] === undefined &&
          text((record['agentRef'] as { id?: string } | undefined)?.id) === 'main'
        )
          rootMissionId = missionId;
        break;
      }
      case 'MISSION_ENDED':
        endedAt.set(text(record['missionId']), {
          seq: seqOf(record),
          status: text(record['status']),
        });
        break;
      case 'MODEL_TURN': {
        const run = text(record['agentRunId']);
        const spent = usage.get(run) ?? { requests: 0, input: 0, output: 0, peak: 0 };
        const counted = record['usage'] as
          { inputTokens?: number; outputTokens?: number } | undefined;
        usage.set(run, {
          requests: spent.requests + 1,
          input: spent.input + (counted?.inputTokens ?? 0),
          output: spent.output + (counted?.outputTokens ?? 0),
          peak: Math.max(spent.peak, counted?.inputTokens ?? 0),
        });
        const list = uses.get(run) ?? [];
        for (const call of (record['toolCalls'] as Row[] | undefined) ?? []) {
          useOfCall.set(text(call['toolCallId']), { run, index: list.length });
          list.push({ seq: seqOf(record), tool: text(call['toolName']), changed: [] });
        }
        uses.set(run, list);
        break;
      }
      case 'UNIT_SUBMITTED': {
        const source = record['inputSource'] as Row | undefined;
        if (source?.['kind'] === 'TOOL_CALL')
          callOfRequest.set(text(record['requestId']), text(source['toolCallId']));
        break;
      }
      case 'UNIT_COMPLETED': {
        const at = useOfCall.get(callOfRequest.get(text(record['requestId'])) ?? '');
        const list = at === undefined ? undefined : uses.get(at.run);
        const use = at === undefined ? undefined : list?.[at.index];
        if (list === undefined || use === undefined || at === undefined) break;
        list[at.index] = {
          ...use,
          status: text(record['status']),
          changed: ((record['changedFiles'] as unknown[] | undefined) ?? []).map(text),
        };
        break;
      }
      case 'TOOL_RESULTS_PRUNED':
      case 'CONTEXT_COMPACTED': {
        const target = record['target'] as { kind?: string; agentRunId?: string } | undefined;
        // main's context is the root task's; any other is the task of the AgentRun named.
        const missionId =
          target?.kind === 'MAIN' ? rootMissionId : missionOfRun.get(text(target?.agentRunId));
        if (missionId === undefined) break;
        const counts = compacted.get(missionId) ?? { pruned: 0, summarised: 0 };
        if (record['type'] === 'TOOL_RESULTS_PRUNED') counts.pruned += 1;
        else counts.summarised += 1;
        compacted.set(missionId, counts);
        break;
      }
      case 'FEEDBACK': {
        const code = text(record['code']);
        const missionId = missionOfRun.get(text(record['agentRunId']));
        if (missionId === undefined) break;
        const all = feedback.get(missionId) ?? {};
        all[code] = (all[code] ?? 0) + 1;
        feedback.set(missionId, all);
        if (code !== 'PLAYBOOK' && code !== 'PLAYBOOK_UNFINISHED') break;
        const counts = sentBack.get(missionId) ?? {};
        counts[code] = (counts[code] ?? 0) + 1;
        sentBack.set(missionId, counts);
        break;
      }
      default:
        break;
    }
  }

  const usesOf = (missionId: string): ToolUse[] =>
    (runsOf.get(missionId) ?? [])
      .flatMap((run) => uses.get(run) ?? [])
      .sort((a, b) => a.seq - b.seq);
  const writes = (list: readonly ToolUse[]) =>
    list.filter((use) => WRITE_TOOLS.has(use.tool) || use.changed.length > 0);
  const childrenOf = (missionId: string) =>
    [...missions.values()]
      .filter((each) => each.parentId === missionId)
      .sort((a, b) => a.startedSeq - b.startedSeq);
  const depthOf = (missionId: string): number => {
    const below = childrenOf(missionId).map((child) => depthOf(child.id));
    return below.length === 0 ? 0 : 1 + Math.max(...below);
  };

  const specialists = [...missions.values()]
    .filter((each) => each.specialist !== undefined)
    .map((each): SpecialistShape => {
      const own = usesOf(each.id);
      const children = childrenOf(each.id);
      const ownWrites = writes(own);
      const template = each.specialist?.template ?? '';
      const status = endedAt.get(each.id)?.status;
      return {
        name: each.name,
        template,
        missionId: each.id,
        ...(status === undefined ? {} : { status }),
        children: children.map((child) => {
          const status = endedAt.get(child.id)?.status;
          return { agent: child.agent, ...(status === undefined ? {} : { status }) };
        }),
        sentBack: sentBack.get(each.id) ?? {},
        ownWrites: ownWrites.length,
        ownChangedFiles: [...new Set(ownWrites.flatMap((use) => use.changed))],
        ownCommands: own.filter((use) => use.tool === 'run_command').length,
        violations: violationsOf(template, own, children, endedAt),
      };
    });

  const templateAbove = (missionId: string): string | undefined => {
    for (
      let at = missions.get(missionId)?.parentId;
      at !== undefined;
      at = missions.get(at)?.parentId
    ) {
      const above = missions.get(at);
      if (above?.specialist !== undefined) return above.specialist.template;
    }
    return undefined;
  };
  const statsOf = (missionId: string, name: string, agent: string): TaskStats => {
    const runs = runsOf.get(missionId) ?? [];
    const own = usesOf(missionId);
    const tools: Record<string, number> = {};
    const notOk: Record<string, number> = {};
    for (const use of own) {
      tools[use.tool] = (tools[use.tool] ?? 0) + 1;
      if (use.status !== undefined && use.status !== 'OK')
        notOk[`${use.tool}:${use.status}`] = (notOk[`${use.tool}:${use.status}`] ?? 0) + 1;
    }
    const spent = runs.map(
      (run) => usage.get(run) ?? { requests: 0, input: 0, output: 0, peak: 0 },
    );
    const mission = missions.get(missionId);
    const parent = mission?.parentId === undefined ? undefined : missions.get(mission.parentId);
    const inside = templateAbove(missionId);
    const status = endedAt.get(missionId)?.status;
    return {
      name,
      agent,
      ...(mission?.parentId === undefined
        ? {}
        : {
            parent:
              parent?.name ?? (mission.parentId === rootMissionId ? 'root' : mission.parentId),
          }),
      ...(mission?.specialist === undefined ? {} : { template: mission.specialist.template }),
      ...(inside === undefined ? {} : { inside }),
      ...(status === undefined ? {} : { status }),
      segments: runs.length,
      modelRequests: spent.reduce((sum, each) => sum + each.requests, 0),
      inputTokens: spent.reduce((sum, each) => sum + each.input, 0),
      outputTokens: spent.reduce((sum, each) => sum + each.output, 0),
      tools,
      notOk,
      feedback: feedback.get(missionId) ?? {},
      changedFiles: new Set(writes(own).flatMap((use) => use.changed)).size,
      compactions: compacted.get(missionId) ?? { pruned: 0, summarised: 0 },
      peakInputTokens: Math.max(0, ...spent.map((each) => each.peak)),
    };
  };
  const tasks = [
    ...(rootMissionId === undefined
      ? []
      : [
          statsOf(
            rootMissionId,
            'root',
            agentOfRun.get(runsOf.get(rootMissionId)?.[0] ?? '') ?? 'main',
          ),
        ]),
    ...[...missions.values()]
      .sort((a, b) => a.startedSeq - b.startedSeq)
      .map((each) => statsOf(each.id, each.name, each.agent)),
  ];
  const rootUses = rootMissionId === undefined ? [] : usesOf(rootMissionId);
  const tasksByAgent: Record<string, number> = {};
  for (const each of missions.values())
    tasksByAgent[each.agent] = (tasksByAgent[each.agent] ?? 0) + 1;
  return {
    ...(rootMissionId === undefined ? {} : { rootMissionId }),
    tasks,
    specialists,
    runSubagentsCalls: rootUses.filter((use) => use.tool === 'run_subagents').length,
    tasksByAgent,
    rootWrites: writes(rootUses).length,
    rootCommands: rootUses.filter((use) => use.tool === 'run_command').length,
    depth: rootMissionId === undefined ? 0 : depthOf(rootMissionId),
  };
}

function violationsOf(
  template: string,
  own: readonly ToolUse[],
  children: readonly Mission[],
  endedAt: ReadonlyMap<string, { seq: number; status: string }>,
): string[] {
  const found: string[] = [];
  const writesIn = (from: number, to: number) =>
    own.filter(
      (use) =>
        use.seq > from && use.seq < to && (WRITE_TOOLS.has(use.tool) || use.changed.length > 0),
    ).length;
  const commandsIn = (from: number, to: number) =>
    own.filter((use) => use.tool === 'run_command' && use.seq > from && use.seq < to).length;
  const ends = (list: readonly Mission[]) =>
    Math.max(0, ...list.map((each) => endedAt.get(each.id)?.seq ?? Number.MAX_SAFE_INTEGER));
  const first = children[0]?.startedSeq ?? Number.MAX_SAFE_INTEGER;
  const last = ends(children);
  const end = Number.MAX_SAFE_INTEGER;
  switch (template) {
    case 'fix-verify': {
      if (children.length === 0) found.push('no fix was started');
      if (commandsIn(0, first) === 0) found.push('did not run the check before the first fix');
      if (children.length > 0 && commandsIn(last, end) === 0)
        found.push('did not run the check after the last fix');
      const wrote = writesIn(0, end);
      if (wrote > 0) found.push(`changed files itself (${String(wrote)} calls)`);
      break;
    }
    case 'review': {
      const wrote = writesIn(0, end);
      if (wrote > 0) found.push(`changed files in a review (${String(wrote)} calls)`);
      if (children.length === 0) found.push('no reviewer was started');
      break;
    }
    default:
      break;
  }
  return found;
}
