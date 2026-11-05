import type { ArtifactRef, ContextHistoryEntry, SessionLogRecord } from '@multiagentos/contracts';

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

function runtimeNote(context: Extract<SessionLogRecord, { type: 'REQUEST_CONTEXT' }>): string {
  const { workingDirectory, sandbox, currentDate } = context.runtimeContext;
  return `Working directory: ${workingDirectory}\nSandbox: ${sandbox}\nCurrent date: ${currentDate}`;
}

export function projectHistory(
  records: readonly SessionLogRecord[],
  scope: ProjectionScope,
): readonly ContextHistoryEntry[] {
  const mainRuns = new Set<string>();
  const unitOwners = new Map<string, { toolCallId: string; turnId?: string }>();
  const toolNames = new Map<string, string>();
  const entries: ContextHistoryEntry[] = [];
  const instructions = new Set<string>();
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
        if (mainRuns.has(record.agentRunId) && record.inputSource.kind === 'TOOL_CALL') {
          unitOwners.set(record.requestId, {
            toolCallId: record.inputSource.toolCallId,
            ...turnOf(record.turnId),
          });
        }
        break;
      case 'MODEL_TURN':
        if (!mainRuns.has(record.agentRunId)) break;
        for (const call of record.toolCalls) toolNames.set(call.toolCallId, call.toolName);
        entries.push({
          seq: record.seq,
          ...turnOf(record.turnId),
          category: 'NORMAL',
          kind: 'MODEL_TURN',
          modelId,
          outputRef: record.outputRef,
          ...(record.reasoningRef === undefined ? {} : { reasoningRef: record.reasoningRef }),
          replayable: record.replayable,
        });
        break;
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
        });
        break;
      }
      case 'UNIT_INTERRUPTED': {
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
          text: 'The previous run was interrupted because the system ran short of memory. Work in flight was cancelled; check the workspace before relying on it.',
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
        entries.push({
          seq: record.seq,
          ...turnOf(record.turnId),
          category: 'NORMAL',
          kind: 'FEEDBACK',
          text: record.message,
          ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
        });
        break;
      case 'SUBAGENTS_JOINED': {
        if (!mainRuns.has(record.agentRunId)) break;
        const count = (status: string) =>
          record.results.filter((result) => result.status === status).length;
        entries.push({
          seq: record.seq,
          ...turnOf(record.turnId),
          category: 'NORMAL',
          kind: 'FEEDBACK',
          text: `${String(record.results.length)} subtask(s) finished: ${String(count('DONE'))} done, ${String(count('PARTIAL') + count('BLOCKED'))} partial or blocked, ${String(count('FAILED'))} failed, ${String(count('SKIPPED'))} skipped. Their results follow, in the order you wrote the tasks.`,
          toolCallId: record.toolCallId,
        });
        for (const result of record.results)
          entries.push({
            seq: record.seq,
            ...turnOf(record.turnId),
            category: 'NORMAL',
            kind: 'SUBAGENT_RESULT',
            name: result.name,
            agent: result.agent,
            status: result.status,
            notes: result.notes,
            ...(result.outputRef === undefined ? {} : { outputRef: result.outputRef }),
            ...(result.resultToolCallId === undefined
              ? {}
              : { toolCallId: result.resultToolCallId }),
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
  return entries.map((entry) =>
    entry.kind === 'HUMAN' &&
    (scope.kind === 'NODE' || (entry.turnId !== undefined && entry.turnId === currentTurn))
      ? { ...entry, category: 'PINNED' }
      : entry,
  );
}
