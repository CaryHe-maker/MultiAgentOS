import {
  applyCompactions,
  type ArtifactRef,
  type CompactionRecords,
  type ContextHistoryEntry,
  type SessionLogRecord,
} from '@multiagentos/contracts';
import { answerOf, callResultsOf } from '../spawn/spawn-graph.js';

/**
 * What an AgentRun sees (Module/Workflow 8), as a pure function of the log: the same prefix gives
 * the same entries and a later call only appends to an earlier one (invariants 7 and 27). main
 * sees every Turn of the Session, across runs; a template node sees the run's goal, the handoff it
 * takes as input and its own steps. Tool results name their preview only; `fullRef` never enters
 * a projection. The category is the one field that may change: a prompt is PINNED while its Turn
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
}

export type ProjectionScope =
  | { readonly kind: 'MAIN' }
  | {
      readonly kind: 'NODE';
      readonly workflowRunId: string;
      readonly agentRunId: string;
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
    TURN_TIMEOUT: 'it ran longer than the time allowed for one turn',
    PAUSE_TIMEOUT: 'it stayed paused for too long',
  }[reason];
  return `The previous run was interrupted because ${cause}. Work in flight was cancelled; check the workspace before relying on it.`;
}

function runtimeNote(context: Extract<SessionLogRecord, { type: 'REQUEST_CONTEXT' }>): string {
  const { workingDirectory, sandbox, currentDate } = context.runtimeContext;
  return `Working directory: ${workingDirectory}\nSandbox: ${sandbox}\nCurrent date: ${currentDate}`;
}

export interface ProjectionOptions {
  /**
   * The material of a compaction: what the provider counted on every model turn (`measured`),
   * and the request and the full output of every tool result. Kernel wants them, the model
   * never sees them, and an ordinary projection must stay as it is for the digest.
   */
  readonly material?: boolean;
}

export function projectHistory(
  records: readonly SessionLogRecord[],
  scope: ProjectionScope,
  options: ProjectionOptions = {},
): readonly ContextHistoryEntry[] {
  const mainRuns = new Set<string>();
  /** The AgentRun that runs a node: what a node-level record is read for. */
  const runOfNode = new Map<string, string>();
  const unitOwners = new Map<string, { toolCallId: string; turnId?: string }>();
  const toolNames = new Map<string, string>();
  const entries: ContextHistoryEntry[] = [];
  /** Notes of the user that wait for the next assembly of the AgentRun they are for. */
  const notes: ContextHistoryEntry[] = [];
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
      : target.kind === 'AGENT_RUN' && target.agentRunId === scope.agentRunId;
  let modelId = 'unknown';
  let currentTurn: string | undefined;
  let lastNote: string | undefined;

  const turnOf = (turnId: string | undefined) => (turnId === undefined ? {} : { turnId });

  for (const record of records) {
    switch (record.type) {
      case 'TURN_STARTED':
        currentTurn = record.turnId;
        break;
      case 'AGENT_RUN_REGISTERED':
        runOfNode.set(record.nodeId, record.agentRunId);
        if (scope.kind === 'NODE') {
          if (record.agentRunId !== scope.agentRunId) break;
          mainRuns.add(record.agentRunId);
          if (scope.task !== undefined) {
            entries.push({
              seq: record.seq,
              ...turnOf(record.turnId),
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
              entries.push({ ...dependency, seq: record.seq, ...turnOf(record.turnId) });
          }
          if (scope.handoff !== undefined)
            entries.push({
              seq: record.seq,
              ...turnOf(record.turnId),
              category: 'PINNED',
              kind: 'HANDOFF',
              ...scope.handoff,
            });
        } else if (record.agentRef.id === MAIN_AGENT_ID) {
          mainRuns.add(record.agentRunId);
        }
        break;
      case 'HUMAN_ANSWERED':
        if (scope.kind === 'NODE' && record.workflowRunId !== scope.workflowRunId) break;
        if (record.kind === 'steer') {
          // A note is for one AgentRun, or for the next Turn of main when its target had ended.
          const mine =
            scope.kind === 'NODE'
              ? record.attachedAgentRunId === scope.agentRunId
              : record.attachedAgentRunId === undefined || mainRuns.has(record.attachedAgentRunId);
          if (!mine) break;
          const note: ContextHistoryEntry = {
            seq: record.seq,
            ...turnOf(record.turnId),
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
        if (record.kind !== 'prompt') break;
        // A SubAgent works from its task, not from what the user said.
        if (scope.kind === 'NODE' && scope.task !== undefined) break;
        entries.push({
          seq: record.seq,
          ...turnOf(record.turnId),
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
            ...turnOf(record.turnId),
            category: 'NORMAL',
            kind: 'NOTE',
            text: lastNote,
          });
        }
        break;
      case 'UNIT_SUBMITTED':
        // The assembly of a round takes the notes that arrived since the last one.
        if (mainRuns.has(record.agentRunId) && record.unitRef.id === 'context-assemble') {
          entries.push(...notes);
          notes.length = 0;
          assemblyOwner.set(record.requestId, record.agentRunId);
        }
        if (mainRuns.has(record.agentRunId) && record.inputSource.kind === 'TOOL_CALL') {
          unitOwners.set(record.requestId, {
            toolCallId: record.inputSource.toolCallId,
            ...turnOf(record.turnId),
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
          ...turnOf(record.turnId),
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
        entries.push({
          seq: record.seq,
          ...turnOf(owner.turnId),
          category: 'NORMAL',
          kind: 'TOOL_RESULT',
          toolCallId: owner.toolCallId,
          toolName: toolNames.get(owner.toolCallId) ?? 'unknown',
          status: record.status,
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
          ...turnOf(owner.turnId),
          category: 'NORMAL',
          kind: 'TOOL_RESULT',
          toolCallId: owner.toolCallId,
          toolName: toolNames.get(owner.toolCallId) ?? 'unknown',
          status: 'INTERRUPTED',
        });
        break;
      }
      case 'WORKSPACE_REVERTED': {
        // The log keeps every record; only what the model is shown goes (Module/Workflow 7).
        const reverted = new Set(record.revertedTurnIds);
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const { turnId } = entries[i] ?? {};
          if (turnId === undefined || !reverted.has(turnId)) continue;
          const [gone] = entries.splice(i, 1);
          // Touched again, it is loaded again.
          if (gone?.kind === 'PROJECT_INSTRUCTIONS')
            for (const key of instructions)
              if (key.startsWith(`${gone.path}\0`)) instructions.delete(key);
        }
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text: `The user undid the last ${String(reverted.size)} turn(s): their messages and steps are gone from this history, and the files they changed are back as they were.`,
        });
        break;
      }
      case 'WORKSPACE_DIVERGED':
        entries.push({
          seq: record.seq,
          category: 'NORMAL',
          kind: 'NOTE',
          text: `These files changed outside this session since its last turn; read them again before relying on them: ${record.files.join(', ')}`,
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
            ...turnOf(currentTurn),
            category: 'NORMAL',
            kind: 'NOTE',
            text: `${record.path} exists but was not loaded, because of the limit on such files; read_file can read it.`,
          });
          break;
        }
        if (instructions.has(`${record.path}\0${record.sha256}`)) break;
        instructions.add(`${record.path}\0${record.sha256}`);
        entries.push({
          seq: record.seq,
          // A nested file goes with its Turn; the root one is read for the whole run.
          ...(record.agentRunId === undefined ? {} : turnOf(currentTurn)),
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
          ...turnOf(record.turnId),
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
            ...turnOf(record.turnId),
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
          ...turnOf(record.turnId),
          category: 'NORMAL',
          kind: 'FEEDBACK',
          text: `${String(results.length)} subtask(s) finished: ${String(count('DONE'))} done, ${String(count('PARTIAL', 'BLOCKED'))} partial or blocked, ${String(count('FAILED'))} failed, ${String(count('SKIPPED'))} skipped. Their results follow, in the order you wrote the tasks.`,
          toolCallId: record.call.toolCallId,
        });
        for (const result of results)
          entries.push({
            seq: record.seq,
            ...turnOf(record.turnId),
            category: 'NORMAL',
            kind: 'SUBAGENT_RESULT',
            name: result.name,
            agent: result.agent,
            status: result.status,
            notes: [...result.notes],
            ...(result.outputRef === undefined ? {} : { outputRef: result.outputRef }),
            ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
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
  entries.push(...notes);
  const shown = entries.map((entry) =>
    entry.kind === 'HUMAN' &&
    (scope.kind === 'NODE' || (entry.turnId !== undefined && entry.turnId === currentTurn))
      ? { ...entry, category: 'PINNED' as const }
      : entry,
  );
  return applyCompactions(shown, compaction);
}
