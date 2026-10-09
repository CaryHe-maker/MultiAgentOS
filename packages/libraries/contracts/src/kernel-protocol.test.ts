import { describe, expect, it } from 'vitest';
import {
  AdmissionProjectionSchema,
  GatewayForwardSchema,
} from './kernel-control/gateway-forward.js';
import { RunFinishedSchema } from './kernel-control/interaction-events.js';
import { SyscallRejectedSchema } from './kernel-control/responses.js';
import { ExecutionFactSchema } from './kernel-execution/execution-fact.js';
import { ExecutionRequestSchema } from './kernel-execution/execution-request.js';
import { UnitReportSchema, WorkflowInboxEventSchema } from './kernel-unit/workflow-events.js';
import { CloseRunRequestSchema, SubmitUnitRequestSchema } from './kernel-unit/workflow-syscalls.js';
import { validate } from './platform-common/validation.js';

const sha = 'a'.repeat(64);
const artifactRef = { artifactId: `art_${sha}`, mediaType: 'text/plain', sha256: sha, size: 1 };
const unitRef = { kind: 'UNIT', id: 'file-read', version: 'v0.1.0', digest: sha };
const ok = (schema: Parameters<typeof validate>[0], value: unknown) => validate(schema, value).ok;

describe('conditional fields of the kernel protocol', () => {
  it('requires closeReason exactly for RUN_BLOCKED', () => {
    const rejected = { requestId: 'req_123456', outcome: 'REJECTED', issuer: 'CORE' };
    expect(ok(SyscallRejectedSchema, { ...rejected, reasonCode: 'FORBIDDEN' })).toBe(true);
    expect(ok(SyscallRejectedSchema, { ...rejected, reasonCode: 'RUN_BLOCKED' })).toBe(false);
    expect(
      ok(SyscallRejectedSchema, {
        ...rejected,
        reasonCode: 'RUN_BLOCKED',
        closeReason: 'CANCELLED',
      }),
    ).toBe(true);
    // A reason code that only appears in UnitReport is not a SyscallRejected reason.
    expect(ok(SyscallRejectedSchema, { ...rejected, reasonCode: 'NOT_FOUND' })).toBe(false);
  });

  it('ties UnitReport output to OK and reasonCode to REJECTED or FAILED', () => {
    const report = {
      type: 'UnitReport',
      requestId: 'req_123456',
      agentRunId: 'agr_123456',
      unitRef,
      executionKind: 'FILE_READ',
      budgetState: 'NORMAL',
    };
    const output = {
      path: 'a.ts',
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      contentSha256: sha,
      fileSha256: sha,
    };
    expect(ok(UnitReportSchema, { ...report, status: 'OK', output, outputRef: artifactRef })).toBe(
      true,
    );
    expect(ok(UnitReportSchema, { ...report, status: 'OK' })).toBe(false);
    expect(ok(UnitReportSchema, { ...report, status: 'REJECTED', reasonCode: 'NOT_FOUND' })).toBe(
      true,
    );
    expect(ok(UnitReportSchema, { ...report, status: 'FAILED' })).toBe(false);
    const event = {
      eventId: 'evt_123456',
      workflowRunId: 'wfr_123456',
      seq: 1,
      occurredAt: '2026-10-09T00:00:00.000Z',
      event: { ...report, status: 'REJECTED', reasonCode: 'USER_DECLINED' },
    };
    expect(ok(WorkflowInboxEventSchema, event)).toBe(true);
    expect(ok(WorkflowInboxEventSchema, { ...event, seq: 0 })).toBe(false);
  });

  it('requires reportRef for COMPLETED and failure for FAILED or VIOLATION', () => {
    const end = { type: 'RunFinished', unknownEffects: [], runSummaryRef: artifactRef };
    const failure = { code: 'KERNEL_INTERNAL', category: 'INTERNAL', source: 'KERNEL' };
    expect(
      ok(RunFinishedSchema, { ...end, closeReason: 'COMPLETED', reportRef: artifactRef }),
    ).toBe(true);
    expect(ok(RunFinishedSchema, { ...end, closeReason: 'COMPLETED' })).toBe(false);
    expect(ok(RunFinishedSchema, { ...end, closeReason: 'FAILED', failure })).toBe(true);
    expect(ok(RunFinishedSchema, { ...end, closeReason: 'VIOLATION' })).toBe(false);
    expect(ok(RunFinishedSchema, { ...end, closeReason: 'CANCELLED' })).toBe(true);
    expect(
      ok(RunFinishedSchema, { ...end, closeReason: 'CANCELLED', reportRef: artifactRef }),
    ).toBe(false);
  });

  it('accepts the two shapes of closeRun and the admission projection', () => {
    const close = { requestId: 'req_123456', workflowRunId: 'wfr_123456' };
    expect(
      ok(CloseRunRequestSchema, { ...close, outcome: 'COMPLETED', reportRef: artifactRef }),
    ).toBe(true);
    expect(ok(CloseRunRequestSchema, { ...close, outcome: 'FAILED' })).toBe(false);
    expect(
      ok(AdmissionProjectionSchema, { workflowRunId: 'wfr_123456', runState: 'RUNNING' }),
    ).toBe(true);
    expect(ok(AdmissionProjectionSchema, { workflowRunId: 'wfr_123456', runState: 'CLOSED' })).toBe(
      false,
    );
  });

  it('validates a submitUnit and its GatewayForward wrapper', () => {
    const request = {
      requestId: 'req_123456',
      workflowRunId: 'wfr_123456',
      agentRunId: 'agr_123456',
      unitRef,
      input: { path: 'src/a.ts' },
    };
    expect(ok(SubmitUnitRequestSchema, request)).toBe(true);
    expect(ok(SubmitUnitRequestSchema, { ...request, input: { command: 'rm' } })).toBe(false);
    const forward = { caller: 'workflow', requestType: 'submitUnit', request };
    expect(ok(GatewayForwardSchema, forward)).toBe(true);
    expect(ok(GatewayForwardSchema, { ...forward, caller: 'user-interaction' })).toBe(false);
  });

  it('fixes the input and scope of an ExecutionRequest by its executionKind', () => {
    const request = {
      workflowRunId: 'wfr_123456',
      unitAttemptId: 'una_123456',
      executionId: 'exe_123456',
      runEpoch: 1,
      executionKind: 'FILE_READ',
      input: { path: 'src/a.ts' },
      scope: { kind: 'REPOSITORY', repositoryRoot: '/repo', exclusions: [] },
      limits: { deadline: '2026-10-09T00:00:00.000Z', maxOutputBytes: 16384 },
    };
    expect(ok(ExecutionRequestSchema, request)).toBe(true);
    expect(ok(ExecutionRequestSchema, { ...request, scope: { kind: 'NONE' } })).toBe(false);
    expect(ok(ExecutionRequestSchema, { ...request, executionKind: 'REPORT_PUBLISH' })).toBe(false);
  });

  it('requires a result for COMPLETED and retryable for FAILED execution facts', () => {
    const fact = {
      workflowRunId: 'wfr_123456',
      unitAttemptId: 'una_123456',
      executionId: 'exe_123456',
      runEpoch: 1,
      endedAt: '2026-10-09T00:00:00.000Z',
    };
    expect(ok(ExecutionFactSchema, { ...fact, outcome: 'COMPLETED' })).toBe(false);
    expect(
      ok(ExecutionFactSchema, { ...fact, outcome: 'FAILED', reasonCode: 'PROVIDER_ERROR' }),
    ).toBe(false);
    expect(
      ok(ExecutionFactSchema, {
        ...fact,
        outcome: 'FAILED',
        reasonCode: 'PROVIDER_ERROR',
        retryable: false,
        requestState: 'UNKNOWN',
      }),
    ).toBe(true);
    expect(
      ok(ExecutionFactSchema, { ...fact, outcome: 'TERMINATED', reasonCode: 'UNIT_TIMEOUT' }),
    ).toBe(true);
  });
});
