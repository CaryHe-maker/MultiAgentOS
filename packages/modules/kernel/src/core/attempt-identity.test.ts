import { describe, expect, it } from 'vitest';
import { AttemptIdentityRegistry } from './index.js';

const attempt = {
  unitAttemptId: 'una_123456',
  requestId: 'req_123456',
  agentRunId: 'agr_123456',
  runEpoch: 1,
  executionKind: 'MODEL' as const,
  requiresLease: false,
};
const first = { unitAttemptId: attempt.unitAttemptId, executionId: 'exe_123456', runEpoch: 1 };
const second = { unitAttemptId: attempt.unitAttemptId, executionId: 'exe_654321', runEpoch: 1 };

describe('Core attempt identity projection', () => {
  it('accepts only the registered current execution and rejects a late retry result', () => {
    let epoch = 1;
    const identities = new AttemptIdentityRegistry('wfr_123456', () => epoch);
    expect(() => identities.registerExecution(first)).toThrow('no open attempt');
    identities.registerAttempt(attempt);
    identities.registerExecution(first);
    expect(() => identities.registerExecution(second)).toThrow('Retry was not authorized');
    identities.authorizeRetry(attempt.unitAttemptId, first.executionId);
    identities.registerExecution(second);

    const firstResult = {
      unitAttemptId: attempt.unitAttemptId,
      executionId: first.executionId,
      outcome: 'FAILED' as const,
    };
    const secondResult = { ...firstResult, executionId: second.executionId };
    expect(identities.check('wfr_123456', epoch, firstResult, () => true)).toBe(false);
    expect(identities.check('wfr_654321', epoch, secondResult, () => true)).toBe(false);
    expect(identities.check('wfr_123456', epoch, secondResult, () => true)).toBe(true);
    identities.markChecked(attempt.unitAttemptId);
    expect(identities.check('wfr_123456', epoch, secondResult, () => true)).toBe(false);

    epoch = 2;
    expect(() => identities.registerAttempt({ ...attempt, unitAttemptId: 'una_654321' })).toThrow(
      'Stale attempt epoch',
    );
  });

  it('checks the lease and permits a built-in report result without executionId', () => {
    const identities = new AttemptIdentityRegistry('wfr_123456', () => 1);
    identities.registerAttempt({
      ...attempt,
      executionKind: 'REPORT_PUBLISH',
      requiresLease: true,
    });
    const result = { unitAttemptId: attempt.unitAttemptId, outcome: 'COMPLETED' as const };
    expect(identities.check('wfr_123456', 1, result, () => false)).toBe(false);
    expect(identities.check('wfr_123456', 1, result, () => true)).toBe(true);
  });
});
