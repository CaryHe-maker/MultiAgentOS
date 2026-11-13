import fc from 'fast-check';
import type { TSchema } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
  ActivityEventSchema,
  ContextAssembleInputSchema,
  HumanAnsweredSchema,
  ReadProjectFileRequestSchema,
  RunStartSchema,
  RunStateChangedSchema,
  SessionLogRecordSchema,
  SubmitUnitRequestSchema,
  UnitReportSchema,
  createProtocolRegistry,
  newId,
  pathDerivedId,
  validate,
} from './index.js';

const isValid = (schema: TSchema, value: unknown): boolean => validate(schema, value).ok;
const artifact = { artifactId: `art_${'a'.repeat(64)}`, sha256: 'a'.repeat(64), size: 1 };

describe('one major (SharedContracts 4)', () => {
  const registry = createProtocolRegistry();

  it.each([
    'platform.common.Envelope',
    'kernel.unit.UnitReport',
    'kernel.unit.WorkflowInboxEvent',
    'kernel.control.InteractionInboxEvent',
    'catalog.AgentDefinition',
    'kernel.execution.ExecutionRequest',
  ])('resolves %s in major 1 and refuses any other', (name) => {
    expect(() => registry.resolve(name, 0)).toThrow('UNKNOWN_SCHEMA_MAJOR');
    expect(registry.resolve(name, 1).major).toBe(1);
    expect(() => registry.resolve(name, 2)).toThrow('UNKNOWN_SCHEMA_MAJOR');
  });

  it('registers the new family', () => {
    expect(registry.get('kernel.session.WorkflowSessionEvent.v1').family).toBe('kernel.session');
  });
});

describe('path-derived identifiers', () => {
  it('uses the first 32 digits of the SHA-256 of the path', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (path) => {
        const id = pathDerivedId('req', path);
        expect(id).toMatch(/^req_[0-9a-f]{32}$/);
        expect(id).toBe(pathDerivedId('req', path));
      }),
    );
  });
});

describe('Schema-enforced constraints', () => {
  const unitRun = 'agr_abcdef/round-1/1';
  const path = `${unitRun}#1`;
  const request = {
    requestId: pathDerivedId('req', path),
    sessionId: newId('ses'),
    workflowRunId: newId('wfr'),
    agentRunId: newId('agr'),
    unitRunId: pathDerivedId('unr', unitRun),
    path,
    unitRef: { kind: 'UNIT', id: 'file-read', version: 'v1.0.0', digest: 'a'.repeat(64) },
    input: { path: 'a.ts' },
    display: { toolName: 'read_file', argsSummary: 'a.ts' },
  };

  it('accepts a submitUnit whose IDs come from its path', () => {
    expect(isValid(SubmitUnitRequestSchema, request)).toBe(true);
  });

  it('refuses a requestId or unitRunId that does not', () => {
    expect(isValid(SubmitUnitRequestSchema, { ...request, requestId: newId('req') })).toBe(false);
    expect(
      isValid(SubmitUnitRequestSchema, { ...request, unitRunId: pathDerivedId('unr', 'other') }),
    ).toBe(false);
  });

  it('allows only the white-listed project files', () => {
    const base = { requestId: newId('req'), sessionId: newId('ses'), workflowRunId: newId('wfr') };
    const accepts = (value: string) =>
      isValid(ReadProjectFileRequestSchema, { ...base, path: value });
    expect(accepts('AGENTS.md')).toBe(true);
    expect(accepts('.multiagentos/workflows/research.yaml')).toBe(true);
    expect(accepts('../AGENTS.md')).toBe(false);
    expect(accepts('.env')).toBe(false);
    expect(accepts('.multiagentos/workflows/../x.yaml')).toBe(false);
  });

  it('ties templateRef to the run mode', () => {
    const start = { type: 'RunStart', preset: 'standard', initialInput: true };
    const templateRef = { id: 'analyze', version: 'v1.0.0' };
    expect(isValid(RunStartSchema, { ...start, mode: 'CHAT' })).toBe(true);
    expect(isValid(RunStartSchema, { ...start, mode: 'CHAT', templateRef })).toBe(false);
    expect(isValid(RunStartSchema, { ...start, mode: 'ORCHESTRATION' })).toBe(false);
    expect(isValid(RunStartSchema, { ...start, mode: 'ORCHESTRATION', templateRef })).toBe(true);
  });

  it('ties humanRequestId to the answer origin', () => {
    const answer = {
      type: 'HumanAnswered',
      kind: 'prompt',
      inputId: newId('inp'),
      contentRef: { ...artifact, mediaType: 'text/plain; charset=utf-8' },
      checkpointId: newId('ckp'),
    };
    const humanRequestId = `hrq_${'b'.repeat(32)}`;
    expect(isValid(HumanAnsweredSchema, { ...answer, origin: 'initial' })).toBe(true);
    // User text only ever travels as a reference (M2Design 7.5).
    expect(isValid(HumanAnsweredSchema, { ...answer, origin: 'initial', text: 'hi' })).toBe(false);
    expect(isValid(HumanAnsweredSchema, { ...answer, origin: 'initial', goalText: 'hi' })).toBe(
      false,
    );
    expect(isValid(HumanAnsweredSchema, { ...answer, origin: 'initial', humanRequestId })).toBe(
      false,
    );
    expect(isValid(HumanAnsweredSchema, { ...answer, origin: 'requested' })).toBe(false);
    expect(isValid(HumanAnsweredSchema, { ...answer, origin: 'requested', humanRequestId })).toBe(
      true,
    );
  });

  it('forbids a turn in AWAITING_INPUT', () => {
    const changed = { type: 'RunStateChanged' };
    const checkpointId = newId('ckp');
    expect(isValid(RunStateChangedSchema, { ...changed, state: 'AWAITING_INPUT' })).toBe(true);
    expect(
      isValid(RunStateChangedSchema, { ...changed, state: 'AWAITING_INPUT', checkpointId }),
    ).toBe(false);
    expect(isValid(RunStateChangedSchema, { ...changed, state: 'RUNNING', checkpointId })).toBe(
      true,
    );
  });

  it('carries retry exactly in the RETRYING phase', () => {
    const event = {
      type: 'ActivityEvent',
      agentRunId: newId('agr'),
      label: 'main',
      at: '2026-10-31T00:00:00.000Z',
    };
    const retry = { attempt: 1, retryAt: '2026-10-31T00:00:05.000Z' };
    expect(isValid(ActivityEventSchema, { ...event, phase: 'RETRYING', retry })).toBe(true);
    expect(isValid(ActivityEventSchema, { ...event, phase: 'RETRYING' })).toBe(false);
    expect(isValid(ActivityEventSchema, { ...event, phase: 'THINKING', retry })).toBe(false);
  });

  it('requires final to agree with the status', () => {
    const input = {
      final: true,
      history: [],
      status: {
        round: 1,
        maxRounds: 10,
        budget: { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' },
        final: false,
      },
    };
    expect(isValid(ContextAssembleInputSchema, input)).toBe(false);
    expect(isValid(ContextAssembleInputSchema, { ...input, final: false })).toBe(true);
  });

  it('carries quota exactly with QUOTA_EXHAUSTED, and no attempt', () => {
    const refused = {
      type: 'UnitReport',
      requestId: newId('req'),
      agentRunId: newId('agr'),
      unitRunId: pathDerivedId('unr', 'agr_test0001/round-1/1'),
      unitRef: { kind: 'UNIT', id: 'file-read', version: 'v1.0.0', digest: 'd'.repeat(64) },
      executionKind: 'FILE_READ',
      budget: { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' },
      status: 'REJECTED',
      reasonCode: 'QUOTA_EXHAUSTED',
      quota: 'TOOL_UNITS',
    };
    const withoutQuota: Record<string, unknown> = { ...refused };
    delete withoutQuota.quota;
    expect(isValid(UnitReportSchema, refused)).toBe(true);
    expect(isValid(UnitReportSchema, withoutQuota)).toBe(false);
    expect(isValid(UnitReportSchema, { ...refused, unitAttemptId: newId('una') })).toBe(false);
    expect(isValid(UnitReportSchema, { ...refused, reasonCode: 'USER_DECLINED' })).toBe(false);
    expect(isValid(UnitReportSchema, { ...withoutQuota, reasonCode: 'USER_DECLINED' })).toBe(true);
  });
});

describe('session log records', () => {
  it('accepts a known record and refuses an unknown type', () => {
    const record = {
      seq: 1,
      at: '2026-10-31T00:00:00.000Z',
      type: 'SESSION_STARTED',
      formatVersion: 1,
      repositoryRoot: '/repo',
      definitionsDigest: 'a'.repeat(64),
      definitionVersions: ['main@v1.0.0'],
    };
    expect(isValid(SessionLogRecordSchema, record)).toBe(true);
    expect(isValid(SessionLogRecordSchema, { ...record, formatVersion: 2 })).toBe(false);
    expect(isValid(SessionLogRecordSchema, { ...record, type: 'SOMETHING_NEW' })).toBe(false);
  });
});
