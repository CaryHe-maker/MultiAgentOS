import type { SessionLogRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { owedReplies, replyRefusal, replyReminder } from './mission-replies.js';

const at = '2026-11-13T00:00:00.000Z';
let seq = 0;
let requests = 0;
const record = (body: object): SessionLogRecord =>
  ({ at, workflowRunId: 'wfr_a', turnId: 'trn_a', seq: (seq += 1), ...body }) as SessionLogRecord;
const registered = (agentRunId: string, missionId: string) =>
  record({ type: 'AGENT_RUN_REGISTERED', agentRunId, nodeId: `nod_${agentRunId}`, missionId });
const message = (
  toolCallId: string,
  from: string,
  to: string,
  over: { kind?: 'inform' | 'request' | 'reply'; replyTo?: string } = {},
) =>
  record({
    type: 'MISSION_MESSAGE',
    from,
    fromLabel: from,
    to: [to],
    ...over,
    source: { modelTurnRequestId: 'req_m', outputRef: 'art_m', toolCallId },
  });
/** One round of an AgentRun: its context is submitted and assembled, then the model answers. */
const round = (agentRunId: string, turn = true): SessionLogRecord[] => {
  const requestId = `req_${String((requests += 1))}`;
  return [
    record({
      type: 'UNIT_SUBMITTED',
      requestId,
      path: 'context',
      agentRunId,
      unitRunId: `unr_${requestId}`,
      unitRef: { id: 'context-assemble', version: 'v0.1.0' },
      inputSource: { kind: 'WORKFLOW' },
    }),
    record({ type: 'CONTEXT_ASSEMBLED', requestId }),
    ...(turn ? [record({ type: 'MODEL_TURN', requestId: `${requestId}_m`, agentRunId })] : []),
  ];
};

describe('owedReplies', () => {
  it('counts the rounds whose context held a request, until it is answered', () => {
    const log = [
      registered('agr_b', 'msn_b'),
      message('call_1', 'msn_a', 'msn_b', { kind: 'request' }),
    ];
    expect(owedReplies(log, 'msn_b')).toEqual([
      { toolCallId: 'call_1', fromLabel: 'msn_a', seen: 0 },
    ]);
    log.push(...round('agr_b'));
    expect(owedReplies(log, 'msn_b')[0]?.seen).toBe(1);
    // The round being judged: its context is assembled, its turn not yet in the log.
    log.push(...round('agr_b', false));
    expect(owedReplies(log, 'msn_b', { agentRunId: 'agr_b' })[0]?.seen).toBe(2);
    log.push(message('call_2', 'msn_b', 'msn_a', { kind: 'reply', replyTo: 'call_1' }));
    expect(owedReplies(log, 'msn_b')).toEqual([]);
  });

  it('does not count a round whose context was made before the message came', () => {
    const log = [registered('agr_b', 'msn_b'), ...round('agr_b', false)];
    log.push(message('call_1', 'msn_a', 'msn_b', { kind: 'request' }));
    log.push(record({ type: 'MODEL_TURN', requestId: 'req_x', agentRunId: 'agr_b' }));
    expect(owedReplies(log, 'msn_b', { agentRunId: 'agr_b' })).toEqual([
      { toolCallId: 'call_1', fromLabel: 'msn_a', seen: 0 },
    ]);
  });

  it('counts every segment of the task, and owes nothing for an inform, a reply or to a sender that ended', () => {
    const log = [
      registered('agr_b1', 'msn_b'),
      message('call_1', 'msn_a', 'msn_b', { kind: 'request' }),
      message('call_4', 'msn_a', 'msn_b'),
      message('call_2', 'msn_c', 'msn_b', { kind: 'reply', replyTo: 'call_0' }),
      message('call_3', 'msn_d', 'msn_b', { kind: 'request' }),
      ...round('agr_b1'),
      registered('agr_b2', 'msn_b'),
      ...round('agr_b2'),
      record({ type: 'MISSION_ENDED', missionId: 'msn_d', status: 'SUCCEEDED' }),
    ];
    expect(owedReplies(log, 'msn_b')).toEqual([
      { toolCallId: 'call_1', fromLabel: 'msn_a', seen: 2 },
    ]);
  });
});

describe('the reminder and the refusal', () => {
  const owed = (seen: number) => [{ toolCallId: 'call_1', fromLabel: 'api', seen }];

  it('reminds from the second round that reads a message', () => {
    expect(replyReminder(owed(0))).toBeUndefined();
    expect(replyReminder(owed(1))).toContain('call_1 (from api)');
  });

  it('refuses the second round without the answer, and lets one with it through', () => {
    expect(replyRefusal(owed(1), new Set())).toBeUndefined();
    expect(replyRefusal(owed(2), new Set())).toContain(
      'Not executed: you still have not answered call_1 (from api)',
    );
    expect(replyRefusal(owed(2), new Set(['call_1']))).toBeUndefined();
  });
});
