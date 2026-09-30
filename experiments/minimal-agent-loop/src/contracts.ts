export interface ExperimentError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExperimentError };

export interface DefinitionRef {
  readonly id: string;
  readonly version: string;
}

export interface RepositoryRef {
  readonly rootPath: string;
  readonly revision: string;
}

export interface UserRequest {
  readonly prompt: string;
  readonly repository?: RepositoryRef;
}

export interface UserResponse {
  readonly answer: string;
}

export type UnitKind =
  'CONTEXT_BUILD' | 'MODEL_CALL' | 'REPOSITORY_VIEW' | 'FILE_READ' | 'RETURN_RESULT';

export interface UnitDefinition {
  readonly ref: DefinitionRef;
  readonly name: string;
  readonly kind: UnitKind;
  readonly description: string;
}

export interface PromptTemplate {
  readonly ref: DefinitionRef;
  readonly template: string;
}

export interface AgentDefinition {
  readonly ref: DefinitionRef;
  readonly name: string;
  readonly description: string;
  readonly acceptedTaskTypes: readonly string[];
  readonly promptRef: DefinitionRef;
  readonly allowedUnitRefs: readonly DefinitionRef[];
  readonly allowedHandoffRefs: readonly DefinitionRef[];
}

export interface AgentRoutingDescriptor {
  readonly ref: DefinitionRef;
  readonly name: string;
  readonly description: string;
  readonly acceptedTaskTypes: readonly string[];
}

export interface ReviewTask {
  readonly taskType: 'CODE_REVIEW';
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

export interface HandoffAction {
  readonly kind: 'HANDOFF';
  readonly targetAgentRef: DefinitionRef;
  readonly task: ReviewTask;
}

export interface SourceCitation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface FinalAction {
  readonly kind: 'FINAL';
  readonly answer: string;
  readonly citations?: readonly SourceCitation[];
}

export interface FileReadInput {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface ToolCallAction {
  readonly kind: 'TOOL_CALL';
  readonly callId: string;
  readonly toolName: 'file_read';
  readonly input: FileReadInput;
}

export type AgentAction = HandoffAction | FinalAction | ToolCallAction;

export interface FileReadRequest {
  readonly repository: RepositoryRef;
  readonly input: FileReadInput;
}

export interface FileReadResponse {
  readonly path: string;
  readonly revision: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly content: string;
  readonly truncated: boolean;
}

export interface RepositoryFileSummary {
  readonly path: string;
  readonly sizeBytes: number;
  readonly totalLines: number;
}

export interface RepositoryOverview {
  readonly revision: string;
  readonly files: readonly RepositoryFileSummary[];
  readonly truncated: boolean;
}

export interface RepositoryViewRequest {
  readonly repository: RepositoryRef;
  readonly maxDepth: number;
  readonly includeExtensions: readonly string[];
}

export interface ToolObservation {
  readonly callId: string;
  readonly toolName: 'file_read';
  readonly input: FileReadInput;
  readonly output: FileReadResponse;
}

export interface ContextStatus {
  readonly modelCallsRemaining: number;
  readonly fileReadsRemaining: number;
}

export interface ContextRequest {
  readonly agentRef: DefinitionRef;
  readonly promptRef: DefinitionRef;
  readonly objective: string;
  readonly repository?: RepositoryRef;
  readonly routingCatalog: readonly AgentRoutingDescriptor[];
  readonly handoff?: HandoffAction;
  readonly repositoryOverview?: RepositoryOverview;
  readonly observations: readonly ToolObservation[];
  readonly status: ContextStatus;
}

export interface ContextPack {
  readonly agentRef: DefinitionRef;
  readonly promptRef: DefinitionRef;
  readonly instructions: string;
  readonly input: string;
}

export interface ModelRequest {
  readonly context: ContextPack;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelResponse {
  readonly action: AgentAction;
  readonly usage: ModelUsage;
}

export interface ContextBuildUnitInput {
  readonly kind: 'CONTEXT_BUILD';
  readonly request: ContextRequest;
}

export interface ModelCallUnitInput {
  readonly kind: 'MODEL_CALL';
  readonly request: ModelRequest;
}

export interface RepositoryViewUnitInput {
  readonly kind: 'REPOSITORY_VIEW';
  readonly request: RepositoryViewRequest;
}

export interface FileReadUnitInput {
  readonly kind: 'FILE_READ';
  readonly request: FileReadRequest;
  readonly callId: string;
}

export interface ReturnResultUnitInput {
  readonly kind: 'RETURN_RESULT';
  readonly response: UserResponse;
}

export type UnitInput =
  | ContextBuildUnitInput
  | ModelCallUnitInput
  | RepositoryViewUnitInput
  | FileReadUnitInput
  | ReturnResultUnitInput;

export interface UnitIntent {
  readonly unitIntentId: string;
  readonly workflowRunId: string;
  readonly agentRunId: string;
  readonly agentRef: DefinitionRef;
  readonly unitRef: DefinitionRef;
  readonly stepNumber: number;
  readonly input: UnitInput;
}

export type UnitOutput =
  | { readonly kind: 'CONTEXT_BUILD'; readonly context: ContextPack }
  | { readonly kind: 'MODEL_CALL'; readonly response: ModelResponse }
  | { readonly kind: 'REPOSITORY_VIEW'; readonly overview: RepositoryOverview }
  | { readonly kind: 'FILE_READ'; readonly observation: ToolObservation }
  | { readonly kind: 'RETURN_RESULT'; readonly response: UserResponse };

export interface UnitCompletion {
  readonly unitIntentId: string;
  readonly unitAttemptId: string;
  readonly attemptNumber: number;
  readonly agentRunId: string;
  readonly unitRef: DefinitionRef;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'REJECTED';
  readonly output?: UnitOutput;
  readonly error?: ExperimentError;
}

export type AgentRunStatus =
  | 'WAITING_ACTIVATION'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_UNIT'
  | 'APPLYING_RESULT'
  | 'RESULT_SUBMITTED'
  | 'FAILED';

export interface AgentRunState {
  readonly agentRunId: string;
  readonly agentRef: DefinitionRef;
  readonly status: AgentRunStatus;
  readonly modelCallCount: number;
  readonly fileReadCount: number;
}

export type UnitRunStatus = 'WAITING_EXECUTION' | 'EVALUATING_RESULT' | 'SUCCEEDED' | 'FAILED';

export interface UnitRunState {
  readonly unitRunId: string;
  readonly unitIntentId: string;
  readonly agentRunId: string;
  readonly unitRef: DefinitionRef;
  readonly status: UnitRunStatus;
  readonly attemptCount: number;
  readonly currentAttemptId?: string;
}

export type WorkflowPhase = 'ROUTING' | 'REVIEWING' | 'FINALIZING' | 'COMPLETED';

export interface WorkflowState {
  readonly workflowRunId: string;
  readonly objective: string;
  readonly repository?: RepositoryRef;
  readonly phase: WorkflowPhase;
  readonly activeAgentRunId: string;
  readonly agentRuns: Readonly<Record<string, AgentRunState>>;
  readonly unitRuns: Readonly<Record<string, UnitRunState>>;
  readonly pendingUnitRunId?: string;
  readonly nextStepNumber: number;
  readonly handoff?: HandoffAction;
  readonly repositoryOverview?: RepositoryOverview;
  readonly observations: readonly ToolObservation[];
}

export interface WorkflowStartRequest {
  readonly workflowRunId: string;
  readonly objective: string;
  readonly repository?: RepositoryRef;
}

export type WorkflowDecision =
  | {
      readonly kind: 'EXECUTE_UNIT';
      readonly state: WorkflowState;
      readonly intent: UnitIntent;
    }
  | {
      readonly kind: 'COMPLETE';
      readonly state: WorkflowState;
      readonly response: UserResponse;
    }
  | {
      readonly kind: 'FAILED';
      readonly state: WorkflowState;
      readonly error: ExperimentError;
    };

export type UnitAttemptStatus =
  'CREATED' | 'ADMISSION_CHECKING' | 'ADMITTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'REJECTED';

export interface UnitAttempt {
  readonly unitAttemptId: string;
  readonly unitIntentId: string;
  readonly attemptNumber: number;
  readonly status: UnitAttemptStatus;
  readonly history: readonly UnitAttemptStatus[];
}

export interface WorkflowPort {
  start(request: WorkflowStartRequest): Promise<Result<WorkflowDecision>>;
  resume(state: WorkflowState, completion: UnitCompletion): Promise<Result<WorkflowDecision>>;
}

export interface ContextReader {
  build(request: ContextRequest): Promise<Result<ContextPack>>;
}

export interface AgentDefinitionReader {
  getAgent(ref: DefinitionRef): Promise<Result<AgentDefinition>>;
  listRoutingAgents(): Promise<Result<readonly AgentRoutingDescriptor[]>>;
}

export interface UnitDefinitionReader {
  getUnit(ref: DefinitionRef): Promise<Result<UnitDefinition>>;
}

export interface PromptTemplateReader {
  getPrompt(ref: DefinitionRef): Promise<Result<PromptTemplate>>;
}

export type AgentToolPoolPort = AgentDefinitionReader & UnitDefinitionReader & PromptTemplateReader;

export interface ModelExecutorPort {
  execute(request: ModelRequest): Promise<Result<ModelResponse>>;
}

export interface FileReadExecutorPort {
  read(request: FileReadRequest): Promise<Result<FileReadResponse>>;
  view(request: RepositoryViewRequest): Promise<Result<RepositoryOverview>>;
}

export interface KernelPort {
  run(request: UserRequest): Promise<Result<UserResponse>>;
  getUnitAttempt(unitAttemptId: string): UnitAttempt | undefined;
}
