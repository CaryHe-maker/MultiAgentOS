import { Type, type Static, type TSchema } from 'typebox';
import { IdSchemas } from './ids.js';
import { Sha256Schema, TimestampSchema, closed, count, text } from './schema-helpers.js';

export const ArtifactRefSchema = closed(
  {
    artifactId: IdSchemas.artifactId,
    mediaType: text(128),
    sha256: Sha256Schema,
    size: count(),
  },
  'platform.common.ArtifactRef.v0',
);
export type ArtifactRef = Static<typeof ArtifactRefSchema>;

export const ErrorCategorySchema = Type.Enum(
  [
    'VALIDATION',
    'CONFLICT',
    'POLICY',
    'TIMEOUT',
    'RESOURCE',
    'DEPENDENCY',
    'EXECUTION',
    'INTEGRITY',
    'CONTRACT',
    'INTERNAL',
  ],
  { $id: 'platform.common.ErrorCategory.v0' },
);
export type ErrorCategory = Static<typeof ErrorCategorySchema>;

/** Failure value of the synchronous Ports only (CatalogPort and the like). */
export const ModuleErrorSchema = closed(
  {
    code: text(128),
    category: ErrorCategorySchema,
    message: text(2048),
    retryable: Type.Boolean(),
    correlationId: IdSchemas.correlationId,
    diagnosticsRef: Type.Optional(ArtifactRefSchema),
    detailsRef: Type.Optional(ArtifactRefSchema),
  },
  'platform.common.ModuleError.v0',
);
export type ModuleError = Static<typeof ModuleErrorSchema>;

export const CapabilityDescriptorSchema = closed(
  {
    capability: text(160),
    status: Type.Enum(['SUPPORTED', 'UNSUPPORTED', 'DEGRADED']),
    schemaNames: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    reason: Type.Optional(text(1024)),
  },
  'platform.common.CapabilityDescriptor.v0',
);
export type CapabilityDescriptor = Static<typeof CapabilityDescriptorSchema>;

export const PRODUCERS = [
  'user-interaction',
  'workflow',
  'gateway',
  'kernel-core',
  'supervisor',
] as const;
/** A communication subject; Gateway decides the caller from it (M1Interface 2.1). */
export type Producer = (typeof PRODUCERS)[number];

export const EnvelopeSchema = <T extends TSchema>(payload: T) =>
  closed(
    {
      schemaName: Type.String({ pattern: '^[a-z][a-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+$' }),
      schemaVersion: count(),
      messageType: Type.Enum(['command', 'query', 'event', 'signal', 'result']),
      messageId: IdSchemas.messageId,
      producer: Type.Enum(PRODUCERS),
      occurredAt: TimestampSchema,
      tenantId: text(128),
      projectId: text(128),
      correlationId: IdSchemas.correlationId,
      causationId: Type.Optional(IdSchemas.messageId),
      workflowRunId: Type.Optional(IdSchemas.workflowRunId),
      // Long-term fields kept optional; M1 does not fill them (M1Interface 3.2).
      workSessionId: Type.Optional(IdSchemas.workSessionId),
      missionScopeId: Type.Optional(IdSchemas.missionScopeId),
      aggregateId: Type.Optional(text(160)),
      aggregateVersion: Type.Optional(count()),
      graphRevision: Type.Optional(count()),
      traceparent: Type.Optional(text(256)),
      payload,
    },
    'platform.common.Envelope.v0',
  );
export type MessageType = 'command' | 'query' | 'event' | 'signal' | 'result';
export interface Envelope<T> {
  readonly schemaName: string;
  readonly schemaVersion: number;
  readonly messageType: MessageType;
  readonly messageId: string;
  readonly producer: Producer;
  readonly occurredAt: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly workflowRunId?: string;
  readonly payload: T;
}

export const BoundaryContextSchema = closed(
  {
    correlationId: IdSchemas.correlationId,
    causationId: Type.Optional(IdSchemas.messageId),
    tenantId: text(128),
    projectId: text(128),
    workflowRunId: Type.Optional(IdSchemas.workflowRunId),
    workSessionId: Type.Optional(IdSchemas.workSessionId),
    deadline: Type.Optional(TimestampSchema),
  },
  'platform.common.BoundaryContext.v0',
);
export type BoundaryContext = Static<typeof BoundaryContextSchema>;
