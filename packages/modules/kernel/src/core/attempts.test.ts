import type { PinnedDefinitionSet, UnitDefinition } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import type {
  AttemptSpec,
  MonitorDuties,
  SchedulerDuties,
  Settlement,
} from '../interfaces/index.js';
import type { CoreAuditEntry } from './audit.js';
import { CoreAttempts, type AttemptStarter } from './attempts.js';
import type { CoreEvent } from './events.js';
import { createRunState, type RunState } from './run-state.js';

const sha = 'a'.repeat(64);
const fileOutput = {
  path: 'a.ts',
  startLine: 1,
  endLine: 1,
  totalLines: 1,
  contentSha256: sha,
  fileSha256: 'b'.repeat(64),
};
const fileRef = {
  artifactId: `art_${sha}`,
  sha256: sha,
  size: 3,
  mediaType: 'text/plain; charset=utf-8',
};

function unit(
  executionKind: UnitDefinition['executionKind'] = 'FILE_READ',
  protectedCapabilities: UnitDefinition['protectedCapabilities'] = ['repo.read'],
): UnitDefinition {
  return {
    schemaVersion: 'v0',
    kind: 'UNIT',
    id: executionKind === 'MODEL' ? 'model-call' : 'file-read',
    version: 'v0.1.0',
    digest: 'd'.repeat(64),
    description: 'unit',
    executionKind,
    protectedCapabilities,
    inputContract: { kind: 'contract', id: 'executor.FileReadInput', version: 'v0' },
    outputContract: { kind: 'contract', id: 'executor.FileReadOutput', version: 'v0' },
    toolRefs: [],
    effect: 'READ_ONLY',
    isIdempotent: true,
    failurePolicy: {},
  };
}

function spec(
  unitDefinition: UnitDefinition,
  requestId: string,
  agentRunId = 'agr_123456',
): AttemptSpec {
  return {
    requestId,
    agentRunId,
    unit: unitDefinition,
    input: { path: 'a.ts' },
    scope: { kind: 'NONE' },
    pinned: {} as PinnedDefinitionSet,
    runEpoch: 1,
  };
}

interface Harness {
  readonly attempts: CoreAttempts;
  readonly run: RunState;
  readonly events: CoreEvent[];
  readonly audits: CoreAuditEntry[];
  readonly settlements: { id: string; value: Settlement }[];
  readonly releases: string[];
  readonly violations: string[];
  readonly stops: string[];
  readonly internals: { value: number };
  readonly settled: string[];
}

function harness(
  options: {
    readonly retryLimit?: number;
    readonly reserve?: MonitorDuties['reserve'];
    readonly settle?: MonitorDuties['settle'];
    readonly acquire?: SchedulerDuties['acquire'];
  } = {},
): Harness {
  const run = createRunState({
    workflowRunId: 'wfr_123456',
    correlationId: 'cor_123456',
    goal: 'analyze',
    repositoryRoot: '/repo',
    startedAt: '2026-10-19T00:00:00.000Z',
  });
  const events: CoreEvent[] = [];
  const audits: CoreAuditEntry[] = [];
  const settlements: { id: string; value: Settlement }[] = [];
  const releases: string[] = [];
  const violations: string[] = [];
  const stops: string[] = [];
  const internals = { value: 0 };
  const settled: string[] = [];
  let attemptSequence = 0;
  let reservationSequence = 0;
  let grantSequence = 0;
  const holder: { current?: CoreAttempts } = {};

  const monitor: MonitorDuties = {
    reserve: (request) => {
      if (options.reserve !== undefined) return options.reserve(request);
      reservationSequence += 1;
      return { ok: true, reservationId: `rsv_${reservationSequence}` };
    },
    settle: (id, value) => {
      settlements.push({ id, value });
      if (options.settle !== undefined) return options.settle(id, value);
      return { budgetState: 'NORMAL', anomalies: [] };
    },
    budgetState: () => 'NORMAL',
    finalize: () => ({
      limit: 600_000,
      used: 0,
      unknown: 0,
      inputTokens: 0,
      outputTokens: 0,
      finalBudgetState: 'NORMAL',
    }),
  };
  const scheduler: SchedulerDuties = {
    acquire: () => {
      if (options.acquire !== undefined) return options.acquire('deepseek');
      grantSequence += 1;
      return { ok: true, grantId: `grt_${grantSequence}` };
    },
    release: (grantId) => {
      releases.push(grantId);
    },
    stopGranting: () => undefined,
    releaseAll: () => 0,
  };

  const execution: AttemptStarter = {
    createAttempt: (attemptSpec) => {
      attemptSequence += 1;
      const unitAttemptId = `una_${String(attemptSequence).padStart(6, '0')}`;
      holder.current?.registerAttempt({
        unitAttemptId,
        requestId: attemptSpec.requestId,
        agentRunId: attemptSpec.agentRunId,
        runEpoch: attemptSpec.runEpoch,
        executionKind: attemptSpec.unit.executionKind,
        requiresLease: attemptSpec.unit.protectedCapabilities.includes('repo.read'),
      });
      return Promise.resolve(unitAttemptId);
    },
  };
  const attempts = new CoreAttempts({
    run,
    execution,
    monitor,
    scheduler,
    audit: {
      append: (entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    },
    events: { emit: (event) => events.push(event) },
    provider: 'deepseek',
    technicalRetryLimit: options.retryLimit ?? 3,
    now: () => new Date('2026-10-19T00:00:01.000Z'),
    leaseIsValid: () => true,
    onViolation: (reasonCode, requestId) => {
      violations.push(`${reasonCode}:${requestId ?? ''}`);
    },
    onStopUnconfirmed: (requestId) => {
      stops.push(requestId ?? '');
    },
    onKernelInternal: () => {
      internals.value += 1;
    },
    onResultSettled: (executionId) => {
      settled.push(executionId);
    },
  });
  holder.current = attempts;

  return {
    attempts,
    run,
    events,
    audits,
    settlements,
    releases,
    violations,
    stops,
    internals,
    settled,
  };
}

async function started(
  test: Harness,
  unitDefinition: UnitDefinition = unit(),
  requestId = 'req_123456',
): Promise<{ unitAttemptId: string; executionId: string }> {
  const unitAttemptId = await test.attempts.startAttempt(spec(unitDefinition, requestId));
  const executionId = `exe_${unitAttemptId.slice(4)}`;
  test.attempts.registerExecution({ unitAttemptId, executionId, runEpoch: 1 });
  return { unitAttemptId, executionId };
}

describe('CoreAttempts reservations', () => {
  it('acquires a grant and reservation atomically', async () => {
    const test = harness();
    const { unitAttemptId } = await started(test);
    expect(
      test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: false }),
    ).toEqual({ granted: true, reservationId: 'rsv_1', grantId: 'grt_1' });
  });

  it('allows one final-call and rejects a second attempt', async () => {
    const test = harness();
    const first = await started(test, unit('MODEL', []), 'req_model1');
    expect(
      test.attempts.requestReservation({
        unitAttemptId: first.unitAttemptId,
        estimatedTokens: 100,
        final: true,
      }),
    ).toMatchObject({ granted: true });
    const second = await started(test, unit('MODEL', []), 'req_model2');
    expect(
      test.attempts.requestReservation({
        unitAttemptId: second.unitAttemptId,
        estimatedTokens: 100,
        final: true,
      }),
    ).toEqual({ granted: false, reason: 'FINAL_CALL_USED' });
    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: 'UnitReport',
        status: 'REJECTED',
        reasonCode: 'FINAL_CALL_USED',
      }),
    );
  });

  it('releases the grant when Monitor rejects and delivers a budget report', async () => {
    const test = harness({
      reserve: () => ({ ok: false, reasonCode: 'BUDGET_WRAP_UP' }),
    });
    const { unitAttemptId } = await started(test);
    expect(
      test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: false }),
    ).toEqual({ granted: false, reason: 'BUDGET_WRAP_UP' });
    expect(test.releases).toEqual(['grt_1']);
    expect(test.events).toContainEqual(
      expect.objectContaining({ status: 'REJECTED', reasonCode: 'BUDGET_WRAP_UP' }),
    );
  });

  it('does not reserve after convergence and reports an internal failure when acquire fails', async () => {
    const test = harness({ acquire: () => ({ ok: false }) });
    const { unitAttemptId } = await started(test);
    expect(
      test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: false }),
    ).toEqual({ granted: false, reason: 'RUN_CONVERGING' });
    expect(test.internals.value).toBe(1);

    const converged = harness();
    const attempt = await started(converged);
    converged.run.runState = 'CONVERGING';
    converged.run.closeReason = 'CANCELLED';
    expect(
      converged.attempts.requestReservation({
        unitAttemptId: attempt.unitAttemptId,
        estimatedTokens: 100,
        final: false,
      }),
    ).toEqual({ granted: false, reason: 'RUN_CONVERGING' });
  });
});

describe('CoreAttempts result checks', () => {
  it('settles actual usage, releases the grant and delivers an OK report', async () => {
    const test = harness();
    const { unitAttemptId, executionId } = await started(test);
    test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: false });
    test.attempts.submitResultCheck({
      unitAttemptId,
      executionId,
      outcome: 'COMPLETED',
      output: fileOutput,
      outputRef: fileRef,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(test.settlements).toEqual([
      { id: 'rsv_1', value: { type: 'ACTUAL', usage: { inputTokens: 10, outputTokens: 5 } } },
    ]);
    expect(test.releases).toEqual(['grt_1']);
    expect(test.run.units.ok).toBe(1);
    expect(test.settled).toEqual([executionId]);
    expect(test.events).toContainEqual(
      expect.objectContaining({ type: 'UnitReport', status: 'OK', unitAttemptId }),
    );
  });

  it('audits settlement anomalies from Monitor', async () => {
    const test = harness({
      settle: () => ({
        budgetState: 'NORMAL',
        anomalies: [
          {
            type: 'ACTUAL_EXCEEDED_ESTIMATE',
            reservationId: 'rsv_1',
            estimatedTokens: 1,
            actualTokens: 2,
          },
        ],
      }),
    });
    const { unitAttemptId, executionId } = await started(test);
    test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: false });
    test.attempts.submitResultCheck({
      unitAttemptId,
      executionId,
      outcome: 'COMPLETED',
      output: fileOutput,
      outputRef: fileRef,
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    expect(test.audits).toContainEqual(
      expect.objectContaining({ type: 'SETTLEMENT_ANOMALY', anomaly: 'ACTUAL_EXCEEDED_ESTIMATE' }),
    );
  });

  it('maps REJECTED to NOT_SENT and FAILED by requestState', async () => {
    const test = harness();
    const rejected = await started(test, unit(), 'req_reject1');
    test.attempts.requestReservation({
      unitAttemptId: rejected.unitAttemptId,
      estimatedTokens: 100,
      final: false,
    });
    test.attempts.submitResultCheck({
      unitAttemptId: rejected.unitAttemptId,
      executionId: rejected.executionId,
      outcome: 'REJECTED',
      reasonCode: 'OUT_OF_SCOPE',
    });
    const failed = await started(test, unit('MODEL', []), 'req_fail001');
    test.attempts.requestReservation({
      unitAttemptId: failed.unitAttemptId,
      estimatedTokens: 100,
      final: false,
    });
    test.attempts.submitResultCheck({
      unitAttemptId: failed.unitAttemptId,
      executionId: failed.executionId,
      outcome: 'FAILED',
      reasonCode: 'PROVIDER_ERROR',
      requestState: 'SENT',
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    expect(test.settlements.map((entry) => entry.value.type)).toEqual(['NOT_SENT', 'ACTUAL']);
  });

  it('settles an old-epoch result without delivering it', async () => {
    const test = harness();
    const { unitAttemptId, executionId } = await started(test);
    test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: false });
    test.run.runState = 'CONVERGING';
    test.run.runEpoch = 2;
    test.run.closeReason = 'CANCELLED';
    test.attempts.submitResultCheck({
      unitAttemptId,
      executionId,
      outcome: 'COMPLETED',
      output: fileOutput,
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(test.settlements).toHaveLength(1);
    expect(test.run.units.notDelivered).toBe(1);
    expect(test.events.filter((event) => event.type === 'UnitReport')).toHaveLength(0);
    expect(test.audits.some((entry) => entry.type === 'UNIT_NOT_DELIVERED')).toBe(true);
  });

  it('handles a stale execution without settling or delivering', async () => {
    const test = harness();
    const { unitAttemptId } = await started(test);
    test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: false });
    test.attempts.submitResultCheck({
      unitAttemptId,
      executionId: 'exe_wrong1',
      outcome: 'COMPLETED',
      output: fileOutput,
      outputRef: fileRef,
    });
    expect(test.settlements).toHaveLength(0);
    expect(test.audits.some((entry) => entry.type === 'STALE_FACT')).toBe(true);
  });

  it('routes violation and stop-unconfirmed outcomes without a UnitReport', async () => {
    const violation = harness();
    const violating = await started(violation, unit(), 'req_viol001');
    violation.attempts.requestReservation({
      unitAttemptId: violating.unitAttemptId,
      estimatedTokens: 100,
      final: false,
    });
    violation.attempts.submitResultCheck({
      unitAttemptId: violating.unitAttemptId,
      executionId: violating.executionId,
      outcome: 'VIOLATION',
      reasonCode: 'PATH_ESCAPE',
    });
    expect(violation.violations).toEqual(['PATH_ESCAPE:req_viol001']);
    expect(violation.settlements[0]?.value.type).toBe('UNKNOWN');

    const stopped = harness();
    const stopAttempt = await started(stopped, unit(), 'req_stop001');
    stopped.attempts.requestReservation({
      unitAttemptId: stopAttempt.unitAttemptId,
      estimatedTokens: 100,
      final: false,
    });
    stopped.attempts.submitResultCheck({
      unitAttemptId: stopAttempt.unitAttemptId,
      executionId: stopAttempt.executionId,
      outcome: 'STOP_UNCONFIRMED',
    });
    expect(stopped.stops).toEqual(['req_stop001']);
    expect(stopped.releases).toEqual([]);
  });

  it('maps TERMINATED(UNIT_TIMEOUT) to a FAILED report', async () => {
    const test = harness();
    const { unitAttemptId, executionId } = await started(test);
    test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: false });
    test.attempts.submitResultCheck({
      unitAttemptId,
      executionId,
      outcome: 'TERMINATED',
      reasonCode: 'UNIT_TIMEOUT',
    });
    expect(test.events).toContainEqual(
      expect.objectContaining({ status: 'FAILED', reasonCode: 'UNIT_TIMEOUT' }),
    );
  });

  it('delivers NOT_DISPATCHED as a rejection without settlement', async () => {
    const test = harness();
    const unitAttemptId = await test.attempts.startAttempt(spec(unit(), 'req_notdisp'));
    test.attempts.submitResultCheck({
      unitAttemptId,
      outcome: 'NOT_DISPATCHED',
      reasonCode: 'INVALID_ARTIFACT_REF',
    });
    expect(test.settlements).toHaveLength(0);
    expect(test.events).toContainEqual(
      expect.objectContaining({ status: 'REJECTED', reasonCode: 'INVALID_ARTIFACT_REF' }),
    );
  });
});

describe('CoreAttempts retries', () => {
  it('settles the old reservation and acquires a new one for a MODEL retry', async () => {
    const test = harness();
    const { unitAttemptId, executionId } = await started(test, unit('MODEL', []), 'req_model3');
    test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: false });
    expect(
      test.attempts.retryExecution({
        unitAttemptId,
        previousExecutionId: executionId,
        requestState: 'NOT_SENT',
      }),
    ).toEqual({ allowed: true, reservationId: 'rsv_2', grantId: 'grt_2' });
    expect(test.settlements).toEqual([{ id: 'rsv_1', value: { type: 'NOT_SENT' } }]);
    expect(test.releases).toEqual(['grt_1']);
  });

  it('charges the known usage of a sent MODEL request before retrying it', async () => {
    const test = harness();
    const { unitAttemptId, executionId } = await started(test, unit('MODEL', []), 'req_model6');
    test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: true });
    const usage = { inputTokens: 60, outputTokens: 5 };
    expect(
      test.attempts.retryExecution({
        unitAttemptId,
        previousExecutionId: executionId,
        requestState: 'SENT',
        usage,
      }),
    ).toEqual({ allowed: true, reservationId: 'rsv_2', grantId: 'grt_2' });
    expect(test.settlements).toEqual([{ id: 'rsv_1', value: { type: 'ACTUAL', usage } }]);
    expect(test.releases).toEqual(['grt_1']);
  });

  it('allows a non-MODEL technical retry without a reservation', async () => {
    const test = harness();
    const { unitAttemptId, executionId } = await started(test);
    expect(
      test.attempts.retryExecution({
        unitAttemptId,
        previousExecutionId: executionId,
        requestState: 'NOT_SENT',
      }),
    ).toEqual({ allowed: true });
    expect(test.settlements).toEqual([]);
  });

  it('rejects a retry whose consumption is unknown or that exceeded the limit', async () => {
    const test = harness();
    const { unitAttemptId, executionId } = await started(test, unit('MODEL', []), 'req_model4');
    test.attempts.requestReservation({ unitAttemptId, estimatedTokens: 100, final: false });
    for (const requestState of ['SENT', 'UNKNOWN'] as const)
      expect(
        test.attempts.retryExecution({
          unitAttemptId,
          previousExecutionId: executionId,
          requestState,
        }),
      ).toEqual({ allowed: false, reason: 'REQUEST_MAY_BE_SENT' });
    expect(
      test.attempts.retryExecution({
        unitAttemptId,
        previousExecutionId: executionId,
        requestState: 'UNKNOWN',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toEqual({ allowed: false, reason: 'REQUEST_MAY_BE_SENT' });
    expect(test.settlements).toEqual([]);

    const limited = harness({ retryLimit: 0 });
    const attempt = await started(limited, unit('MODEL', []), 'req_model5');
    expect(
      limited.attempts.retryExecution({
        unitAttemptId: attempt.unitAttemptId,
        previousExecutionId: attempt.executionId,
        requestState: 'NOT_SENT',
      }),
    ).toEqual({ allowed: false, reason: 'RETRY_LIMIT' });
  });
});
