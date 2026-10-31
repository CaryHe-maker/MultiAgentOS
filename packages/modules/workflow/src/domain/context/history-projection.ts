import type {
  ArtifactRef,
  ContextAssembleInputV1,
  ContextHistoryEntry,
  SessionLogRecord,
} from '@multiagentos/contracts';

/**
 * What an AgentRun sees (Module/Workflow 8), as a pure function of the log: the same prefix gives
 * the same entries and a later call only appends to an earlier one (invariants 7 and 27). main
 * sees every Turn of the Session, across runs; a template node sees the run's goal, the handoff it
 * takes as input and its own steps. Tool results name their preview only; `fullRef` never enters
 * a projection. The category is the one field that may change: a prompt is PINNED while its Turn
 * is the current one.
 */
const MAIN_AGENT_ID = 'main';

export type ProjectionScope =
  | { readonly kind: 'MAIN' }
  | {
      readonly kind: 'NODE';
      readonly workflowRunId: string;
      readonly agentRunId: string;
      readonly handoff?: { readonly outputRef: ArtifactRef; readonly toolCallId: string };
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

/** The latest `AGENTS.md` of the run; trust decides its segment (ExecutorSet 6.1). */
export function projectInstructions(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
): ContextAssembleInputV1['projectInstructions'] {
  let latest: ContextAssembleInputV1['projectInstructions'];
  for (const record of records) {
    if (
      record.type === 'PROJECT_FILE_LOADED' &&
      record.workflowRunId === workflowRunId &&
      record.path === 'AGENTS.md'
    ) {
      latest = { ref: record.ref, sha256: record.sha256, trusted: record.trusted ?? false };
    }
  }
  return latest;
}
