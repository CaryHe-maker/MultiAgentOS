import {
  SUBAGENT_MAX_REFERENCES,
  parseReferenceName,
  type ArtifactRef,
  type HandoverParty,
  type SessionLogRecord,
} from '@multiagentos/contracts';
import type { ProjectionScope } from '../context/history-projection.js';

/**
 * Results that one AgentRun hands to another (M2Design 3.7). A handover is registered once, in the
 * log, by what Workflow checked: the registry is what `read_output` reads a reference
 * `ref_N/toolCallId` from, and nothing else. The same functions serve every kind of giver and
 * taker: a SubAgent giving its result to its caller is the first, not a special case.
 */
export type Registered = Extract<SessionLogRecord, { type: 'REFERENCES_REGISTERED' }>;
export type HandoverItem = Registered['items'][number];

const PREFIX = 'ref_';

/** The longest id of a call that can still be named by a reference: `ref_N/` comes before it. */
const MAX_CALL_ID_CHARS = 80;

/** The number of the next handover: those registered before it, plus one. From the log alone. */
export function nextReferenceId(records: readonly SessionLogRecord[]): string {
  const registered = records.filter((record) => record.type === 'REFERENCES_REGISTERED').length;
  return `${PREFIX}${String(registered + 1)}`;
}

/** The handover a reference id names. */
export function registeredOf(
  records: readonly SessionLogRecord[],
  referenceId: string,
): Registered | undefined {
  return records.find(
    (record): record is Registered =>
      record.type === 'REFERENCES_REGISTERED' && record.referenceId === referenceId,
  );
}

/** Who a reader is, by the scope its context is projected in. */
export const partyOf = (scope: ProjectionScope): HandoverParty =>
  scope.kind === 'MAIN'
    ? { kind: 'MAIN' }
    : scope.missionId !== undefined
      ? { kind: 'MISSION', missionId: scope.missionId }
      : { kind: 'AGENT_RUN', agentRunId: scope.agentRunId };

const sameParty = (left: HandoverParty, right: HandoverParty): boolean => {
  if (left.kind === 'MAIN') return right.kind === 'MAIN';
  if (left.kind === 'AGENT_RUN')
    return right.kind === 'AGENT_RUN' && left.agentRunId === right.agentRunId;
  return right.kind === 'MISSION' && left.missionId === right.missionId;
};

/**
 * The artifact a reference names, for the reader it was handed to and for no other; undefined
 * when there is no such reference or it was not handed to this reader. Only the registry is read.
 */
export function resolveReference(
  name: string,
  records: readonly SessionLogRecord[],
  scope: ProjectionScope,
): ArtifactRef | undefined {
  const parsed = parseReferenceName(name);
  if (parsed === undefined) return undefined;
  const { referenceId, toolCallId } = parsed;
  const handover = registeredOf(records, referenceId);
  if (handover === undefined || !sameParty(handover.to, partyOf(scope))) return undefined;
  return handover.items.find((item) => item.toolCallId === toolCallId)?.ref;
}

/**
 * Which of the tool results an AgentRun listed are handed over. One is handed over when it is of a
 * tool call of this very AgentRun that was run and succeeded. What is not is only told in a note;
 * it is never a reason to refuse the result of the AgentRun.
 */
export function checkedItems(
  records: readonly SessionLogRecord[],
  agentRunId: string,
  listed: readonly string[],
): { readonly items: readonly HandoverItem[]; readonly notes: readonly string[] } {
  const reverted = new Set<string>();
  for (const record of records)
    if (record.type === 'WORKSPACE_REVERTED')
      for (const turnId of record.revertedTurnIds) reverted.add(turnId);
  const toolNames = new Map<string, string>();
  for (const record of records)
    if (record.type === 'MODEL_TURN' && record.agentRunId === agentRunId)
      for (const call of record.toolCalls) toolNames.set(call.toolCallId, call.toolName);
  const items: HandoverItem[] = [];
  const refused: string[] = [];
  let overflow = 0;
  for (const id of new Set(listed)) {
    const submitted = [...records]
      .reverse()
      .find(
        (record) =>
          record.type === 'UNIT_SUBMITTED' &&
          record.agentRunId === agentRunId &&
          record.inputSource.kind === 'TOOL_CALL' &&
          record.inputSource.toolCallId === id &&
          (record.turnId === undefined || !reverted.has(record.turnId)),
      );
    const completed =
      submitted?.type === 'UNIT_SUBMITTED'
        ? records.find(
            (record) =>
              record.type === 'UNIT_COMPLETED' && record.requestId === submitted.requestId,
          )
        : undefined;
    const ref =
      completed?.type === 'UNIT_COMPLETED' && completed.status === 'OK'
        ? (completed.fullRef ?? completed.outputRef)
        : undefined;
    if (ref === undefined || id.length > MAX_CALL_ID_CHARS) refused.push(id);
    else if (items.length >= SUBAGENT_MAX_REFERENCES) overflow += 1;
    else items.push({ toolCallId: id, tool: toolNames.get(id) ?? 'tool', ref });
  }
  const notes: string[] = [];
  if (refused.length > 0)
    notes.push(
      `system: ${String(refused.length)} tool result(s) it listed are not handed over, because they are not successful tool calls of its own: ${refused.join(', ')}`,
    );
  if (overflow > 0)
    notes.push(
      `system: it listed more than ${String(SUBAGENT_MAX_REFERENCES)} tool results; ${String(overflow)} were left out`,
    );
  return { items, notes };
}
