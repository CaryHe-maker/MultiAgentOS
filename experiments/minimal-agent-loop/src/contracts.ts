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
}

export interface UserResponse {
  readonly answer: string;
}

export interface WorkflowRequest {
  readonly objective: string;
  readonly completedUnits: readonly UnitCompletion[];
}

export interface WorkflowOutput {
  readonly agentRef: DefinitionRef;
  readonly nextUnit: UnitIntent;
  readonly stepNumber: number;
}

export type ToolName = 'file_read';

export interface ToolDefinition {
  readonly ref: DefinitionRef;
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface PromptTemplate {
  readonly ref: DefinitionRef;
  readonly template: string;
}

export interface AgentDefinition {
  readonly ref: DefinitionRef;
  readonly name: string;
  readonly promptPolicy: 'PASSTHROUGH';
  readonly unitRefs: readonly DefinitionRef[];
}

export type UnitKind = 'MODEL_EXECUTOR' | 'RETURN_RESULT';

export interface UnitDefinition {
  readonly ref: DefinitionRef;
  readonly name: string;
  readonly kind: UnitKind;
  readonly description: string;
}

export interface FileReadInput {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

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

export interface ToolObservation {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly input: FileReadInput;
  readonly output: FileReadResponse;
}

export interface ContextRequest {
  readonly objective: string;
  readonly promptRef: DefinitionRef;
  readonly repository: RepositoryRef;
  readonly observations: readonly ToolObservation[];
}

export interface ContextPack {
  readonly promptRef: DefinitionRef;
  readonly instructions: string;
  readonly objective: string;
  readonly repository: RepositoryRef;
  readonly observations: readonly ToolObservation[];
}

export interface FinalAction {
  readonly kind: 'FINAL';
  readonly answer: string;
}

export interface ToolCallAction {
  readonly kind: 'TOOL_CALL';
  readonly callId: string;
  readonly toolName: 'file_read';
  readonly input: FileReadInput;
}

export type AgentAction = FinalAction | ToolCallAction;

export interface ModelRequest {
  readonly prompt: string;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelResponse {
  readonly answer: string;
  readonly usage: ModelUsage;
}

export type UnitInput = ModelRequest | UserResponse;

export interface UnitIntent {
  readonly unitRef: DefinitionRef;
  readonly input: UnitInput;
}

export interface UnitCompletion {
  readonly unitRef: DefinitionRef;
  readonly output: ModelResponse;
}

export type ModuleRequest =
  | { readonly target: 'WORKFLOW'; readonly input: WorkflowRequest }
  | { readonly target: 'FILE_READ_EXECUTOR'; readonly input: FileReadRequest };

export type ModuleResponse =
  | { readonly source: 'WORKFLOW'; readonly output: WorkflowOutput }
  | { readonly source: 'FILE_READ_EXECUTOR'; readonly output: FileReadResponse };

export interface KernelChannel {
  dispatch(request: ModuleRequest): Promise<Result<ModuleResponse>>;
}

export interface KernelPort extends KernelChannel {
  run(request: UserRequest): Promise<Result<UserResponse>>;
}

export interface WorkflowPort {
  run(request: WorkflowRequest): Promise<Result<WorkflowOutput>>;
}

export interface ContextReader {
  build(request: ContextRequest): Promise<Result<ContextPack>>;
}

export interface AgentDefinitionReader {
  getAgent(ref: DefinitionRef): Promise<Result<AgentDefinition>>;
}

export interface UnitDefinitionReader {
  getUnit(ref: DefinitionRef): Promise<Result<UnitDefinition>>;
}

export interface ToolDefinitionReader {
  getTools(refs: readonly DefinitionRef[]): Promise<Result<readonly ToolDefinition[]>>;
}

export interface PromptTemplateReader {
  getPrompt(ref: DefinitionRef): Promise<Result<PromptTemplate>>;
}

export type AgentToolPoolPort = AgentDefinitionReader &
  UnitDefinitionReader &
  ToolDefinitionReader &
  PromptTemplateReader;

export interface ModelExecutorPort {
  execute(request: ModelRequest): Promise<Result<ModelResponse>>;
}

export interface FileReadExecutorPort {
  execute(request: FileReadRequest): Promise<Result<FileReadResponse>>;
}

export class NotImplementedError extends Error {
  public constructor(component: string, operation: string) {
    super(`${component}.${operation} is not implemented`);
    this.name = 'NotImplementedError';
  }
}
