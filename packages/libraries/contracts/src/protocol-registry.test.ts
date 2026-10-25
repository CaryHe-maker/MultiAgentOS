import { describe, expect, it } from 'vitest';
import { ArtifactRefSchema } from './platform-common/common-schemas.js';
import { validate } from './platform-common/validation.js';
import { ProtocolRegistry, createM1ProtocolRegistry, parseSchemaId } from './protocol-registry.js';

/** Schema IDs of docs/M1/Library/SharedContracts.md section 3, without the `.v0` suffix. */
const EXPECTED = {
  'platform.common': [
    'BoundaryContext',
    'Envelope',
    'ArtifactRef',
    'ErrorCategory',
    'ModuleError',
    'CapabilityDescriptor',
    'ReasonCode',
    'ExecutionKind',
    'VersionedRef',
  ],
  'platform.config': ['KernelConfig', 'WorkflowConfig', 'SystemConfig'],
  executor: [
    'ModelToolCall',
    'FileReadInput',
    'FileReadOutput',
    'TokenUsage',
    'ModelCallInput',
    'ModelCallOutput',
    'ModelRawOutput',
  ],
  context: [
    'ModelToolSpec',
    'ContextPack',
    'RepositoryOrientInput',
    'RepositoryOrientOutput',
    'RepositorySearchInput',
    'RepositorySearchOutput',
    'ContextAssembleInput',
    'ContextAssembleOutput',
  ],
  workflow: ['StepRecord', 'StatusFacts', 'HandoffBrief', 'AnalysisReportDraft', 'AnalysisReport'],
  catalog: [
    'DefinitionKind',
    'DefinitionRef',
    'PinnedDefinitionRef',
    'ContractRef',
    'AgentDefinition',
    'UnitDefinition',
    'ToolDefinition',
    'ModelDefinition',
    'PromptDefinition',
    'Definition',
    'DefinitionStatus',
    'DefinitionLookup',
    'AgentPinRequest',
    'PinnedDefinitionSet',
    'DefinitionStatusFile',
  ],
  'kernel.control': [
    'CloseReason',
    'RunFailure',
    'UnknownEffect',
    'SyscallAck',
    'SyscallRejected',
    'RunCreated',
    'ArtifactContent',
    'CreateRunRequest',
    'AnswerAuthorizationRequest',
    'CancelRunRequest',
    'ReadArtifactRequest',
    'ShutdownRequest',
    'AuthorizationRequest',
    'AuthorizationResolved',
    'RunFinished',
    'InteractionInboxEvent',
    'RunSummary',
    'GatewayForward',
    'AdmissionProjection',
  ],
  'kernel.unit': [
    'BudgetState',
    'ReportPublishInput',
    'ReportPublishOutput',
    'UnitInput',
    'UnitOutput',
    'RegisterAgentRunRequest',
    'SubmitUnitRequest',
    'EndAgentRunRequest',
    'CloseRunRequest',
    'RunStart',
    'UnitReport',
    'RunClosed',
    'WorkflowInboxEvent',
  ],
  'kernel.execution': [
    'ExecutionScope',
    'ExecutionLimits',
    'OrientExecutorInput',
    'SearchExecutorInput',
    'AssembleExecutorInput',
    'ModelExecutorInput',
    'ExecutionRequest',
    'ExecutionResult',
    'ExecutionFact',
    'CancelRunExecutionsRequest',
    'SupervisorShutdownRequest',
  ],
  'platform.fabric': ['ConsumerOffsetRef'],
  'platform.persistence': ['JournalPositionRef'],
  'platform.artifact': ['RetentionTokenRef'],
  checkpoint: ['WorkflowCheckpointRef', 'SessionCheckpointRef'],
  restore: ['RestoreOperationRef'],
  review: ['HumanReviewRequestRef', 'HumanReviewDecisionRef'],
  integration: ['ChangeSetRef', 'IntegrationPlanRef', 'QualityGateResultRef'],
} as const;

describe('protocol registry', () => {
  const registry = createM1ProtocolRegistry();

  it('registers exactly the Schemas of SharedContracts section 3', () => {
    const expected = Object.entries(EXPECTED)
      .flatMap(([family, names]) => names.map((name) => `${family}.${name}.v0`))
      .sort();
    expect(
      registry
        .list()
        .map((entry) => entry.schemaId)
        .sort(),
    ).toEqual(expected);
  });

  it('assigns each Schema to its family and marks opaque families unsupported', () => {
    expect(registry.get('kernel.unit.SubmitUnitRequest.v0')).toMatchObject({
      family: 'kernel.unit',
      owner: 'kernel',
      status: 'SUPPORTED',
    });
    expect(registry.get('checkpoint.SessionCheckpointRef.v0').status).toBe('UNSUPPORTED');
  });

  it('rejects unknown majors, unknown names and duplicates', () => {
    expect(() => registry.resolve('kernel.unit.SubmitUnitRequest', 1)).toThrow(
      'UNKNOWN_SCHEMA_MAJOR',
    );
    expect(() => registry.get('kernel.unit.Missing.v0')).toThrow('UNKNOWN_SCHEMA_MAJOR');
    expect(registry.has('kernel.unit.Missing.v0')).toBe(false);
    const fresh = new ProtocolRegistry();
    fresh.register(ArtifactRefSchema);
    expect(() => fresh.register(ArtifactRefSchema)).toThrow('PROTOCOL_ALREADY_REGISTERED');
  });

  it('parses Schema IDs and rejects malformed ones', () => {
    expect(parseSchemaId('kernel.unit.SubmitUnitRequest.v0')).toEqual({
      schemaName: 'kernel.unit.SubmitUnitRequest',
      major: 0,
    });
    expect(() => parseSchemaId('SubmitUnitRequest')).toThrow('INVALID_SCHEMA_ID');
  });

  it('resolves a ContractRef and turns it into a plain JSON Schema', () => {
    const ref = { id: 'executor.FileReadInput', version: 'v0' };
    expect(validate(registry.resolveContract(ref), { path: 'src/a.ts' }).ok).toBe(true);
    const jsonSchema = registry.jsonSchemaOf(ref);
    expect(jsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(JSON.stringify(jsonSchema)).not.toContain('$id');
    expect(() => registry.resolveContract({ id: 'executor.Missing', version: 'v0' })).toThrow(
      'UNKNOWN_SCHEMA_MAJOR',
    );
  });
});
