import type { SessionLogRecord } from '@multiagentos/contracts';
import { isRolledBack, rolledBackRanges } from '../context/rolled-back.js';

/**
 * A request is answered (Orchestration 5.3): the sender chooses, with `kind`, whether its message
 * needs an answer. An inform may be answered and need not be; a request is answered with
 * `send_message` kind reply and `replyTo` its id, in the first round that reads it (a short
 * acknowledgement is enough). The next round that reads it unanswered is reminded, and its reply
 * is refused like a wrong tool call if it still has no answer. A request whose sender has ended is
 * no longer owed: nothing would read the answer.
 */

/** A round that reads an unanswered message this often is reminded of it. */
export const REPLY_REMINDER_AT = 1;
/** A reply of a round that reads an unanswered message this often is refused without its answer. */
export const REPLY_REFUSAL_AT = 2;

export interface OwedReply {
  /** The id of the message, which the answer names in `replyTo`. */
  readonly toolCallId: string;
  readonly fromLabel: string;
  /** Model turns of the task whose context held the message: the one being judged included. */
  readonly seen: number;
}

interface Open {
  readonly seq: number;
  readonly from: string;
  readonly fromLabel: string;
  seen: number;
}

/**
 * The requests `missionId` has not answered yet, and how many of its model turns read each. With
 * `current`, the turn of that AgentRun whose output is being judged counts too: its context was
 * assembled already, its `MODEL_TURN` is not in the log yet.
 */
export function owedReplies(
  records: readonly SessionLogRecord[],
  missionId: string,
  current?: { readonly agentRunId: string },
): readonly OwedReply[] {
  const ranges = rolledBackRanges(records);
  const ownRuns = new Set<string>();
  const runOfRequest = new Map<string, string>();
  const submittedAt = new Map<string, number>();
  /** Where the last context of each AgentRun of the task was submitted: what it could read. */
  const contextAt = new Map<string, number>();
  const open = new Map<string, Open>();
  const ended = new Set<string>();
  for (const record of records) {
    if (record.type === 'ROLLED_BACK')
      for (const cancelled of record.cancelledMissionIds) ended.add(cancelled);
    if (isRolledBack(record.seq, ranges)) continue;
    switch (record.type) {
      case 'AGENT_RUN_REGISTERED':
        if (record.missionId === missionId) ownRuns.add(record.agentRunId);
        break;
      case 'UNIT_SUBMITTED':
        if (!ownRuns.has(record.agentRunId)) break;
        runOfRequest.set(record.requestId, record.agentRunId);
        submittedAt.set(record.requestId, record.seq);
        break;
      case 'CONTEXT_ASSEMBLED': {
        const run = runOfRequest.get(record.requestId);
        const at = submittedAt.get(record.requestId);
        if (run !== undefined && at !== undefined) contextAt.set(run, at);
        break;
      }
      case 'MODEL_TURN': {
        const at = ownRuns.has(record.agentRunId) ? contextAt.get(record.agentRunId) : undefined;
        if (at === undefined) break;
        for (const message of open.values()) if (message.seq < at) message.seen += 1;
        break;
      }
      case 'MISSION_MESSAGE':
        if (record.kind === 'reply') {
          if (record.from === missionId && record.replyTo !== undefined)
            open.delete(record.replyTo);
          break;
        }
        if (record.kind === 'request' && record.to.includes(missionId) && record.from !== missionId)
          open.set(record.source.toolCallId, {
            seq: record.seq,
            from: record.from,
            fromLabel: record.fromLabel,
            seen: 0,
          });
        break;
      case 'MISSION_ENDED':
        ended.add(record.missionId);
        break;
      default:
        break;
    }
  }
  const now = current === undefined ? undefined : contextAt.get(current.agentRunId);
  const owed: OwedReply[] = [];
  for (const [toolCallId, message] of open) {
    if (ended.has(message.from)) continue;
    const seen = message.seen + (now !== undefined && message.seq < now ? 1 : 0);
    owed.push({ toolCallId, fromLabel: message.fromLabel, seen });
  }
  return owed;
}

/** The note at the end of the context of a round that reads unanswered requests a second time. */
export function replyReminder(owed: readonly OwedReply[]): string | undefined {
  const late = owed.filter((each) => each.seen >= REPLY_REMINDER_AT);
  if (late.length === 0) return undefined;
  const list = late.map((each) => `${each.toolCallId} (from ${each.fromLabel})`).join(', ');
  return `⚠ You have not answered ${late.length === 1 ? 'this request' : 'these requests'}: ${list}. Answer each in this reply with send_message kind reply and replyTo its id (a short acknowledgement is enough; it can go with your other calls). A reply without these answers is refused and none of its calls run.`;
}

/** Why a reply is refused: requests read before and still not answered in it. */
export function replyRefusal(
  owed: readonly OwedReply[],
  answered: ReadonlySet<string>,
): string | undefined {
  const overdue = owed.filter(
    (each) => each.seen >= REPLY_REFUSAL_AT && !answered.has(each.toolCallId),
  );
  if (overdue.length === 0) return undefined;
  const list = overdue.map((each) => `${each.toolCallId} (from ${each.fromLabel})`).join(', ');
  return `Not executed: you still have not answered ${list}. None of the calls of this reply ran. Send send_message kind reply with replyTo ${overdue.length === 1 ? 'its id' : 'each id'} (a short acknowledgement is enough), together with the calls you still need.`;
}
