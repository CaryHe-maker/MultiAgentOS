import { describe, expect, it } from 'vitest';
import {
  BoundaryContextSchema,
  EnvelopeSchema,
  PROTOCOL_FAMILIES,
  TaskGraphSchema,
  UnitIntentSchema,
  UserIntentSchema,
  createM1ProtocolRegistry,
  unsupported,
  validate,
} from './index.js';

const ids = {
  workflowRunId: 'wfr_123456',
  taskRunId: 'tsk_123456',
  taskAttemptId: 'tat_123456',
  agentRunId: 'agr_123456',
  agentStepId: 'ags_123456',
};

describe('FR-CON-001 FR-PRO-001 protocol schemas', () => {
  it('accepts a valid envelope and rejects undeclared fields', () => {
    const schema = EnvelopeSchema(TaskGraphSchema);
    const value = {
      schemaName: 'workflow.Create.v0',
      schemaVersion: 0,
      messageType: 'command',
      messageId: 'msg_123456',
      producer: 'test',
      occurredAt: new Date().toISOString(),
      tenantId: 'local',
      projectId: 'fixture',
      correlationId: 'cor_123456',
      payload: { schemaVersion: 'v0', tasks: [{ taskId: 'one', objective: 'test' }], edges: [] },
    };
    expect(validate(schema, value).ok).toBe(true);
    expect(validate(schema, { ...value, accidental: true }).ok).toBe(false);
  });
  it('rejects invalid UnitIntent identity and deadline', () => {
    const result = validate(UnitIntentSchema, {
      schemaVersion: 'v0',
      unitIntentId: 'bad',
      owner: ids,
      missionScopeId: 'msc_123456',
      graphRevision: 0,
      executionKind: 'CONTEXT',
      outputContractRef: { kind: 'contract', id: 'context.ContextPack', version: 'v0' },
      workspace: {
        workspaceId: 'wsp_123456',
        rootPath: '.',
        repositoryRevision: 'HEAD',
        isolation: 'FIXTURE',
      },
      timeoutMs: 1000,
      idempotencyKey: '12345678',
      deadline: 'not-a-date',
    });
    expect(result.ok).toBe(false);
  });
  it('requires one discriminated intent shape and a valid boundary context', () => {
    expect(
      validate(UserIntentSchema, {
        kind: 'INSPECT',
        workflowRunId: 'wfr_123456',
      }).ok,
    ).toBe(true);
    expect(
      validate(UserIntentSchema, {
        kind: 'INSPECT',
        workflowRunId: 'wfr_123456',
        objective: 'fields from RUN must not leak into INSPECT',
      }).ok,
    ).toBe(false);
    expect(
      validate(BoundaryContextSchema, {
        correlationId: 'cor_123456',
        tenantId: 'local',
        projectId: 'fixture',
        deadline: 'not-a-date',
      }).ok,
    ).toBe(false);
  });
});

describe('FR-CON-003 FR-PRO-005 FR-PRO-009 registry', () => {
  it('covers every required protocol family and rejects unknown majors', () => {
    const registry = createM1ProtocolRegistry();
    for (const family of PROTOCOL_FAMILIES)
      expect(registry.list().some((entry) => entry.schemaName.startsWith(family))).toBe(true);
    expect(() => registry.resolve('workflow.Boundary', 1)).toThrow('UNKNOWN_SCHEMA_MAJOR');
  });
  it('returns a structured unsupported result', () => {
    expect(unsupported('checkpoint.create', 'checkpoint.Boundary', 'cor_123456')).toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      retryable: false,
      category: 'CONTRACT',
    });
  });
});
