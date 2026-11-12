import { describe, expect, it } from 'vitest';
import { ArtifactRefSchema } from './platform-common/common-schemas.js';
import { validate } from './platform-common/validation.js';
import { ProtocolRegistry, createProtocolRegistry, parseSchemaId } from './protocol-registry.js';

/** Schema IDs of Library/SharedContracts 3, without the `.v1` suffix. */
const EXPECTED = {
  'platform.common': [
    'ArtifactRef',
    'BoundaryContext',
    'CapabilityDescriptor',
    'Envelope',
    'ErrorCategory',
    'ExecutionKind',
    'ModuleError',
    'ReasonCode',
    'VersionedRef',
  ],
  'kernel.unit': [
    'UpdateActivityRequest',
    'WorkspaceDiverged',
    'RunInterrupted',
    'RunPaused',
    'RunResumed',
    'HumanCancelled',
    'BudgetState',
    'BudgetView',
    'CloseRunRequest',
    'EndAgentRunRequest',
    'HumanAnswered',
    'MessagePublishInput',
    'MessagePublishOutput',
    'ProjectFileContent',
    'ReadProjectFileRequest',
    'RegisterAgentRunRequest',
    'ReserveDelegationRequest',
    'ReleaseDelegationRequest',
    'RetainArtifactsRequest',
    'ScheduleWakeRequest',
    'WakeDue',
    'ControlJobRequest',
    'HaltAgentRunRequest',
    'TakeCheckpointRequest',
    'CheckpointTaken',
    'JobControlContent',
    'JobEnded',
    'ReportCompactionSourceRequest',
    'AckCompactionRequest',
    'CompactionSourceQuery',
    'ToolResultsPruned',
    'ContextCompacted',
    'DelegationReserved',
    'ReportPublishInput',
    'ReportPublishOutput',
    'ReportSessionCommandRequest',
    'ReportSessionListRequest',
    'RequestHumanRequest',
    'RunClosed',
    'RunStart',
    'SubmitUnitRequest',
    'TurnClosed',
    'TurnUsage',
    'UnitInput',
    'UnitOutput',
    'UnitReport',
    'WorkflowInboxEvent',
  ],
  executor: [
    'FileEditArgs',
    'FileEditInput',
    'FileWriteArgs',
    'FileWriteInput',
    'FileWriteOutput',
    'CommandInput',
    'RunCommandArgs',
    'CommandOutput',
    'GitInspectArgs',
    'GitInspectInput',
    'GitInspectOutput',
    'OutputReadArgs',
    'OutputReadInput',
    'WebSearchInput',
    'WebSearchOutput',
    'WebFetchInput',
    'WebFetchOutput',
    'OutputReadOutput',
    'FileReadInput',
    'FileReadOutput',
    'ModelCallInput',
    'ModelCallOutput',
    'ModelRawOutput',
    'ModelToolCall',
    'RepositoryListInput',
    'RepositoryListOutput',
    'RetentionNotice',
    'TokenUsage',
  ],
  context: [
    'CompactionSummaryInput',
    'CompactionTarget',
    'CompactionUsage',
    'MeasuredUsage',
    'PrunedItem',
    'ContextAssembleInput',
    'ContextAssembleOutput',
    'ContextHistoryEntry',
    'ContextPack',
    'ModelToolSpec',
    'RepositoryOrientInput',
    'RepositoryOrientOutput',
    'RepositorySearchInput',
    'RepositorySearchOutput',
  ],
  workflow: [
    'UpdateTodosArgs',
    'AnalysisReport',
    'AnalysisReportDraft',
    'HandoffBrief',
    'ReplyArgs',
    'RunSubagentsArgs',
    'AskUserArgs',
    'SleepArgs',
    'SendMessageArgs',
    'ViewTasksArgs',
    'StopSubagentsArgs',
    'JobOutputArgs',
    'JobListArgs',
    'JobKillArgs',
    'ExplorerResult',
    'WorkerResult',
  ],
  catalog: [
    'AgentDefinition',
    'AgentPinRequest',
    'ContractRef',
    'DefinitionKind',
    'DefinitionLookup',
    'DefinitionRef',
    'DefinitionStatus',
    'DefinitionStatusFile',
    'ModelDefinition',
    'PinnedDefinitionRef',
    'PinnedDefinitionSet',
    'PromptDefinition',
    'TemplateDefinition',
    'ToolDefinition',
    'UnitDefinition',
  ],
  'kernel.control': [
    'ConfirmUndoRequest',
    'DiffTurnsRequest',
    'TurnDiff',
    'UndoCancelled',
    'UndoConfirmationRequested',
    'UndoTurnsRequest',
    'WorkspaceReverted',
    'ActivityEvent',
    'AdmissionProjection',
    'AnswerAuthorizationRequest',
    'AnswerHumanRequest',
    'PauseRunRequest',
    'ResumeRunRequest',
    'InterruptRunRequest',
    'SteerRunRequest',
    'CompactContextRequest',
    'CompactionFailed',
    'ExternalReadPaused',
    'ContextCompacted',
    'ArtifactContent',
    'AuthorizationRequest',
    'AuthorizationResolved',
    'CloseReason',
    'DeleteSessionRequest',
    'GatewayForward',
    'HumanRequest',
    'HumanResolved',
    'InteractionInboxEvent',
    'ListSessionsRequest',
    'MessagePublished',
    'ModelStream',
    'OpenSessionRequest',
    'ReadArtifactRequest',
    'RunFailure',
    'RunFinished',
    'RunStateChanged',
    'RunSummary',
    'SessionAccepted',
    'SessionProjection',
    'ShutdownRequest',
    'StartRunRequest',
    'ListCheckpointsRequest',
    'CheckpointList',
    'StartSessionRequest',
    'SyscallAck',
    'SyscallRejected',
    'UnknownEffect',
  ],
  'kernel.execution': [
    'CommandExecutorInput',
    'PruneExecutorInput',
    'OutputReadExecutorInput',
    'AssembleExecutorInput',
    'CancelExecutionRequest',
    'CancelRunExecutionsRequest',
    'ExecutionFact',
    'ExecutionLimits',
    'ExecutionRequest',
    'ExecutionResult',
    'ExecutionScope',
    'ModelExecutorInput',
    'ModelProgress',
    'OrientExecutorInput',
    'SearchExecutorInput',
    'SupervisorShutdownRequest',
    'JobControlRequest',
    'JobControlResult',
    'JobEndedFact',
  ],
  'platform.config': ['KernelConfig', 'SystemConfig', 'WorkflowConfig'],
  checkpoint: ['SessionCheckpointRef', 'WorkflowCheckpointRef'],
  restore: ['RestoreOperationRef'],
  review: ['HumanReviewDecisionRef', 'HumanReviewRequestRef'],
  integration: ['ChangeSetRef', 'IntegrationPlanRef', 'QualityGateResultRef'],
  'platform.fabric': ['ConsumerOffsetRef'],
  'platform.persistence': [
    'SnapshotIndexLine',
    'ArtifactOwnerLine',
    'InstanceLockInfo',
    'JournalPositionRef',
    'SessionIndexLine',
    'SessionLockInfo',
    'SessionLogRecord',
    'SessionRefLine',
    'TrustedInstructionLine',
    'TrustedWebSearchLine',
  ],
  'platform.artifact': ['RetentionTokenRef'],
  'kernel.session': [
    'InteractionSessionEvent',
    'InteractionSystemEvent',
    'WorkflowSessionEvent',
    'WorkflowSystemEvent',
  ],
} as const;

describe('protocol registry', () => {
  const registry = createProtocolRegistry();

  it('registers exactly the Schemas of SharedContracts section 3', () => {
    const expected = Object.entries(EXPECTED)
      .flatMap(([family, names]) => names.map((name) => `${family}.${name}.v1`))
      .sort();
    expect(
      registry
        .list()
        .map((entry) => entry.schemaId)
        .sort(),
    ).toEqual(expected);
  });

  it('assigns each Schema to its family and marks opaque families unsupported', () => {
    expect(registry.get('kernel.unit.SubmitUnitRequest.v1')).toMatchObject({
      family: 'kernel.unit',
      owner: 'kernel',
      status: 'SUPPORTED',
    });
    expect(registry.get('checkpoint.SessionCheckpointRef.v1').status).toBe('UNSUPPORTED');
  });

  it('rejects unknown majors, unknown names and duplicates', () => {
    expect(() => registry.resolve('kernel.unit.SubmitUnitRequest', 2)).toThrow(
      'UNKNOWN_SCHEMA_MAJOR',
    );
    expect(() => registry.get('kernel.unit.Missing.v1')).toThrow('UNKNOWN_SCHEMA_MAJOR');
    expect(registry.has('kernel.unit.Missing.v1')).toBe(false);
    const fresh = new ProtocolRegistry();
    fresh.register(ArtifactRefSchema);
    expect(() => fresh.register(ArtifactRefSchema)).toThrow('PROTOCOL_ALREADY_REGISTERED');
  });

  it('parses Schema IDs and rejects malformed ones', () => {
    expect(parseSchemaId('kernel.unit.SubmitUnitRequest.v1')).toEqual({
      schemaName: 'kernel.unit.SubmitUnitRequest',
      major: 1,
    });
    expect(() => parseSchemaId('SubmitUnitRequest')).toThrow('INVALID_SCHEMA_ID');
  });

  it('resolves a ContractRef and turns it into a plain JSON Schema', () => {
    const ref = { id: 'executor.FileReadInput', version: 'v1' };
    expect(validate(registry.resolveContract(ref), { path: 'src/a.ts' }).ok).toBe(true);
    const jsonSchema = registry.jsonSchemaOf(ref);
    expect(jsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(JSON.stringify(jsonSchema)).not.toContain('$id');
    expect(() => registry.resolveContract({ id: 'executor.Missing', version: 'v1' })).toThrow(
      'UNKNOWN_SCHEMA_MAJOR',
    );
  });
});
