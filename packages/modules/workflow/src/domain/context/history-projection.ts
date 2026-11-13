import {
  applyCompactions,
  type ArtifactRef,
  type CompactionRecords,
  type ContextHistoryEntry,
  type SessionLogRecord,
} from '@multiagentos/contracts';
import { answerOf, callResultsOf, handoverFieldsOf } from '../spawn/spawn-graph.js';
import { registeredOf } from '../handover/handover.js';
import { outcomeOf } from '../spawn/task-results.js';
import { missionStateOf, projectMissions, treeView } from '../graph/mission-tree.js';
import { jobEndedNotice, jobOfRequest } from '../graph/mission-jobs.js';
import { rolledBackRanges } from './rolled-back.js';
import { workspaceChangedNote } from '../workspace/workspace-binding.js';

/**
 * What an AgentRun sees (Module/Workflow 8), as a pure function of the log: the same prefix gives
 * the same entries and a later call only appends to an earlier one (invariants 7 and 27). main
 * sees every input of the Session and its work, across runs; a template node sees the run's goal, the handoff it
 * takes as input and its own steps. Tool results name their preview only; `fullRef` never enters
 * a projection. The category is the one field that may change: a prompt is PINNED while its input
 * is the current one.
 */
const MAIN_AGENT_ID = 'main';

/** What a SubAgent is given: its task and the results of the tasks it waits for (M2Design 3.6). */
export interface TaskScope {
  readonly name: string;
  readonly agent: string;
  readonly goal: string;
  readonly acceptance: readonly string[];
  readonly writeScope: readonly string[];
  readonly inputs: readonly ArtifactRef[];
  readonly dependencies: readonly Extract<ContextHistoryEntry, { kind: 'SUBAGENT_RESULT' }>[];
  /**
   * A step of a template (Orchestration 3.5) works from what the user asked as well as from its
   * step; a spawned task works from its task alone.
   */
  readonly withPrompt?: boolean;
}

/**
 * Whose view a projection is. With `missionId`, it is the view of a task: every segment of it, and
 * what was sent to it (Orchestration 3.4, 9.5); main of a chat is the root task of the Session.
 */
export type ProjectionScope =
  | { readonly kind: 'MAIN'; readonly missionId?: string }
  | {
      readonly kind: 'NODE';
      readonly workflowRunId: string;
      readonly agentRunId: string;
      readonly missionId?: string;
      readonly handoff?: { readonly outputRef: ArtifactRef; readonly toolCallId: string };
      readonly task?: TaskScope;
    };

/** What main is told when the previous run was cut short, and why (M2Design 4.5). */
function interruptedNote(
  reason: Extract<SessionLogRecord, { type: 'RUN_INTERRUPTED' }>['reason'],
): string {
  const cause = {
    MEMORY_PRESSURE: 'the system ran short of memory',
    USER_ABORT: 'the user stopped it',
    INPUT_TIMEOUT: 'it ran longer than the time allowed for the work of one message',
    TURN_TIMEOUT: 'it ran longer than the time allowed for the work of one message',
    PAUSE_TIMEOUT: 'it stayed paused for too long',
  }[reason];
  return `The previous run was interrupted because ${cause}. Work in flight was cancelled; check the workspace before relying on it.`;
}

function runtimeNote(context: Extract<SessionLogRecord, { type: 'REQUEST_CONTEXT' }>): string {
  const { workingDirectory, sandbox, currentDate } = context.runtimeContext;
  return `Working directory: ${workingDirectory}\nSandbox: ${sandbox}\nCurrent date: ${currentDate}`;
}

/** What a task reads first when it wakes: why, and that it goes on where it stopped. */
function wokenNote(causes: readonly string[]): string {
  const said: Record<string, string> = {
    CHILDREN: 'subtasks you started have ended (their results are just above)',
    SIBLINGS: 'the sibling tasks you waited for have ended (see the notices above)',
    JOB: 'a background command of yours has ended',
    MESSAGE: 'a message came for you (just above)',
    TIMER: 'the time you set has passed',
    TIMEOUT: 'you slept as long as you allowed yourself',
    HUMAN: 'the user answered',
    STALLED:
      'nothing else could move: every task was waiting, so you are woken to decide what to do',
    ROLLED_BACK: 'the work was rolled back to a checkpoint',
    RESUMED: 'the work was resumed after the process stopped',
    INTERRUPTED: 'your parent interrupted you (its message is just above): deal with it first',
  };
  const reasons = [...new Set(causes)].map((cause) => said[cause] ?? cause.toLowerCase());
  return `You were woken: ${reasons.join('; ')}. This is a new segment of the same task: your earlier work is above. Continue from your note and what came in.`;
}

export interface ProjectionOptions {
  /**
   * The material of a compaction: what the provider counted on every model turn (`measured`),
   * and the request and the full output of every tool result. Kernel wants them, the model
   * never sees them, and an ordinary projection must stay as it is for the digest.
   */
  readonly material?: boolean;
}

/** The longest NOTE the contract takes. */
const NOTE_MAX = 2000;
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** A NOTE is at most 2000 characters; a workspace can differ in hundreds of files. */
const DIVERGED_NOTE_MAX = 1600;
const DIVERGED_PATH_MAX = 200;

/** Names as many of the changed files as fit, and says how many more there are. */
export function divergedNote(files: readonly string[]): string {
  const head =
    'These files changed outside this session since its last turn; read them again before relying on them: ';
  const named: string[] = [];
  let length = head.length;
  for (const file of files) {
    const path = file.length > DIVERGED_PATH_MAX ? `${file.slice(0, DIVERGED_PATH_MAX)}…` : file;
    // Leave room for ", " and for the sentence that counts the rest.
    if (length + path.length + 2 > DIVERGED_NOTE_MAX) break;
    named.push(path);
    length += path.length + 2;
  }
  const rest = files.length - named.length;
  return `${head}${named.join(', ')}${rest > 0 ? ` (and ${String(rest)} more; use git status to see them all)` : ''}`;
}

export function projectHistory(
  records: readonly SessionLogRecord[],
  scope: ProjectionScope,
  options: ProjectionOptions = {},
): readonly ContextHistoryEntry[] {
  const mainRuns = new Set<string>();
  /** The AgentRun that runs a node: what a node-level record is read for. */
  const runOfNode = new Map<string, string>();
  const unitOwners = new Map<string, { toolCallId: string }>();
  const toolNames = new Map<string, string>();
  const entries: ContextHistoryEntry[] = [];
  /** Notes of the user that wait for the next assembly of the AgentRun they are for. */
  const notes: ContextHistoryEntry[] = [];
  /** The job a command's result started, by its request (Orchestration 6.1). */
  const jobs = jobOfRequest(records);
  const jobCommands = new Map<string, string>();
  /** Calls that already have their answer: a second one would break the history. */
  const answered = new Set<string>();
  const instructions = new Set<string>();
  /** The AgentRun an assembly was for, and the head of the last assembly of each AgentRun. */
  const assemblyOwner = new Map<string, string>();
  const lastHead = new Map<string, string>();
  const compaction: CompactionRecords = { pruned: [], compacted: [], revoked: new Set() };
  const isTarget = (target: { kind: 'MAIN' } | { kind: 'AGENT_RUN'; agentRunId: string }) =>
    scope.kind === 'MAIN'
      ? target.kind === 'MAIN'
      : target.kind === 'AGENT_RUN' &&
        (target.agentRunId === scope.agentRunId || mainRuns.has(target.agentRunId));
  /** The task whose view this is, when it is one (Orchestration 3.4). */
  const ownMission = scope.missionId;
  /** What the view knows of every task: to tell a child's result and its last segment. */
  const missionInfo = new Map<
    string,
    { readonly parentId?: string; readonly name: string; readonly agent: string; last?: string }
  >();
  const nodeMission = new Map<string, string>();
  let taskShown = false;
  let treeShown = false;
  let planShown = false;
  const ownParentOf = (): string | undefined =>
    ownMission === undefined ? undefined : missionInfo.get(ownMission)?.parentId;
  /** Siblings already told of, so a sibling is announced once (Orchestration 3.7). */
  const announced = new Set<string>();
  /** The order tasks were written in, for results delivered together (M2Design 3.6). */
  const writtenOrder = new Map<string, number>();
  const resultOrder = new Map<ContextHistoryEntry, number>();
  /**
   * What waited for the next assembly joins the history: results in the order their tasks were
   * written, so the context does not depend on which ended first, then the rest in log order.
   */
  const flush = () => {
    const results = notes
      .filter((entry) => entry.kind === 'SUBAGENT_RESULT')
      .sort((a, b) => (resultOrder.get(a) ?? 0) - (resultOrder.get(b) ?? 0));
    entries.push(...results, ...notes.filter((entry) => entry.kind !== 'SUBAGENT_RESULT'));
    notes.length = 0;
  };
  let modelId = 'unknown';
  /** Where the user's latest input is: what it and the notes after it say stays pinned. */
  let currentInput: number | undefined;
  let lastNote: string | undefined;

  // What a way back took back (Orchestration 7.5): an undo from the input it undid, a rewind from
  // the call that made the checkpoint, up to the rollback, nothing is shown; the tasks it
  // cancelled hand nothing over afterwards.
  const rewinds = rolledBackRanges(records);
  const takenBack = new Set(
    records.flatMap((record) => (record.type === 'ROLLED_BACK' ? record.cancelledMissionIds : [])),
  );
  const undoneBefore = legacyUndone(records);
  for (const record of records) {
    if (rewinds.some((rewind) => record.seq >= rewind.from && record.seq < rewind.to)) continue;
    if (undoneBefore.has(record.seq)) continue;
    if (
      (record.type === 'MISSION_ENDED' && takenBack.has(record.missionId)) ||
      (record.type === 'MISSION_MESSAGE' && takenBack.has(record.from))
    )
      continue;
    switch (record.type) {
      case 'ROLLED_BACK':
        if (record.undo === true) {
          // An undo is the user's, in a chat: main is told what it no longer sees.
          if (ownMission !== undefined && missionInfo.get(ownMission)?.parentId !== undefined)
            break;
          entries.push({
            seq: record.seq,
            category: 'NORMAL',
            kind: 'NOTE',
            text: 'The user undid the last exchange: its messages and steps are gone from this history, and the files it changed are back as they were.',
          });
          break;
        }
        if (ownMission === undefined) break;
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text:
            record.resumed === true
              ? missionInfo.get(ownMission)?.parentId === undefined
                ? `The process stopped in the middle of this work, and it goes on now from the checkpoint "${record.label}": what came after it is taken back, and ${String(record.files)} file(s) are as they were then. Background commands that ran then were stopped; run them again if they are still needed. Every subtask that was there then is paused where it was: send it a message (send_message) to let it go on from there, or stop it (stop_subagents); view_tasks shows them. A question that was open then is asked again. Decide how to go on.`
                : `The process stopped in the middle of this work, and it goes on now from the checkpoint "${record.label}": what you did after it is taken back, and the files are as they were then. Background commands that ran then were stopped. You were paused there until your parent let you go on (its message is below): continue from where you were.`
              : missionInfo.get(ownMission)?.parentId === undefined
                ? `The work went back to the checkpoint "${record.label}": what came after it is taken back, and ${String(record.files)} file(s) are as they were then. The subtasks started after it are gone. Every subtask that was there then is paused where it was: send it a message (send_message) to let it go on from there, or stop it (stop_subagents); view_tasks shows them. A question that was open then is asked again. Decide how to go on.`
                : `The work went back to the checkpoint "${record.label}": what you did after it is taken back, and the files are as they were then. You were paused there until your parent let you go on (its message is below): continue from where you were.`,
        });
        break;
      case 'AGENT_RUN_REGISTERED':
        runOfNode.set(record.nodeId, record.agentRunId);
        if (scope.kind === 'NODE') {
          // A task's view is every segment of it; without one, the AgentRun's own.
          const member =
            ownMission !== undefined
              ? record.missionId === ownMission || record.agentRunId === scope.agentRunId
              : record.agentRunId === scope.agentRunId;
          if (!member) break;
          mainRuns.add(record.agentRunId);
          // The task is told once, at its first segment; a later one finds it above.
          if (scope.task !== undefined && !taskShown) {
            taskShown = true;
            entries.push({
              seq: record.seq,
              category: 'PINNED',
              kind: 'TASK',
              name: scope.task.name,
              agent: scope.task.agent,
              goal: scope.task.goal,
              acceptance: [...scope.task.acceptance],
              writeScope: [...scope.task.writeScope],
              inputs: [...scope.task.inputs],
            });
            for (const dependency of scope.task.dependencies)
              entries.push({ ...dependency, seq: record.seq });
          }
          // A task below the root reads the plan of the work right after its task (D24); a later
          // plan comes to it as a notice.
          if (ownParentOf() !== undefined && !planShown) {
            planShown = true;
            const plan = latestPlan(
              records.slice(0, records.indexOf(record) + 1),
              record.workflowRunId,
            );
            if (plan !== undefined)
              entries.push({
                seq: record.seq,
                category: 'PINNED',
                kind: 'PLAN',
                outputRef: plan.source.outputRef,
                toolCallId: plan.source.toolCallId,
              });
          }
          // After its task, a task below the root is shown where it stands in the tree, once, as
          // the log was then
          // (Orchestration 3.7); changes come as notices after it.
          const ownParent =
            ownMission === undefined ? undefined : missionInfo.get(ownMission)?.parentId;
          if (ownParent !== undefined && !treeShown) {
            treeShown = true;
            const before = records.slice(0, records.indexOf(record) + 1);
            entries.push({
              seq: record.seq,
              category: 'PINNED',
              kind: 'NOTE',
              text: clip(
                treeView(projectMissions(before), ownMission ?? '', missionStateOf(before)),
                NOTE_MAX,
              ),
            });
          }
          if (scope.handoff !== undefined)
            entries.push({
              seq: record.seq,
              category: 'PINNED',
              kind: 'HANDOFF',
              ...scope.handoff,
            });
        } else if (
          ownMission !== undefined && record.missionId !== undefined
            ? record.missionId === ownMission
            : record.agentRef.id === MAIN_AGENT_ID
        ) {
          mainRuns.add(record.agentRunId);
        }
        break;
      case 'GRAPH_EXTENDED':
        for (const node of record.nodes) {
          if (node.mission === undefined || node.kind !== 'AGENT') continue;
          // A new sibling, once this task knows where it stands, is told of when it is added.
          const ownParent =
            ownMission === undefined ? undefined : missionInfo.get(ownMission)?.parentId;
          if (
            treeShown &&
            ownParent !== undefined &&
            node.mission.parentId === ownParent &&
            node.mission.id !== ownMission &&
            !missionInfo.has(node.mission.id) &&
            !announced.has(node.mission.id)
          ) {
            announced.add(node.mission.id);
            notes.push({
              seq: record.seq,
              category: 'NORMAL',
              kind: 'NOTE',
              text: clip(
                `A sibling task was started: ${node.name} (${node.agentRef?.id ?? 'unknown'})${node.spawn?.role === undefined ? '' : ` — ${node.spawn.role}`}.`,
                NOTE_MAX,
              ),
            });
          }
          nodeMission.set(node.nodeId, node.mission.id);
          if (!writtenOrder.has(node.mission.id))
            writtenOrder.set(node.mission.id, writtenOrder.size);
          if (!missionInfo.has(node.mission.id))
            missionInfo.set(node.mission.id, {
              ...(node.mission.parentId === undefined ? {} : { parentId: node.mission.parentId }),
              name: node.name,
              agent: node.agentRef?.id ?? 'unknown',
            });
        }
        break;
      case 'NODE_STARTED': {
        const missionId = nodeMission.get(record.nodeId);
        const info = missionId === undefined ? undefined : missionInfo.get(missionId);
        if (info !== undefined) info.last = record.nodeId;
        break;
      }
      case 'MISSION_ENDED': {
        // A child of this task has ended: its result waits for the next assembly of the task,
        // whichever segment that is (Orchestration 4.3).
        const info = missionInfo.get(record.missionId);
        const ownParent =
          ownMission === undefined ? undefined : missionInfo.get(ownMission)?.parentId;
        if (
          treeShown &&
          ownParent !== undefined &&
          info?.parentId === ownParent &&
          record.missionId !== ownMission
        ) {
          notes.push({
            seq: record.seq,
            category: 'NORMAL',
            kind: 'NOTE',
            text: `A sibling task has ended: ${info.name} (${record.status.toLowerCase()}).`,
          });
          break;
        }
        if (ownMission === undefined || info?.parentId !== ownMission) break;
        const outcome =
          info.last === undefined ? undefined : outcomeOf(records, record.workflowRunId, info.last);
        const status =
          outcome?.status ??
          (record.status === 'SUCCEEDED' ? ('DONE' as const) : ('FAILED' as const));
        const result: ContextHistoryEntry = {
          seq: record.seq,
          category: 'NORMAL',
          kind: 'SUBAGENT_RESULT',
          name: info.name,
          agent: info.agent,
          status,
          notes: [...(outcome?.notes ?? [])],
          ...(outcome?.outputRef === undefined ? {} : { outputRef: outcome.outputRef }),
          ...(outcome?.toolCallId === undefined ? {} : { toolCallId: outcome.toolCallId }),
          ...(outcome === undefined ? {} : handoverFieldsOf(records, outcome)),
        };
        resultOrder.set(result, writtenOrder.get(record.missionId) ?? 0);
        notes.push(result);
        break;
      }
      case 'MISSION_MESSAGE':
        if (ownMission === undefined || !record.to.includes(ownMission)) break;
        notes.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'MESSAGE',
          from: record.fromLabel,
          ...(record.interrupt === true ? { interrupt: true } : {}),
          ...(record.kind === undefined ? {} : { messageKind: record.kind }),
          ...(record.replyTo === undefined ? {} : { replyTo: record.replyTo }),
          ...(record.referenceId === undefined
            ? {}
            : messageReferences(records, record.referenceId)),
          outputRef: record.source.outputRef,
          toolCallId: record.source.toolCallId,
        });
        break;
      case 'MESSAGE_UNANSWERED':
        if (record.missionId !== ownMission) break;
        notes.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text: `Task ${record.fromLabel} ended without answering your request ${record.requestToolCallId}; no reply will come.`,
        });
        break;
      case 'PLAN_REGISTERED':
        // A plan written after the task began reaches it at its next assembly.
        if (!planShown || ownParentOf() === undefined) break;
        notes.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'PLAN',
          outputRef: record.source.outputRef,
          toolCallId: record.source.toolCallId,
        });
        break;
      case 'JOB_STARTED':
        if (record.missionId === ownMission) jobCommands.set(record.jobId, record.command);
        break;
      case 'JOB_ENDED':
        // A job's end reaches its task at the next assembly (Orchestration 6.4).
        if (record.missionId !== ownMission) break;
        notes.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text: clip(
            jobEndedNotice(record, jobCommands.get(record.jobId) ?? 'a command'),
            NOTE_MAX,
          ),
        });
        break;
      case 'MISSION_WOKEN':
        if (record.missionId !== ownMission) break;
        notes.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text: wokenNote(record.causes.map((cause) => cause.kind)),
        });
        break;
      case 'HUMAN_ANSWERED':
        if (scope.kind === 'NODE' && record.workflowRunId !== scope.workflowRunId) break;
        if (record.kind === 'steer') {
          // A note is for one AgentRun, or for main's next input when its target had ended.
          const mine =
            scope.kind === 'NODE'
              ? record.attachedAgentRunId !== undefined && mainRuns.has(record.attachedAgentRunId)
              : record.attachedAgentRunId === undefined || mainRuns.has(record.attachedAgentRunId);
          if (!mine) break;
          const note: ContextHistoryEntry = {
            seq: record.seq,
            category: 'NORMAL',
            kind: 'HUMAN',
            contentRef: record.contentRef,
          };
          // It joins the history where the AgentRun next assembles it, after the results of the
          // round in flight (a result must follow its call), and earlier entries stay as they were.
          if (record.attachedAgentRunId === undefined) entries.push(note);
          else notes.push(note);
          break;
        }
        if (record.kind === 'prompt') currentInput = record.seq;
        if (record.kind !== 'prompt') {
          // The answer to a question that slept (Orchestration 4.1): the call was answered when
          // the segment ended, so the answer comes to the next segment as what the user said.
          const resume = records
            .filter(
              (each): each is Extract<SessionLogRecord, { type: 'GRAPH_EXTENDED' }> =>
                each.type === 'GRAPH_EXTENDED' && each.workflowRunId === record.workflowRunId,
            )
            .flatMap((each) => each.edges)
            .find((edge) => edge.kind === 'RESUME' && edge.from === record.nodeId);
          const toolCallId = resume?.call?.toolCallId;
          if (
            resume !== undefined &&
            toolCallId !== undefined &&
            answered.has(toolCallId) &&
            mainRuns.has(runOfNode.get(resume.to) ?? '')
          )
            notes.push(
              {
                seq: record.seq,
                category: 'NORMAL',
                kind: 'NOTE',
                text: 'The user answered the question you asked with ask_user; the answer follows.',
              },
              {
                seq: record.seq,
                category: 'NORMAL',
                kind: 'HUMAN',
                contentRef: record.contentRef,
              },
            );
          break;
        }
        // A SubAgent works from its task, not from what the user said.
        if (scope.kind === 'NODE' && scope.task !== undefined && scope.task.withPrompt !== true)
          break;
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'HUMAN',
          contentRef: record.contentRef,
        });
        break;
      case 'REQUEST_CONTEXT':
        if (!mainRuns.has(record.agentRunId)) break;
        modelId = record.modelRef.id;
        if (runtimeNote(record) !== lastNote) {
          lastNote = runtimeNote(record);
          entries.push({
            seq: record.seq,
            category: 'NORMAL',
            kind: 'NOTE',
            text: lastNote,
          });
        }
        break;
      case 'UNIT_SUBMITTED':
        // The assembly of a round takes the notes that arrived since the last one.
        if (mainRuns.has(record.agentRunId) && record.unitRef.id === 'context-assemble') {
          flush();
          assemblyOwner.set(record.requestId, record.agentRunId);
        }
        if (mainRuns.has(record.agentRunId) && record.inputSource.kind === 'TOOL_CALL') {
          unitOwners.set(record.requestId, {
            toolCallId: record.inputSource.toolCallId,
          });
        }
        break;
      case 'CONTEXT_ASSEMBLED': {
        const owner = assemblyOwner.get(record.requestId);
        if (owner !== undefined) lastHead.set(owner, record.headDigest);
        break;
      }
      case 'TOOL_RESULTS_PRUNED':
        if (isTarget(record.target)) compaction.pruned.push(record);
        break;
      case 'CONTEXT_COMPACTED':
        if (isTarget(record.target)) compaction.compacted.push(record);
        break;
      case 'CONTEXT_COMPACTION_REVOKED':
        compaction.revoked.add(record.compactionId);
        break;
      case 'MODEL_TURN': {
        if (!mainRuns.has(record.agentRunId)) break;
        for (const call of record.toolCalls) toolNames.set(call.toolCallId, call.toolName);
        const head = lastHead.get(record.agentRunId);
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'MODEL_TURN',
          modelId,
          outputRef: record.outputRef,
          ...(record.reasoningRef === undefined ? {} : { reasoningRef: record.reasoningRef }),
          replayable: record.replayable,
          ...(options.material === true && record.usage !== undefined && head !== undefined
            ? {
                measured: {
                  inputTokens: record.usage.inputTokens,
                  outputTokens: record.usage.outputTokens,
                  headDigest: head,
                },
              }
            : {}),
        });
        break;
      }
      case 'UNIT_COMPLETED': {
        const owner = unitOwners.get(record.requestId);
        if (owner === undefined) break;
        const jobId = jobs.get(record.requestId);
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'TOOL_RESULT',
          toolCallId: owner.toolCallId,
          toolName: toolNames.get(owner.toolCallId) ?? 'unknown',
          status: record.status,
          ...(jobId === undefined ? {} : { jobId }),
          ...(record.outputRef === undefined ? {} : { outputRef: record.outputRef }),
          ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
          ...(options.material === true
            ? {
                requestId: record.requestId,
                ...(record.fullRef === undefined ? {} : { fullRef: record.fullRef }),
              }
            : {}),
        });
        break;
      }
      case 'UNIT_INTERRUPTED': {
        // A pause or an abort is answered by Workflow itself, or the Unit is submitted again.
        if (record.reason === 'PAUSED' || record.reason === 'ABORTED') break;
        const owner = unitOwners.get(record.requestId);
        if (owner === undefined) break;
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'TOOL_RESULT',
          toolCallId: owner.toolCallId,
          toolName: toolNames.get(owner.toolCallId) ?? 'unknown',
          status: 'INTERRUPTED',
        });
        break;
      }
      case 'WORKSPACE_REVERTED': {
        // An undo of a log written before checkpoints replaced Turns: what it took back was left
        // out above; the log keeps every record (Module/Workflow 7).
        const reverted = new Set(record.revertedTurnIds);
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text: `The user undid the last ${String(reverted.size)} turn(s): their messages and steps are gone from this history, and the files they changed are back as they were.`,
        });
        break;
      }
      case 'WORKSPACE_BOUND': {
        // The folder changed (M2Design 2.3): the project instructions loaded so far were the old
        // folder's, and they are read again from the new one.
        for (let i = entries.length - 1; i >= 0; i -= 1)
          if (entries[i]?.kind === 'PROJECT_INSTRUCTIONS') entries.splice(i, 1);
        instructions.clear();
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text: workspaceChangedNote(record.previousRoot, record.repositoryRoot),
        });
        break;
      }
      case 'WORKSPACE_DIVERGED':
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text: divergedNote(record.files),
        });
        break;
      case 'RUN_INTERRUPTED':
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text: interruptedNote(record.reason),
        });
        break;
      case 'PROJECT_FILE_LOADED':
        // Appended at the end like any new fact, so a later call keeps the earlier prefix;
        // the same content is not repeated in a later run.
        if (scope.kind === 'NODE' && record.workflowRunId !== scope.workflowRunId) break;
        if (record.agentRunId !== undefined) {
          const own =
            scope.kind === 'NODE'
              ? record.agentRunId === scope.agentRunId
              : mainRuns.has(record.agentRunId);
          if (!own) break;
        }
        if (!('ref' in record)) {
          entries.push({
            seq: record.seq,
            category: 'NORMAL',
            kind: 'NOTE',
            text: `${record.path} exists but was not loaded, because of the limit on such files; read_file can read it.`,
          });
          break;
        }
        if (instructions.has(`${record.path}\0${record.sha256}`)) break;
        // A file has one place: what it says now takes the place of what it said before.
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const earlier = entries[i];
          if (earlier?.kind === 'PROJECT_INSTRUCTIONS' && earlier.path === record.path)
            entries.splice(i, 1);
        }
        for (const key of [...instructions])
          if (key.startsWith(`${record.path}\0`)) instructions.delete(key);
        instructions.add(`${record.path}\0${record.sha256}`);
        entries.push({
          seq: record.seq,
          category: 'PINNED',
          kind: 'PROJECT_INSTRUCTIONS',
          path: record.path,
          ref: record.ref,
          trusted: record.trusted ?? false,
        });
        break;
      case 'FEEDBACK':
        if (!mainRuns.has(record.agentRunId)) break;
        if (record.toolCallId !== undefined) answered.add(record.toolCallId);
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'FEEDBACK',
          text: record.message,
          ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
        });
        break;
      case 'NODE_RESUMED': {
        // The call it woke from is answered by what its tasks came to, in the order they were
        // written (M2Design 3.3, 3.6): a pure function of the log, so no record of it is kept.
        if (!mainRuns.has(runOfNode.get(record.nodeId) ?? '')) break;
        // A run that was interrupted answered its open calls itself.
        if (answered.has(record.call.toolCallId)) break;
        answered.add(record.call.toolCallId);
        // A question to the user: the answer is the result of the call.
        const answer = answerOf(
          records,
          record.workflowRunId,
          record.nodeId,
          record.call.toolCallId,
        );
        if (answer !== undefined) {
          entries.push({
            seq: record.seq,
            category: 'NORMAL',
            kind: 'HUMAN_ANSWER',
            toolCallId: record.call.toolCallId,
            question: answer.kind,
            contentRef: answer.contentRef,
          });
          break;
        }
        const results = callResultsOf(
          records,
          record.workflowRunId,
          record.nodeId,
          record.call.toolCallId,
        );
        const count = (...statuses: string[]) =>
          results.filter((result) => statuses.includes(result.status)).length;
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'FEEDBACK',
          text: `${String(results.length)} subtask(s) finished: ${String(count('DONE'))} done, ${String(count('PARTIAL', 'BLOCKED'))} partial or blocked, ${String(count('FAILED'))} failed, ${String(count('SKIPPED'))} skipped. Their results follow, in the order you wrote the tasks.`,
          toolCallId: record.call.toolCallId,
        });
        for (const result of results)
          entries.push({
            seq: record.seq,
            category: 'NORMAL',
            kind: 'SUBAGENT_RESULT',
            name: result.name,
            agent: result.agent,
            status: result.status,
            notes: [...result.notes],
            ...(result.outputRef === undefined ? {} : { outputRef: result.outputRef }),
            ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
            ...(result.referenceId === undefined ? {} : { referenceId: result.referenceId }),
            ...(result.references === undefined ? {} : { references: [...result.references] }),
          });
        break;
      }
      case 'STALE_UNITS_SETTLED':
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text: 'The previous process ended before this work finished.',
        });
        break;
      default:
        break;
    }
  }
  // A note that came after the last assembly is the last thing in the history.
  flush();
  const shown = entries.map((entry) =>
    entry.kind === 'HUMAN' &&
    (scope.kind === 'NODE' || (currentInput !== undefined && entry.seq >= currentInput))
      ? { ...entry, category: 'PINNED' as const }
      : entry,
  );
  return applyCompactions(shown, compaction);
}

/** The plan of the work as it stood: the last one the run registered (Orchestration 5.3). */
function latestPlan(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
): Extract<SessionLogRecord, { type: 'PLAN_REGISTERED' }> | undefined {
  let found: Extract<SessionLogRecord, { type: 'PLAN_REGISTERED' }> | undefined;
  for (const record of records)
    if (record.type === 'PLAN_REGISTERED' && record.workflowRunId === workflowRunId) found = record;
  return found;
}

/** The handover a message carries, as its entry shows it (D25). */
function messageReferences(
  records: readonly SessionLogRecord[],
  referenceId: string,
): { referenceId?: string; references?: { toolCallId: string; tool: string }[] } {
  const handover = registeredOf(records, referenceId);
  return handover === undefined
    ? {}
    : {
        referenceId: handover.referenceId,
        references: handover.items.map(({ toolCallId, tool }) => ({ toolCallId, tool })),
      };
}

/**
 * What an undo of a log written before checkpoints replaced Turns took back (Module/Workflow 7):
 * every record of the Turns it names that came before it. A record that names no Turn belongs to
 * the one whose start it follows.
 */
function legacyUndone(records: readonly SessionLogRecord[]): ReadonlySet<number> {
  const undone = new Set<number>();
  const reverts = records.filter(
    (record): record is Extract<SessionLogRecord, { type: 'WORKSPACE_REVERTED' }> =>
      record.type === 'WORKSPACE_REVERTED',
  );
  if (reverts.length === 0) return undone;
  let current: string | undefined;
  for (const record of records) {
    if (record.type === 'TURN_STARTED') current = record.turnId;
    const turn = ('turnId' in record ? record.turnId : undefined) ?? current;
    if (turn === undefined) continue;
    if (reverts.some((revert) => revert.seq > record.seq && revert.revertedTurnIds.includes(turn)))
      undone.add(record.seq);
  }
  return undone;
}
