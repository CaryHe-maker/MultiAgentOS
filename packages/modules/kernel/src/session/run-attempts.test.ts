import {
  UnitReportV1Schema,
  assertValid,
  type ExecutionKindV1,
  type ExecutionScope,
  type UnitDefinitionV1,
  type UnitOutputV1,
  type UnitReportV1,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import type { SchedulerDuties } from '../interfaces/index.js';
import { RunLedgers, finalReserve, minShare, type AgentBudget } from '../monitor/run-ledgers.js';
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
const digest = 'd'.repeat(64);
const sha256 = 'a'.repeat(64);
const outputRef = { artifactId: `art_${sha256}`, sha256, size: 1, mediaType: 'text/plain' };

function unit(executionKind: ExecutionKindV1): UnitDefinitionV1 {
  return { id: 'u', version: 'v1.0.0', digest, executionKind } as unknown as UnitDefinitionV1;
}

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
  const reports: UnitReportV1[] = [];
  const ended: string[] = [];
  const faults: AttemptFault[] = [];
  const audits: AttemptAudit[] = [];
  let attempts = 0;
  const run = new RunAttempts({
    provider: 'deepseek',
    technicalRetryLimit: 1,
    ledger,
    scheduler,
    createAttempt: () => {
      attempts += 1;
      return Promise.resolve(`una_attempt${attempts}`);
    },
    isDeliverable: () => options.deliverable !== false,
    isConverging: () => options.deliverable === false,
    leaseIsValid: () => options.lease !== false,
    deliver: (report) => reports.push(assertValid(UnitReportV1Schema, report)),
    attemptEnded: (id) => ended.push(id),
    onFault: (fault) => faults.push(fault),
    audit: (entry) => audits.push(entry),
  });
  const start = (kind: ExecutionKindV1, over: Partial<AttemptSpec> = {}) =>
    run.start({
      requestId: 'req_test01',
      agentRunId: 'agr_main01',
      unitRunId: 'unr_test01',
      turnId: 'trn_1',
      unit: unit(kind),
      input: {},
      scope: { kind: 'NONE' },
      runEpoch: 0,
      ...over,
    });
  return { run, start, reports, ended, faults, audits, grants };
}

const fileOutput: UnitOutputV1 = {
  path: 'a.ts',
  startLine: 1,
  endLine: 1,
  totalLines: 1,
  contentSha256: sha256,
  fileSha256: sha256,
};

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
      unitRunId: 'unr_test01',
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
      requestId: 'req_test01',
      reasonCode: 'INTERNAL',
    });
  });

  it('treats a second check, a wrong execution or a lost Lease as stale', async () => {
    const { run, start, reports, audits } = setup({ lease: false });
    const id = await start('FILE_READ', { scope: { kind: 'REPOSITORY' } as ExecutionScope });
    run.registerExecution(id, 'exe_1');
    run.submitResultCheck({
      unitAttemptId: id,
      executionId: 'exe_1',
      outcome: 'COMPLETED',
      output: fileOutput,
    });
    run.submitResultCheck({
      unitAttemptId: 'una_attempt9',
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
      { kind: 'VIOLATION', reasonCode: 'PATH_ESCAPE', requestId: 'req_test01' },
    ]);
  });
});

describe('reservations', () => {
  it('allows one final call per AgentRun', async () => {
    const { run, start, reports } = setup();
    const first = await start('MODEL');
    const final = { estimatedTokens: finalReserve(main), final: true };
    expect(run.requestReservation({ unitAttemptId: first, ...final }).granted).toBe(true);
    const other = await start('MODEL', { agentRunId: 'agr_other1', requestId: 'req_test02' });
    expect(run.requestReservation({ unitAttemptId: other, ...final }).granted).toBe(true);
    const again = await start('MODEL', { requestId: 'req_test03' });
    expect(run.requestReservation({ unitAttemptId: again, ...final })).toEqual({
      granted: false,
      reason: 'FINAL_CALL_USED',
    });
    expect(reports.at(-1)).toMatchObject({ status: 'REJECTED', reasonCode: 'FINAL_CALL_USED' });
    expect(run.usedFinalCall('agr_main01')).toBe(true);
  });

  it('delivers the budget refusal and gives the call opportunity back', async () => {
    const { run, start, reports, grants } = setup();
    const id = await start('MODEL');
    const decision = run.requestReservation({
      unitAttemptId: id,
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
    run.requestReservation({ unitAttemptId: id, estimatedTokens: 50, final: false });
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

describe('refusals without an attempt', () => {
  it.each(['USER_DECLINED', 'QUOTA_EXHAUSTED'] as const)(
    'delivers %s as a tool result',
    (reasonCode) => {
      const { run, reports } = setup();
      run.rejectWithoutAttempt(
        {
          requestId: 'req_test01',
          agentRunId: 'agr_main01',
          unitRunId: 'unr_test01',
          unit: unit('FILE_READ'),
        },
        reasonCode,
      );
      expect(reports[0]).toMatchObject({ status: 'REJECTED', reasonCode });
      expect(reports[0]).not.toHaveProperty('unitAttemptId');
    },
  );
});
