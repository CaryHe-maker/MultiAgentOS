import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { BoundaryContextSchema, EnvelopeSchema } from './common-schemas.js';
import { ContractValidationError, assertValid, unsupported, validate } from './validation.js';

const envelope = {
  schemaName: 'kernel.unit.SubmitUnitRequest',
  schemaVersion: 0,
  messageType: 'command',
  messageId: 'msg_123456',
  producer: 'workflow',
  occurredAt: '2026-10-09T00:00:00.000Z',
  tenantId: 'local',
  projectId: 'local',
  correlationId: 'cor_123456',
  payload: {},
};

describe('platform.common schemas', () => {
  const schema = EnvelopeSchema(Type.Object({}, { additionalProperties: false }));

  it('accepts a valid envelope and rejects undeclared fields', () => {
    expect(validate(schema, envelope).ok).toBe(true);
    expect(validate(schema, { ...envelope, accidental: true }).ok).toBe(false);
  });

  it('accepts only the five communication subjects as producer', () => {
    expect(validate(schema, { ...envelope, producer: 'executor' }).ok).toBe(false);
    expect(validate(schema, { ...envelope, producer: 'kernel-core' }).ok).toBe(true);
  });

  it('rejects malformed identifiers and timestamps', () => {
    expect(validate(schema, { ...envelope, messageId: 'req_123456' }).ok).toBe(false);
    const context = { correlationId: 'cor_123456', tenantId: 'local', projectId: 'local' };
    expect(validate(BoundaryContextSchema, context).ok).toBe(true);
    expect(validate(BoundaryContextSchema, { ...context, deadline: 'not-a-date' }).ok).toBe(false);
  });

  it('throws a ContractValidationError from assertValid', () => {
    expect(() => assertValid(BoundaryContextSchema, {})).toThrow(ContractValidationError);
  });

  it('builds a structured unsupported error', () => {
    expect(
      unsupported('checkpoint.create', 'checkpoint.SessionCheckpointRef.v0', 'cor_123456'),
    ).toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      retryable: false,
      category: 'CONTRACT',
    });
  });
});
