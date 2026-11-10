import type { SessionLogRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { finishedOutcome, outcomeOf, resultOf, unansweredCriteria } from './task-results.js';

const ended = (extra: object): SessionLogRecord =>
  ({
    seq: 1,
    at: '2026-01-01T00:00:00.000Z',
    workflowRunId: 'wfr_a',
    type: 'NODE_ENDED',
    nodeId: 'nod_a',
    ...extra,
  }) as SessionLogRecord;

describe('finishedOutcome', () => {
  it('puts unmet criteria first and keeps the status the worker gave', () => {
    const outcome = finishedOutcome(
      {
        status: 'partial',
        acceptance: [
          { index: 0, verdict: 'met' },
          { index: 1, verdict: 'not_met' },
        ],
      },
      ['builds', 'tests pass', 'documented'],
      undefined,
    );
    expect(outcome.status).toBe('PARTIAL');
    expect(outcome.notes).toEqual([
      'criterion 1 not_met: tests pass',
      'criterion 2 unanswered: documented',
    ]);
  });

  it('marks what a worker says it changed against what was seen', () => {
    const outcome = finishedOutcome(
      { status: 'done', changedFiles: ['src/a.ts', './src/b.ts'] },
      [],
      ['src/b.ts', 'src/c.ts'],
    );
    expect(outcome.status).toBe('DONE');
    expect(outcome.notes).toEqual([
      'reported as changed but no change was seen: src/a.ts',
      'changed but not reported: src/c.ts',
    ]);
  });

  it('reads blocked as BLOCKED, and an explorer as DONE', () => {
    expect(finishedOutcome({ status: 'blocked' }, [], undefined).status).toBe('BLOCKED');
    expect(finishedOutcome({}, [], undefined).status).toBe('DONE');
  });
});

describe('unansweredCriteria', () => {
  it('lists the indices nobody answered', () => {
    expect(unansweredCriteria({ acceptance: [{ index: 1, verdict: 'unknown' }] }, 3)).toEqual([
      0, 2,
    ]);
  });
});

describe('outcomeOf', () => {
  it('reads back what resultOf wrote', () => {
    const result = resultOf({ status: 'PARTIAL', notes: ['one'], toolCallId: 'call_1' });
    const outcome = outcomeOf([ended({ status: 'SUCCEEDED', result })], 'wfr_a', 'nod_a');
    expect(outcome).toEqual({ status: 'PARTIAL', notes: ['one'], toolCallId: 'call_1' });
  });

  it('says a skipped task was not started, and is empty while a task runs', () => {
    expect(
      outcomeOf([ended({ status: 'SKIPPED', skipReason: 'DEPENDENCY_FAILED' })], 'wfr_a', 'nod_a')
        ?.status,
    ).toBe('SKIPPED');
    expect(outcomeOf([], 'wfr_a', 'nod_a')).toBeUndefined();
  });

  it('treats a failed node without a result as FAILED', () => {
    expect(outcomeOf([ended({ status: 'FAILED' })], 'wfr_a', 'nod_a')?.status).toBe('FAILED');
  });
});

describe('the handover of a result', () => {
  it('is written with the result and read back from the log', () => {
    const result = resultOf({
      status: 'DONE',
      notes: [],
      toolCallId: 'call_1',
      referenceId: 'ref_3',
    });
    const outcome = outcomeOf([ended({ status: 'SUCCEEDED', result })], 'wfr_a', 'nod_a');
    expect(outcome?.referenceId).toBe('ref_3');
    expect(outcome?.toolCallId).toBe('call_1');
  });

  it('is absent when the task handed nothing over', () => {
    const result = resultOf({ status: 'PARTIAL', notes: ['stopped early'] });
    expect(
      outcomeOf([ended({ status: 'SUCCEEDED', result })], 'wfr_a', 'nod_a')?.referenceId,
    ).toBeUndefined();
  });
});
