import type { Playbook, PlaybookPhase, SessionLogRecord, SpawnNode } from '@multiagentos/contracts';
import { isRolledBack, rewoundRanges } from '../context/rolled-back.js';
import { projectMissions } from '../graph/mission-tree.js';

type Submission = NonNullable<SpawnNode['submission']>;

/**
 * The playbook of a subMission in words (Orchestration 3.9, D32): what its root reads with its
 * task. Pure, so the same log always gives the same text.
 */
export function renderPlaybook(submission: Submission): string {
  const { template, playbook } = submission;
  const phaseLine = (phase: PlaybookPhase, index: number): string => {
    const tasks =
      phase.tasks === undefined
        ? 'your own work, no subtasks'
        : `one run_subagents call of ${
            phase.tasks.min === phase.tasks.max
              ? String(phase.tasks.min)
              : `${String(phase.tasks.min)} to ${String(phase.tasks.max)}`
          } ${phase.tasks.agent} task(s)`;
    const repeat =
      phase.repeat === undefined || phase.repeat <= 1
        ? ''
        : `; it may run up to ${String(phase.repeat)} times in all`;
    const optional = phase.optional === true ? '; optional' : '';
    const inherit =
      phase.tasks?.context === 'inherit'
        ? '; each task starts with everything you have read and done so far, so its goal says only what it must do, not what you already know'
        : '';
    return `${String(index + 1)}. ${phase.name} (${tasks}${repeat}${optional}${inherit}): ${phase.instructions}`;
  };
  // The caller writes what the playbook needs into the goal and acceptance (D39); the root finds it there.
  return [
    `You run a pre-orchestrated part of the work: template ${template.id} (${playbook.summary}). Follow its playbook. The system checks every run_subagents call of yours against it: a call must be the next phase that has tasks, with tasks of that Agent and in that number, and only after the tasks of your earlier calls have ended.`,
    ...(playbook.params.length === 0
      ? []
      : [
          'What you need from your task, in its goal and acceptance (when one is not there, work it out from the repository; when it cannot be found, finish blocked and say what is missing):',
          ...playbook.params.map((param) => `- ${param.name}: ${param.description}`),
        ]),
    'Phases, in order:',
    ...playbook.phases.map(phaseLine),
    'You decide what each task does: write its goal so it stands on its own, give a worker its writeScope inside yours, and use what the earlier phases returned. You cannot change the phases. You finish with finish_subagent: status done only after every phase that is not optional has run; if the playbook cannot get the work done, finish with partial or blocked and say why, and your caller decides what to do.',
    `An example of a good plan with this playbook:\n${playbook.example}`,
  ].join('\n');
}

/** The calls of run_subagents a task made, in order: the Agent of their tasks and how many. */
function callsOf(
  records: readonly SessionLogRecord[],
  missionId: string,
): { readonly agent: string; readonly count: number; readonly missionIds: readonly string[] }[] {
  const calls = new Map<string, { agent: string; count: number; missionIds: string[] }>();
  const nodesOfMission = new Set<string>();
  // A call a rewind took back did not happen (Orchestration 7.5).
  const rewound = rewoundRanges(records);
  for (const record of records) {
    if (record.type !== 'GRAPH_EXTENDED' || isRolledBack(record.seq, rewound)) continue;
    for (const node of record.nodes)
      if (node.mission?.id === missionId) nodesOfMission.add(node.nodeId);
    if (record.source !== 'SPAWN') continue;
    for (const edge of record.edges) {
      if (edge.kind !== 'DELEGATE' || !nodesOfMission.has(edge.from) || edge.call === undefined)
        continue;
      const node = record.nodes.find((each) => each.nodeId === edge.to);
      if (node === undefined) continue;
      const key = edge.call.toolCallId;
      const call = calls.get(key) ?? {
        // A task that inherits runs as its caller's Agent; the phase is told by the one it names.
        agent: node.spawn?.inherits?.as ?? node.agentRef?.id ?? 'unknown',
        count: 0,
        missionIds: [],
      };
      call.count += 1;
      if (node.mission !== undefined) call.missionIds.push(node.mission.id);
      calls.set(key, call);
    }
  }
  return [...calls.values()];
}

/** Which phase each call came to, by the same rule a new call is checked by. */
function placeCalls(
  playbook: Playbook,
  calls: readonly { readonly agent: string; readonly count: number }[],
): { readonly at: number; readonly used: readonly number[] } {
  const used = playbook.phases.map(() => 0);
  let at = -1;
  for (const call of calls) {
    const next = nextPhase(playbook, at, used, call);
    if (next === undefined) break;
    at = next;
    used[at] = (used[at] ?? 0) + 1;
  }
  return { at, used };
}

const fits = (phase: PlaybookPhase, call: { readonly agent: string; readonly count: number }) =>
  phase.tasks !== undefined &&
  phase.tasks.agent === call.agent &&
  call.count >= phase.tasks.min &&
  call.count <= phase.tasks.max;

/**
 * The phase a call may be, after the one at `at`: the same again while it may repeat, or a later
 * one when every phase with tasks between is optional.
 */
function nextPhase(
  playbook: Playbook,
  at: number,
  used: readonly number[],
  call: { readonly agent: string; readonly count: number },
): number | undefined {
  const current = playbook.phases[at];
  if (current !== undefined && (used[at] ?? 0) < (current.repeat ?? 1) && fits(current, call))
    return at;
  for (let index = at + 1; index < playbook.phases.length; index += 1) {
    const phase = playbook.phases[index];
    if (phase === undefined || phase.tasks === undefined) continue;
    if (fits(phase, call)) return index;
    if (phase.optional !== true) return undefined;
  }
  return undefined;
}

/** What a phase asks for, in words, for a refusal. */
const wanted = (phase: PlaybookPhase): string =>
  phase.tasks === undefined
    ? phase.name
    : `${phase.name}: ${
        phase.tasks.min === phase.tasks.max
          ? String(phase.tasks.min)
          : `${String(phase.tasks.min)}-${String(phase.tasks.max)}`
      } ${phase.tasks.agent} task(s)`;

/**
 * Whether the root of a subMission may make this run_subagents call (Orchestration 3.9): the
 * reason it may not, in words the model can act on, or undefined.
 */
export function playbookRefusal(
  records: readonly SessionLogRecord[],
  missionId: string,
  submission: Submission,
  tasks: readonly { readonly agent: string }[],
): string | undefined {
  const { playbook } = submission;
  const calls = callsOf(records, missionId);
  const missions = projectMissions(records);
  const running = calls
    .flatMap((call) => call.missionIds)
    .filter((id) => missions.get(id)?.ended === undefined);
  if (running.length > 0)
    return 'Not started: the tasks of your earlier phase have not all ended. Sleep with until children, then go on with the next phase.';
  const agents = new Set(tasks.map((task) => task.agent));
  const call = {
    agent: agents.size === 1 ? (tasks[0]?.agent ?? '') : 'mixed',
    count: tasks.length,
  };
  const { at, used } = placeCalls(playbook, calls);
  if (nextPhase(playbook, at, used, call) !== undefined) return undefined;
  const allowed: string[] = [];
  const current = playbook.phases[at];
  if (
    current !== undefined &&
    (used[at] ?? 0) < (current.repeat ?? 1) &&
    current.tasks !== undefined
  )
    allowed.push(`${wanted(current)} (again)`);
  for (let index = at + 1; index < playbook.phases.length; index += 1) {
    const phase = playbook.phases[index];
    if (phase?.tasks === undefined) continue;
    allowed.push(wanted(phase));
    if (phase.optional !== true) break;
  }
  return allowed.length === 0
    ? 'Not started: every phase of your playbook that has tasks has run. Finish with finish_subagent.'
    : `Not started: this call does not follow your playbook. The next phase may be: ${allowed.join('; or ')}. A call has tasks of one Agent only.`;
}

/**
 * The phase a call that follows the playbook belongs to: what the phase says of its tasks (their
 * context) holds for the tasks of the call.
 */
export function phaseOfCall(
  records: readonly SessionLogRecord[],
  missionId: string,
  submission: Submission,
  tasks: readonly { readonly agent: string }[],
): PlaybookPhase | undefined {
  const { playbook } = submission;
  const agents = new Set(tasks.map((task) => task.agent));
  const call = {
    agent: agents.size === 1 ? (tasks[0]?.agent ?? '') : 'mixed',
    count: tasks.length,
  };
  const { at, used } = placeCalls(playbook, callsOf(records, missionId));
  const next = nextPhase(playbook, at, used, call);
  return next === undefined ? undefined : playbook.phases[next];
}

/** The phases with tasks that are not optional and have not run yet: done needs none left. */
export function playbookUnfinished(
  records: readonly SessionLogRecord[],
  missionId: string,
  submission: Submission,
): readonly string[] {
  const { playbook } = submission;
  const { used } = placeCalls(playbook, callsOf(records, missionId));
  return playbook.phases.flatMap((phase, index) =>
    phase.tasks !== undefined && phase.optional !== true && (used[index] ?? 0) === 0
      ? [phase.name]
      : [],
  );
}
