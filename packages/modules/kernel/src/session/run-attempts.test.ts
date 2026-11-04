import {
  UnitReportSchema,
  assertValid,
  type ExecutionKind,
  type UnitReport,
} from '@multiagentos/contracts';
import {
  testArtifactRef,
  testFileReadOutput,
  testId,
  testUnitDefinition,
} from '@multiagentos/contracts/test-support';
import { describe, expect, it } from 'vitest';
import type { SchedulerDuties } from '../interfaces/index.js';
import { RunLedgers, finalReserve, minShare, type AgentBudget } from '../monitor/index.js';
import { testPinnedAgent } from '../test-support/run-work.js';
import {
  RunAttempts,
  type AttemptAudit,
  type AttemptFault,
  type AttemptSpec,
} from './run-attempts.js';

const main: AgentBudget = {
  perCallInputLimit: 100,
  maxOutputTokens: 50,
  finalInputBudget: 40,
  finalMaxOutputTokens: 20,
};
const outputRef = testArtifactRef();
const fileOutput = testFileReadOutput();
const unit = (kind: ExecutionKind) => testUnitDefinition(kind);

function setup(options: { capacity?: boolean; deliverable?: boolean; lease?: boolean } = {}) {
  const ledger = new RunLedgers(
    { runTokenLimit: minShare(main) * 4, turnTokenLimit: minShare(main) * 2 },
    main,
  );
  ledger.openTurnLedger('trn_1');
  const grants = new Set<string>();
  let next = 0;
  const scheduler: SchedulerDuties = {
    acquire: () => {
      if (options.capacity === false) return { ok: false };
      next += 1;
      grants.add(`grt_${next}`);
      return { ok: true, grantId: `grt_${next}` };
    },
    release: (grantId) => grants.delete(grantId),
    stopGranting: () => undefined,
    releaseAll: () => 0,
  };
  const reports: UnitReport[] = [];
  const ended: string[] = [];
  const faults: AttemptFault[] = [];
  const audits: AttemptAudit[] = [];
  let attempts = 0;
  const run = new RunAttempts({
    provider: 'deepseek',
    technicalRetryLimit: 1,
    ledger,
    scheduler,
    createAttempt: (spec) => {
      attempts += 1;
      const id = testId('una', attempts);
      run.registerAttempt(id, spec.requestId);
      return Promise.resolve(id);
    },
    isDeliverable: () => options.deliverable !== false,
    isConverging: () => options.deliverable === false,
    leaseIsValid: () => options.lease !== false,
    deliver: (report) => reports.push(assertValid(UnitReportSchema, report)),
    attemptStarted: () => undefined,
    attemptRunning: () => undefined,
    attemptEnded: (_spec, id) => ended.push(id),
    onFault: (fault) => faults.push(fault),
    audit: (entry) => audits.push(entry),
  });
  const start = (kind: ExecutionKind, over: Partial<AttemptSpec> = {}) =>
    run.start({
      requestId: testId('req', 1),
      agentRunId: testId('agr', 1),
      unitRunId: testId('unr', 1),
      turnId: 'trn_1',
      unit: unit(kind),
      input: {},
      scope: { kind: 'NONE' },
      runEpoch: 0,
      agent: testPinnedAgent(),
      display: { toolName: 'tool', argsSummary: '' },
      ...over,
    });
  return { run, start, reports, ended, faults, audits, grants };
}

const reservation = { cacheHitWeight: 1, inputEstimate: 1 };

describe('result checks', () => {
  it('delivers an OK report with unitRunId and BudgetView', async () => {
    const { run, start, reports, ended } = setup();
    const id = await start('FILE_READ');
    run.registerExecution(id, 'exe_1');
    run.submitResultCheck({
      unitAttemptId: id,
      executionId: 'exe_1',
      outcome: 'COMPLETED',
      output: fileOutput,
      outputRef,
    });
    expect(reports[0]).toMatchObject({
      status: 'OK',
      unitRunId: testId('unr', 1),
      budget: { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' },
    });
    expect(ended).toEqual([id]);
  });

  it('accepts a built-in Unit without an execution', async () => {
    const { run, start, reports } = setup();
    const id = await start('MESSAGE_PUBLISH');
    run.submitResultCheck({
      unitAttemptId: id,
      outcome: 'COMPLETED',
      output: { kind: 'REPLY' },
      outputRef,
    });
    expect(reports[0]?.status).toBe('OK');
  });

  it('settles but does not deliver once the run is converging', async () => {
    const { run, start, reports, ended, audits } = setup({ deliverable: false });
    const id = await start('FILE_READ');
    run.registerExecution(id, 'exe_1');
    run.submitResultCheck({
      unitAttemptId: id,
      executionId: 'exe_1',
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
    });
    expect(reports).toEqual([]);
    expect(ended).toEqual([id]);
    expect(audits).toContainEqual({
      type: 'UNIT_NOT_DELIVERED',
      requestId: testId('req', 1),
      reasonCode: 'INTERNAL',
    });
  });

  it('treats a second check, a wrong execution or a lost Lease as stale', async () => {
    const { run, start, reports, audits } = setup({ lease: false });
    const id = await start('FILE_READ');
    run.registerExecution(id, 'exe_1');
    run.submitResultCheck({
      unitAttemptId: id,
      executionId: 'exe_1',
      outcome: 'COMPLETED',
      output: fileOutput,
    });
    run.submitResultCheck({
      unitAttemptId: testId('una', 9),
      outcome: 'NOT_DISPATCHED',
      reasonCode: 'INTERNAL',
    });
    expect(reports).toEqual([]);
    expect(audits.filter((entry) => entry.type === 'STALE_FACT')).toHaveLength(2);
  });

  it('turns a violation into a fault', async () => {
    const { run, start, faults } = setup();
    const id = await start('FILE_READ');
    run.registerExecution(id, 'exe_1');
    run.submitResultCheck({
      unitAttemptId: id,
      executionId: 'exe_1',
      outcome: 'VIOLATION',
      reasonCode: 'PATH_ESCAPE',
    });
    expect(faults).toEqual([
      { kind: 'VIOLATION', reasonCode: 'PATH_ESCAPE', requestId: testId('req', 1) },
    ]);
  });
});

describe('reservations', () => {
  it('allows one final call per AgentRun', async () => {
    const { run, start, reports } = setup();
    const first = await start('MODEL');
    const final = { ...reservation, estimatedTokens: finalReserve(main), final: true };
    expect(run.requestReservation({ unitAttemptId: first, ...final }).granted).toBe(true);
    const other = await start('MODEL', {
      agentRunId: testId('agr', 2),
      requestId: testId('req', 2),
    });
    expect(run.requestReservation({ unitAttemptId: other, ...final }).granted).toBe(true);
    const again = await start('MODEL', { requestId: testId('req', 3) });
    expect(run.requestReservation({ unitAttemptId: again, ...final })).toEqual({
      granted: false,
      reason: 'FINAL_CALL_USED',
    });
    expect(reports.at(-1)).toMatchObject({ status: 'REJECTED', reasonCode: 'FINAL_CALL_USED' });
    expect(run.usedFinalCall(testId('agr', 1))).toBe(true);
  });

  it('delivers the budget refusal and gives the call opportunity back', async () => {
    const { run, start, reports, grants } = setup();
    const id = await start('MODEL');
    const decision = run.requestReservation({
      unitAttemptId: id,
      ...reservation,
      estimatedTokens: 10_000,
      final: false,
    });
    expect(decision.granted).toBe(false);
    expect(reports[0]).toMatchObject({ status: 'REJECTED', reasonCode: 'BUDGET_WRAP_UP' });
    expect(grants.size).toBe(0);
  });

  it('retries a MODEL request only when its consumption is known', async () => {
    const { run, start } = setup();
    const id = await start('MODEL');
    run.requestReservation({
      ...reservation,
      unitAttemptId: id,
      estimatedTokens: 50,
      final: false,
    });
    run.registerExecution(id, 'exe_1');
    expect(
      run.retryExecution({
        unitAttemptId: id,
        previousExecutionId: 'exe_1',
        requestState: 'UNKNOWN',
      }),
    ).toEqual({ allowed: false, reason: 'REQUEST_MAY_BE_SENT' });
    expect(
      run.retryExecution({
        unitAttemptId: id,
        previousExecutionId: 'exe_1',
        requestState: 'NOT_SENT',
      }).allowed,
    ).toBe(true);
    run.registerExecution(id, 'exe_2');
    expect(
      run.retryExecution({
        unitAttemptId: id,
        previousExecutionId: 'exe_2',
        requestState: 'NOT_SENT',
      }),
    ).toEqual({ allowed: false, reason: 'RETRY_LIMIT' });
  });
});

describe('attempts that end without a result', () => {
  it('ends an attempt asking for a reservation while the run converges', async () => {
    const { run, start, ended } = setup({ deliverable: false });
    const id = await start('MODEL');
    expect(
      run.requestReservation({
        ...reservation,
        unitAttemptId: id,
        estimatedTokens: 10,
        final: false,
      }),
    ).toEqual({
      granted: false,
      reason: 'RUN_CONVERGING',
    });
    expect(ended).toEqual([id]);
  });

  it('ends a queued attempt once, and gives its opportunity back', async () => {
    const { run, start, ended, grants } = setup();
    const id = await start('MODEL');
    run.requestReservation({
      ...reservation,
      unitAttemptId: id,
      estimatedTokens: 10,
      final: false,
    });
    run.abandon(id);
    run.abandon(id);
    expect(ended).toEqual([id]);
    expect(grants.size).toBe(0);
  });
});

describe('refusals without an attempt', () => {
  it.each([
    { reasonCode: 'USER_DECLINED' },
    { reasonCode: 'QUOTA_EXHAUSTED', quota: 'TOOL_UNITS' },
    { reasonCode: 'QUOTA_EXHAUSTED', quota: 'WALL_CLOCK' },
  ] as const)('delivers $reasonCode $quota as a tool result', (refusal) => {
    const { run, reports } = setup();
    run.rejectWithoutAttempt(
      {
        requestId: testId('req', 1),
        agentRunId: testId('agr', 1),
        unitRunId: testId('unr', 1),
        unit: unit('FILE_READ'),
      },
      refusal,
    );
    expect(reports[0]).toMatchObject({ status: 'REJECTED', ...refusal });
    expect(reports[0]).not.toHaveProperty('unitAttemptId');
  });

  it('calibrates the context on all input tokens, cached or not', async () => {
    const { run, start } = setup();
    const id = await start('MODEL');
    run.requestReservation({
      ...reservation,
      unitAttemptId: id,
      estimatedTokens: 50,
      final: false,
      inputEstimate: 40,
    });
    run.registerExecution(id, 'exe_1');
    expect(run.calibrationOf('main')).toBeUndefined();
    run.submitResultCheck({
      unitAttemptId: id,
      executionId: 'exe_1',
      outcome: 'COMPLETED',
      output: fileOutput,
      outputRef,
      usage: { inputTokens: 44, inputCacheHitTokens: 40, outputTokens: 1 },
    });
    expect(run.calibrationOf('main')).toEqual({
      measuredInputTokens: 44,
      estimatedInputTokens: 40,
    });
  });
});
