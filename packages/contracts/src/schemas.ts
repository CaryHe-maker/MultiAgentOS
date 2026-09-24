import { Type, type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';

const Id = (prefix: string) =>
  Type.String({ pattern: `^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{5,127}$` });

export const IdSchemas = {
  workSessionId: Id('wss'),
  promptRevisionId: Id('prv'),
  sessionTreeNodeId: Id('stn'),
  workflowRunId: Id('wfr'),
  missionScopeId: Id('msc'),
  taskRunId: Id('tsk'),
  taskAttemptId: Id('tat'),
  agentRunId: Id('agr'),
  agentStepId: Id('ags'),
  unitIntentId: Id('uni'),
  unitAttemptId: Id('una'),
  contextPackId: Id('ctx'),
  artifactId: Id('art'),
  messageId: Id('msg'),
  correlationId: Id('cor'),
} as const;

export const VersionedRefSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1, maxLength: 128 }),
    id: Type.String({ minLength: 1, maxLength: 160 }),
    version: Type.String({ pattern: '^v[0-9]+(?:\\.[0-9]+){0,2}$' }),
  },
  { additionalProperties: false, $id: 'platform.common.VersionedRef.v0' },
);
export type VersionedRef = Static<typeof VersionedRefSchema>;
export type OpaqueRef<K extends string> = VersionedRef & { readonly kind: K };
const OpaqueRefSchema = <K extends string>(kind: K, schemaName: string) =>
  Type.Object(
    {
      kind: Type.Literal(kind),
      id: Type.String({ minLength: 1, maxLength: 160 }),
      version: Type.String({ pattern: '^v[0-9]+(?:\\.[0-9]+){0,2}$' }),
    },
    { additionalProperties: false, $id: schemaName },
  );
export const WorkflowCheckpointRefSchema = OpaqueRefSchema(
  'workflow-checkpoint',
  'checkpoint.WorkflowCheckpointRef.v0',
);
export const SessionCheckpointRefSchema = OpaqueRefSchema(
  'session-checkpoint',
  'checkpoint.SessionCheckpointRef.v0',
);
export const RestoreOperationRefSchema = OpaqueRefSchema(
  'restore-operation',
  'restore.RestoreOperationRef.v0',
);
export const HumanReviewRequestRefSchema = OpaqueRefSchema(
  'human-review-request',
  'review.HumanReviewRequestRef.v0',
);
export const HumanReviewDecisionRefSchema = OpaqueRefSchema(
  'human-review-decision',
  'review.HumanReviewDecisionRef.v0',
);
export const ChangeSetRefSchema = OpaqueRefSchema('change-set', 'integration.ChangeSetRef.v0');
export const IntegrationPlanRefSchema = OpaqueRefSchema(
  'integration-plan',
  'integration.IntegrationPlanRef.v0',
);
export const QualityGateResultRefSchema = OpaqueRefSchema(
  'quality-gate-result',
  'integration.QualityGateResultRef.v0',
);
export const PolicyDecisionRefSchema = OpaqueRefSchema(
  'policy-decision',
  'kernel.control.PolicyDecisionRef.v0',
);
export const ExecutionPermitRefSchema = OpaqueRefSchema(
  'execution-permit',
  'kernel.unit.ExecutionPermitRef.v0',
);
export const EffectRecordRefSchema = OpaqueRefSchema(
  'effect-record',
  'kernel.unit.EffectRecordRef.v0',
);
export const IndexRevisionRefSchema = OpaqueRefSchema(
  'index-revision',
  'context.IndexRevisionRef.v0',
);
export const ConsumerOffsetRefSchema = OpaqueRefSchema(
  'consumer-offset',
  'platform.communication.ConsumerOffsetRef.v0',
);
export const JournalPositionRefSchema = OpaqueRefSchema(
  'journal-position',
  'platform.persistence.JournalPositionRef.v0',
);
export const RetentionTokenRefSchema = OpaqueRefSchema(
  'retention-token',
  'platform.artifact.RetentionTokenRef.v0',
);
export type WorkflowCheckpointRef = Static<typeof WorkflowCheckpointRefSchema>;
export type SessionCheckpointRef = Static<typeof SessionCheckpointRefSchema>;
export type RestoreOperationRef = Static<typeof RestoreOperationRefSchema>;
export type HumanReviewRequestRef = Static<typeof HumanReviewRequestRefSchema>;
export type HumanReviewDecisionRef = Static<typeof HumanReviewDecisionRefSchema>;
export type ChangeSetRef = Static<typeof ChangeSetRefSchema>;
export type IntegrationPlanRef = Static<typeof IntegrationPlanRefSchema>;
export type QualityGateResultRef = Static<typeof QualityGateResultRefSchema>;
export type PolicyDecisionRef = Static<typeof PolicyDecisionRefSchema>;
export type ExecutionPermitRef = Static<typeof ExecutionPermitRefSchema>;
export type EffectRecordRef = Static<typeof EffectRecordRefSchema>;
export type IndexRevisionRef = Static<typeof IndexRevisionRefSchema>;
export type ConsumerOffsetRef = Static<typeof ConsumerOffsetRefSchema>;
export type JournalPositionRef = Static<typeof JournalPositionRefSchema>;
export type RetentionTokenRef = Static<typeof RetentionTokenRefSchema>;
export const PageSchema = <T extends TSchema>(item: T) =>
  Type.Object(
    {
      items: Type.Array(item),
      sourceVersion: Type.Integer({ minimum: 0 }),
      nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    },
    { additionalProperties: false },
  );
export const WorkspaceRefSchema = Type.Object(
  {
    workspaceId: Id('wsp'),
    rootPath: Type.String({ minLength: 1 }),
    repositoryRevision: Type.String({ minLength: 1 }),
    isolation: Type.Union([Type.Literal('WORKTREE'), Type.Literal('FIXTURE')]),
  },
  { additionalProperties: false, $id: 'platform.common.WorkspaceRef.v0' },
);
export type WorkspaceRef = Static<typeof WorkspaceRefSchema>;
export const ArtifactRefSchema = Type.Object(
  {
    artifactId: IdSchemas.artifactId,
    mediaType: Type.String({ minLength: 1, maxLength: 128 }),
    sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    size: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false, $id: 'platform.common.ArtifactRef.v0' },
);
export type ArtifactRef = Static<typeof ArtifactRefSchema>;

export const ModuleErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128 }),
    category: Type.Union([
      Type.Literal('VALIDATION'),
      Type.Literal('CONFLICT'),
      Type.Literal('POLICY'),
      Type.Literal('TIMEOUT'),
      Type.Literal('RESOURCE'),
      Type.Literal('DEPENDENCY'),
      Type.Literal('EXECUTION'),
      Type.Literal('INTEGRITY'),
      Type.Literal('CONTRACT'),
      Type.Literal('INTERNAL'),
    ]),
    message: Type.String({ minLength: 1, maxLength: 2048 }),
    retryable: Type.Boolean(),
    correlationId: IdSchemas.correlationId,
    diagnosticsRef: Type.Optional(ArtifactRefSchema),
    detailsRef: Type.Optional(ArtifactRefSchema),
  },
  { additionalProperties: false, $id: 'platform.common.ModuleError.v0' },
);
export type ModuleError = Static<typeof ModuleErrorSchema>;
export const CapabilityDescriptorSchema = Type.Object(
  {
    capability: Type.String({ minLength: 1, maxLength: 160 }),
    status: Type.Union([
      Type.Literal('SUPPORTED'),
      Type.Literal('UNSUPPORTED'),
      Type.Literal('DEGRADED'),
    ]),
    schemaNames: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  },
  { additionalProperties: false, $id: 'platform.common.CapabilityDescriptor.v0' },
);
export type CapabilityDescriptor = Static<typeof CapabilityDescriptorSchema>;

export const EnvelopeSchema = <T extends TSchema>(payload: T) =>
  Type.Object(
    {
      schemaName: Type.String({ pattern: '^[a-z][a-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+$' }),
      schemaVersion: Type.Integer({ minimum: 0 }),
      messageType: Type.Union([
        Type.Literal('command'),
        Type.Literal('query'),
        Type.Literal('event'),
        Type.Literal('signal'),
        Type.Literal('result'),
      ]),
      messageId: IdSchemas.messageId,
      producer: Type.String({ minLength: 1, maxLength: 128 }),
      occurredAt: Type.String({ format: 'date-time' }),
      tenantId: Type.String({ minLength: 1, maxLength: 128 }),
      projectId: Type.String({ minLength: 1, maxLength: 128 }),
      correlationId: IdSchemas.correlationId,
      causationId: Type.Optional(IdSchemas.messageId),
      workSessionId: Type.Optional(IdSchemas.workSessionId),
      workflowRunId: Type.Optional(IdSchemas.workflowRunId),
      missionScopeId: Type.Optional(IdSchemas.missionScopeId),
      aggregateId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      aggregateVersion: Type.Optional(Type.Integer({ minimum: 0 })),
      graphRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      traceparent: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      payload,
    },
    { additionalProperties: false, $id: 'platform.common.Envelope.v0' },
  );

export const BoundaryContextSchema = Type.Object(
  {
    correlationId: IdSchemas.correlationId,
    causationId: Type.Optional(IdSchemas.messageId),
    tenantId: Type.String({ minLength: 1, maxLength: 128 }),
    projectId: Type.String({ minLength: 1, maxLength: 128 }),
    workSessionId: Type.Optional(IdSchemas.workSessionId),
    workflowRunId: Type.Optional(IdSchemas.workflowRunId),
    deadline: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false, $id: 'platform.common.BoundaryContext.v0' },
);
export type BoundaryContext = Static<typeof BoundaryContextSchema>;

export const RunUserIntentSchema = Type.Object(
  {
    kind: Type.Literal('RUN'),
    idempotencyKey: Type.String({ minLength: 8, maxLength: 160 }),
    workSessionId: IdSchemas.workSessionId,
    promptRevisionId: IdSchemas.promptRevisionId,
    objective: Type.String({ minLength: 1, maxLength: 20_000 }),
    workspace: WorkspaceRefSchema,
  },
  { additionalProperties: false, $id: 'interaction.RunIntent.v0' },
);
export const InspectUserIntentSchema = Type.Object(
  {
    kind: Type.Literal('INSPECT'),
    workflowRunId: IdSchemas.workflowRunId,
  },
  { additionalProperties: false, $id: 'interaction.InspectIntent.v0' },
);
export const ReportUserIntentSchema = Type.Object(
  {
    kind: Type.Literal('REPORT'),
    workflowRunId: IdSchemas.workflowRunId,
  },
  { additionalProperties: false, $id: 'interaction.ReportIntent.v0' },
);
export const CancelUserIntentSchema = Type.Object(
  {
    kind: Type.Literal('CANCEL'),
    workflowRunId: IdSchemas.workflowRunId,
    idempotencyKey: Type.String({ minLength: 8, maxLength: 160 }),
    expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false, $id: 'interaction.CancelIntent.v0' },
);
export const UserIntentSchema = Type.Union(
  [RunUserIntentSchema, InspectUserIntentSchema, ReportUserIntentSchema, CancelUserIntentSchema],
  { $id: 'interaction.UserIntent.v0' },
);
export type UserIntent = Static<typeof UserIntentSchema>;
export type RunUserIntent = Static<typeof RunUserIntentSchema>;
export const TaskGraphSchema = Type.Object(
  {
    schemaVersion: Type.Literal('v0'),
    tasks: Type.Array(
      Type.Object(
        {
          taskId: Type.String({ minLength: 1, maxLength: 160 }),
          objective: Type.String({ minLength: 1, maxLength: 20_000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    edges: Type.Array(
      Type.Object(
        {
          fromTaskId: Type.String({ minLength: 1 }),
          toTaskId: Type.String({ minLength: 1 }),
          join: Type.Union([Type.Literal('ALL'), Type.Literal('ANY'), Type.Literal('QUORUM')]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, $id: 'workflow.TaskGraph.v0' },
);
export type TaskGraph = Static<typeof TaskGraphSchema>;

export const ExecutionKindSchema = Type.Union([
  Type.Literal('CONTEXT'),
  Type.Literal('MODEL'),
  Type.Literal('FILE_READ'),
  Type.Literal('FILE_WRITE'),
  Type.Literal('COMMAND'),
  Type.Literal('TEST'),
]);
export type ExecutionKind = Static<typeof ExecutionKindSchema>;
export const UnitOwnerSchema = Type.Object(
  {
    workflowRunId: IdSchemas.workflowRunId,
    taskRunId: IdSchemas.taskRunId,
    taskAttemptId: IdSchemas.taskAttemptId,
    agentRunId: IdSchemas.agentRunId,
    agentStepId: IdSchemas.agentStepId,
  },
  { additionalProperties: false },
);
export const UnitIntentSchema = Type.Object(
  {
    schemaVersion: Type.Literal('v0'),
    unitIntentId: IdSchemas.unitIntentId,
    owner: UnitOwnerSchema,
    missionScopeId: IdSchemas.missionScopeId,
    graphRevision: Type.Integer({ minimum: 0 }),
    executionKind: ExecutionKindSchema,
    definitionVersionRef: Type.Optional(VersionedRefSchema),
    inputRef: Type.Optional(ArtifactRefSchema),
    input: Type.Optional(Type.Unknown()),
    outputContractRef: VersionedRefSchema,
    workspace: WorkspaceRefSchema,
    timeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
    idempotencyKey: Type.String({ minLength: 8, maxLength: 160 }),
    deadline: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'kernel.unit.UnitIntent.v0' },
);
export type UnitIntent = Static<typeof UnitIntentSchema>;
export const UsageSchema = Type.Object(
  {
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
    durationMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export const UnitResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal('v0'),
    unitIntentId: IdSchemas.unitIntentId,
    unitAttemptId: IdSchemas.unitAttemptId,
    status: Type.Union([
      Type.Literal('SUCCEEDED'),
      Type.Literal('FAILED'),
      Type.Literal('TIMED_OUT'),
    ]),
    outputRef: Type.Optional(ArtifactRefSchema),
    evidenceRefs: Type.Array(ArtifactRefSchema),
    usage: UsageSchema,
    error: Type.Optional(ModuleErrorSchema),
    completedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'kernel.unit.UnitResult.v0' },
);
export type UnitResult = Static<typeof UnitResultSchema>;

export const ContextRequestSchema = Type.Object(
  {
    workflowRunId: IdSchemas.workflowRunId,
    missionScopeId: IdSchemas.missionScopeId,
    graphRevision: Type.Integer({ minimum: 0 }),
    taskRunId: IdSchemas.taskRunId,
    agentRunId: IdSchemas.agentRunId,
    workspace: WorkspaceRefSchema,
    objective: Type.String({ minLength: 1 }),
    query: Type.Optional(Type.String({ minLength: 1 })),
    previousObservationRefs: Type.Array(ArtifactRefSchema),
    tokenBudget: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false, $id: 'context.ContextRequest.v0' },
);
export type ContextRequest = Static<typeof ContextRequestSchema>;
export const ContextPackSchema = Type.Object(
  {
    contextPackId: IdSchemas.contextPackId,
    workspace: WorkspaceRefSchema,
    repositoryRevision: Type.String({ minLength: 1 }),
    items: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          startLine: Type.Integer({ minimum: 1 }),
          endLine: Type.Integer({ minimum: 1 }),
          content: Type.String(),
          reason: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    tokenCount: Type.Integer({ minimum: 0 }),
    provenance: Type.Array(
      Type.Object(
        {
          source: Type.String({ minLength: 1 }),
          revision: Type.String({ minLength: 1 }),
          retrieval: Type.Union([
            Type.Literal('TREE'),
            Type.Literal('PATH'),
            Type.Literal('TEXT'),
            Type.Literal('SYMBOL'),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'context.ContextPack.v0' },
);
export type ContextPack = Static<typeof ContextPackSchema>;

export const DefinitionQuerySchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('AGENT'),
      Type.Literal('MODEL'),
      Type.Literal('TOOL'),
      Type.Literal('PROMPT'),
      Type.Literal('CONTRACT'),
    ]),
    definitionId: Type.String({ minLength: 1, maxLength: 160 }),
    versionRange: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    requiredCapabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  },
  { additionalProperties: false, $id: 'catalog.DefinitionQuery.v0' },
);
export type DefinitionQuery = Static<typeof DefinitionQuerySchema>;
export const DefinitionVersionSchema = Type.Object(
  {
    ref: VersionedRefSchema,
    digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    inputContractRef: VersionedRefSchema,
    outputContractRef: VersionedRefSchema,
    capabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  },
  { additionalProperties: false, $id: 'catalog.DefinitionVersion.v0' },
);
export type DefinitionVersion = Static<typeof DefinitionVersionSchema>;
export const RuntimeProjectionSchema = Type.Object(
  {
    workflowRunId: IdSchemas.workflowRunId,
    status: Type.Union([
      Type.Literal('CREATED'),
      Type.Literal('RUNNING'),
      Type.Literal('SUCCEEDED'),
      Type.Literal('FAILED'),
      Type.Literal('CANCELLED'),
    ]),
    sourceVersion: Type.Integer({ minimum: 0 }),
    graphRevision: Type.Integer({ minimum: 0 }),
    currentStep: Type.Optional(Type.String({ minLength: 1 })),
    definitionVersions: Type.Array(DefinitionVersionSchema),
    usage: UsageSchema,
    evidenceRefs: Type.Array(ArtifactRefSchema),
    failure: Type.Optional(ModuleErrorSchema),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'kernel.control.RuntimeProjection.v0' },
);
export type RuntimeProjection = Static<typeof RuntimeProjectionSchema>;

export const WorkflowRunViewSchema = Type.Object(
  {
    workflowRunId: IdSchemas.workflowRunId,
    status: Type.Union([
      Type.Literal('CREATED'),
      Type.Literal('RUNNING'),
      Type.Literal('SUCCEEDED'),
      Type.Literal('FAILED'),
      Type.Literal('CANCELLED'),
    ]),
    sourceVersion: Type.Integer({ minimum: 0 }),
    graphRevision: Type.Integer({ minimum: 0 }),
    currentStep: Type.Optional(Type.String({ minLength: 1 })),
    definitionVersions: Type.Array(DefinitionVersionSchema),
    usage: UsageSchema,
    evidenceRefs: Type.Array(ArtifactRefSchema),
    failure: Type.Optional(ModuleErrorSchema),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'workflow.WorkflowRunView.v0' },
);
export type WorkflowRunView = Static<typeof WorkflowRunViewSchema>;

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };
export function validate<T>(schema: TSchema, value: unknown): ValidationResult<T> {
  const validator = Compile(schema);
  if (validator.Check(value)) return { ok: true, value: value as T };
  return {
    ok: false,
    issues: [...validator.Errors(value)].map(
      (error) => `${error.instancePath || '/'} ${error.message}`,
    ),
  };
}
export function assertValid<T>(schema: TSchema, value: unknown): T {
  const result = validate<T>(schema, value);
  if (!result.ok) throw new ContractValidationError(result.issues);
  return result.value;
}
export class ContractValidationError extends Error {
  public readonly issues: readonly string[];
  public constructor(issues: readonly string[]) {
    super(`Contract validation failed: ${issues.join('; ')}`);
    this.name = 'ContractValidationError';
    this.issues = issues;
  }
}
export function unsupported(
  capability: string,
  schemaName: string,
  correlationId: string,
): ModuleError {
  return {
    code: 'UNSUPPORTED_CAPABILITY',
    category: 'CONTRACT',
    message: `${capability} is not supported for ${schemaName}`,
    retryable: false,
    correlationId,
  };
}
