import type { SessionLogRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkedItems,
  nextReferenceId,
  partyOf,
  registeredOf,
  resolveReference,
} from './handover.js';

const at = '2026-01-01T00:00:00.000Z';
const art = (digit: string) => ({
  artifactId: 'art_' + digit.repeat(64),
  sha256: digit.repeat(64),
  size: 1,
  mediaType: 'text/plain',
});
const line = (record: object, seq = 1) =>
  ({ seq, at, workflowRunId: 'wfr_a', ...record }) as unknown as SessionLogRecord;

const call = (agentRunId: string, toolCallId: string, tool: string, ok = true) => {
  const requestId = 'req_' + agentRunId + '_' + toolCallId;
  return [
    { type: 'MODEL_TURN', agentRunId, toolCalls: [{ toolName: tool, toolCallId }] },
    {
      type: 'UNIT_SUBMITTED',
      requestId,
      agentRunId,
      inputSource: { kind: 'TOOL_CALL', toolCallId },
    },
    {
      type: 'UNIT_COMPLETED',
      requestId,
      status: ok ? 'OK' : 'FAILED',
      ...(ok ? { outputRef: art('a') } : {}),
    },
  ].map((record, seq) => line(record, seq));
};

const registered = (referenceId: string, to: object) =>
  line({
    type: 'REFERENCES_REGISTERED',
    referenceId,
    from: { agentRunId: 'agr_child', label: 'look' },
    to,
    items: [
      { toolCallId: 'call_1', tool: 'web_fetch', ref: art('b') },
      { toolCallId: 'call_final', tool: 'finish_subagent', ref: art('c') },
    ],
  });

const main = { kind: 'MAIN' } as const;
const node = (agentRunId: string) =>
  ({ kind: 'NODE', workflowRunId: 'wfr_a', agentRunId }) as const;

describe('the number of a handover', () => {
  it('is one more than the handovers registered before it, from the log alone', () => {
    expect(nextReferenceId([])).toBe('ref_1');
    const log = [registered('ref_1', main), registered('ref_2', main)];
    expect(nextReferenceId(log)).toBe('ref_3');
    expect(nextReferenceId([...log, ...call('agr_a', 'call_1', 'read_file')])).toBe('ref_3');
  });

  it('finds a registered handover by its id', () => {
    const log = [registered('ref_1', main), registered('ref_2', main)];
    expect(registeredOf(log, 'ref_2')?.referenceId).toBe('ref_2');
    expect(registeredOf(log, 'ref_9')).toBeUndefined();
  });
});

describe('reading a reference', () => {
  const log = [
    registered('ref_1', main),
    registered('ref_2', { kind: 'AGENT_RUN', agentRunId: 'agr_x' }),
  ];

  it('gives the artifact of the item, to the one it was handed to', () => {
    expect(resolveReference('ref_1/call_1', log, main)).toEqual(art('b'));
    expect(resolveReference('ref_1/call_final', log, main)).toEqual(art('c'));
    expect(resolveReference('ref_2/call_1', log, node('agr_x'))).toEqual(art('b'));
  });

  it('gives nothing to anyone else, and nothing for what is not registered', () => {
    expect(resolveReference('ref_1/call_1', log, node('agr_x'))).toBeUndefined();
    expect(resolveReference('ref_2/call_1', log, main)).toBeUndefined();
    expect(resolveReference('ref_2/call_1', log, node('agr_y'))).toBeUndefined();
    expect(resolveReference('ref_1/call_404', log, main)).toBeUndefined();
    expect(resolveReference('ref_7/call_1', log, main)).toBeUndefined();
    expect(resolveReference('call_1', log, main)).toBeUndefined();
  });

  it('knows a reader by the scope its context is projected in', () => {
    expect(partyOf(main)).toEqual({ kind: 'MAIN' });
    expect(partyOf(node('agr_x'))).toEqual({ kind: 'AGENT_RUN', agentRunId: 'agr_x' });
  });
});

describe('checkedItems', () => {
  it('takes the successful tool calls of the AgentRun itself, with the tool and the artifact', () => {
    const records = [
      ...call('agr_a', 'call_1', 'web_fetch'),
      ...call('agr_a', 'call_2', 'read_file'),
    ];
    const { items, notes } = checkedItems(records, 'agr_a', ['call_2', 'call_1', 'call_1']);
    expect(items).toEqual([
      { toolCallId: 'call_2', tool: 'read_file', ref: art('a') },
      { toolCallId: 'call_1', tool: 'web_fetch', ref: art('a') },
    ]);
    expect(notes).toEqual([]);
  });

  it('leaves out what is not a successful call of its own, and says so in one note', () => {
    const records = [
      ...call('agr_a', 'call_1', 'web_fetch', false),
      ...call('agr_b', 'call_2', 'web_fetch'),
      ...call('agr_a', 'call_3', 'web_fetch'),
    ];
    const { items, notes } = checkedItems(records, 'agr_a', [
      'call_1',
      'call_2',
      'call_3',
      'call_404',
      'x'.repeat(200),
    ]);
    expect(items.map((each) => each.toolCallId)).toEqual(['call_3']);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('4 tool result(s)');
    expect(notes[0]).toContain('call_1, call_2, call_404');
  });

  it('does not take a call of a Turn that was reverted', () => {
    const records = [
      line({ type: 'WORKSPACE_REVERTED', revertedTurnIds: ['trn_old'] }),
      ...call('agr_a', 'call_1', 'web_fetch').map((record) =>
        record.type === 'UNIT_SUBMITTED'
          ? ({ ...record, turnId: 'trn_old' } satisfies SessionLogRecord)
          : record,
      ),
    ];
    expect(checkedItems(records, 'agr_a', ['call_1']).items).toEqual([]);
  });

  it('keeps the first 20 and tells how many were left out', () => {
    const ids = Array.from({ length: 22 }, (_, i) => 'call_' + String(i));
    const records = ids.flatMap((id) => call('agr_a', id, 'read_file'));
    const { items, notes } = checkedItems(records, 'agr_a', ids);
    expect(items).toHaveLength(20);
    expect(notes).toEqual(['system: it listed more than 20 tool results; 2 were left out']);
  });
});
