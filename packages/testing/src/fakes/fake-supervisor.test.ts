import {
  ExecutionFactSchema,
  validate,
  type ExecutionFact,
  type ExecutionRequest,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { createFakeSupervisor } from './fake-supervisor.js';

const request = (executionId: string, runEpoch = 1): ExecutionRequest => ({
  sessionId: 'ses_123456',
  workflowRunId: 'wfr_123456',
  unitAttemptId: `una_${executionId.slice(4)}`,
  executionId,
  runEpoch,
  executionKind: 'OUTPUT_READ',
  input: { toolCallId: 'call_1', content: 'x' },
  scope: { kind: 'NONE' },
  limits: {
    deadline: '2099-01-01T00:00:00.000Z',
    maxOutputBytes: 1000,
    preview: { maxBytes: 1000, maxLines: 10 },
    maxFullOutputBytes: 1000,
  },
});

function fake() {
  const facts: ExecutionFact[] = [];
  const supervisor = createFakeSupervisor(
    (fact) => void facts.push(fact),
    () => new Date('2026-11-05T00:00:00.000Z'),
  );
  return { supervisor, facts };
}

describe('the fake Supervisor', () => {
  it('keeps what it is asked and holds each execution open until a test ends it', async () => {
    const { supervisor, facts } = fake();
    await supervisor.execute(request('exe_000001'));
    await supervisor.execute(request('exe_000002'));
    expect(supervisor.executed).toHaveLength(2);
    expect(supervisor.open().map((r) => r.executionId)).toEqual(['exe_000001', 'exe_000002']);
    expect(facts).toEqual([]);
  });

  it('cancels one execution with the reason, as a valid fact', async () => {
    const { supervisor, facts } = fake();
    await supervisor.execute(request('exe_000001'));
    await supervisor.execute(request('exe_000002'));
    await supervisor.cancelExecution({ executionId: 'exe_000001', runEpoch: 1, reason: 'PAUSED' });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      executionId: 'exe_000001',
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
      cancelReason: 'PAUSED',
    });
    expect(validate(ExecutionFactSchema, facts[0]).ok).toBe(true);
    expect(supervisor.open().map((r) => r.executionId)).toEqual(['exe_000002']);
  });

  it('ignores a cancellation of an unknown, finished or other-epoch execution', async () => {
    const { supervisor, facts } = fake();
    await supervisor.execute(request('exe_000001', 2));
    await supervisor.cancelExecution({ executionId: 'exe_999999', runEpoch: 2, reason: 'ABORTED' });
    await supervisor.cancelExecution({ executionId: 'exe_000001', runEpoch: 1, reason: 'ABORTED' });
    expect(facts).toEqual([]);
    await supervisor.cancelExecution({ executionId: 'exe_000001', runEpoch: 2, reason: 'ABORTED' });
    await supervisor.cancelExecution({ executionId: 'exe_000001', runEpoch: 2, reason: 'PAUSED' });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ cancelReason: 'ABORTED' });
  });

  it('reports one fact per execution: a duplicate request is not run twice', async () => {
    const { supervisor, facts } = fake();
    await supervisor.execute(request('exe_000001'));
    await supervisor.execute(request('exe_000001'));
    expect(supervisor.open()).toHaveLength(1);
    expect(await supervisor.finish('exe_000001', { outcome: 'STOP_UNCONFIRMED' })).toBe(true);
    expect(await supervisor.finish('exe_000001', { outcome: 'STOP_UNCONFIRMED' })).toBe(false);
    expect(facts).toHaveLength(1);
    expect(validate(ExecutionFactSchema, facts[0]).ok).toBe(true);
  });

  it('cancelRun ends the executions of an older epoch and leaves the new ones', async () => {
    const { supervisor, facts } = fake();
    await supervisor.execute(request('exe_000001', 1));
    await supervisor.execute(request('exe_000002', 2));
    await supervisor.cancelRun({ workflowRunId: 'wfr_123456', runEpoch: 2 });
    expect(facts.map((fact) => fact.executionId)).toEqual(['exe_000001']);
    expect(facts[0]).not.toHaveProperty('cancelReason');
    expect(supervisor.cancelledRuns).toHaveLength(1);
  });

  it('records a shutdown', async () => {
    const { supervisor } = fake();
    await supervisor.shutdown({ requestId: 'req_123456' });
    expect(supervisor.shutdowns).toEqual([{ requestId: 'req_123456' }]);
  });
});
