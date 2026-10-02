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

/** A function the model may call natively; parameters is a JSON Schema object. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface AgentDefinition {
  readonly ref: DefinitionRef;
  readonly name: string;
  readonly description: string;
  readonly acceptedTaskTypes: readonly string[];
  readonly promptRef: DefinitionRef;
  readonly allowedUnitRefs: readonly DefinitionRef[];
  readonly allowedHandoffRefs: readonly DefinitionRef[];
  readonly tools: readonly ToolDefinition[];
  /** Tool that ends the Agent's work; forced on the last allowed model call. */
  readonly finishToolName?: string;
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
  /** Workflow resolves the id against the Planner's allowedHandoffRefs. */
  readonly targetAgentId: string;
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
  /** Set when the answer came from a finish tool call; absent for a plain-text reply. */
  readonly callId?: string;
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

/** The result of one tool call as the model will see it; errors are returned, not thrown. */
export interface ToolObservation {
  readonly callId: string;
  readonly toolName: string;
  readonly result: Result<FileReadResponse>;
}

/** Fixed per-Agent limits, stated once so the context prefix never changes between calls. */
export interface ContextLimits {
  readonly maxModelCalls: number;
  readonly maxFileReads: number;
}

/** A native tool call exactly as the model emitted it. */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** One assistant reply, kept so later calls can replay the conversation. */
export interface AssistantTurn {
  readonly content: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  /** Workflow feedback for a turn without tool calls, replayed as a user message. */
  readonly notice?: string;
}

export type ChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls: readonly ModelToolCall[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export interface ContextRequest {
  readonly agentRef: DefinitionRef;
  readonly promptRef: DefinitionRef;
  readonly objective: string;
  readonly repository?: RepositoryRef;
  readonly routingCatalog: readonly AgentRoutingDescriptor[];
  readonly handoff?: HandoffAction;
  readonly repositoryOverview?: RepositoryOverview;
  readonly turns: readonly AssistantTurn[];
  readonly observations: readonly ToolObservation[];
  readonly limits: ContextLimits;
  /** True when this context is for the Agent's last allowed model call. */
  readonly finalCall: boolean;
  /** Counters for the optional per-call status bar (experiment C7). */
  readonly usage?: ContextUsage;
}

export interface ContextUsage {
  readonly modelCallsUsed: number;
  readonly fileReadsUsed: number;
}

export interface ContextPack {
  readonly agentRef: DefinitionRef;
  readonly promptRef: DefinitionRef;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  /** Name of a tool the model must call, or undefined to let the model choose. */
  readonly toolChoice?: string;
}

export interface ModelRequest {
  readonly context: ContextPack;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
}

export interface ModelResponse {
  /** One entry per native tool call, or a single FINAL for a plain-text reply. */
  readonly actions: readonly AgentAction[];
  readonly turn: AssistantTurn;
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
  readonly turns: readonly AssistantTurn[];
}

export type UnitRunStatus = 'WAITING_EXECUTION' | 'EVALUATING_RESULT' | 'SUCCEEDED' | 'FAILED';

export interface UnitRunState {
  readonly unitRunId: string;
  readonly unitIntentId: string;
  readonly agentRunId: string;
  readonly unitRef: DefinitionRef;
  readonly status: UnitRunStatus;
  readonly attemptCount: number;
  /** Model tool call this Unit serves, so a failed read can be reported back to it. */
  readonly toolCallId?: string;
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
  /** File reads requested in one model turn that still wait for execution. */
  readonly queuedToolCalls: readonly ToolCallAction[];
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
