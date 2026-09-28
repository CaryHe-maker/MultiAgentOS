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

export interface UserRequest {
  readonly prompt: string;
}

export interface UserResponse {
  readonly answer: string;
}

export interface WorkflowRequest {
  readonly objective: string;
  readonly agentRef: DefinitionRef;
}

export interface WorkflowOutput {
  readonly answer: string;
  readonly stepCount: number;
}

export type ToolName = 'web_search';

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
  readonly promptRef: DefinitionRef;
  readonly toolRefs: readonly DefinitionRef[];
}

export interface WebSearchRequest {
  readonly query: string;
  readonly maxResults: number;
}

export interface WebSearchItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebSearchResponse {
  readonly items: readonly WebSearchItem[];
}

export interface ToolObservation {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly input: WebSearchRequest;
  readonly output: WebSearchResponse;
}

export interface ContextRequest {
  readonly objective: string;
  readonly promptRef: DefinitionRef;
  readonly observations: readonly ToolObservation[];
}

export interface ContextPack {
  readonly promptRef: DefinitionRef;
  readonly instructions: string;
  readonly objective: string;
  readonly observations: readonly ToolObservation[];
}

export interface FinalAction {
  readonly kind: 'FINAL';
  readonly answer: string;
}

export interface ToolCallAction {
  readonly kind: 'TOOL_CALL';
  readonly callId: string;
  readonly toolName: 'web_search';
  readonly input: WebSearchRequest;
}

export type AgentAction = FinalAction | ToolCallAction;

export interface ApiCallRequest {
  readonly context: ContextPack;
  readonly tools: readonly ToolDefinition[];
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ApiCallResponse {
  readonly action: AgentAction;
  readonly usage: ModelUsage;
}

export type ModuleRequest =
  | { readonly target: 'WORKFLOW'; readonly input: WorkflowRequest }
  | { readonly target: 'API_CALL_EXECUTOR'; readonly input: ApiCallRequest }
  | { readonly target: 'WEB_SEARCH_EXECUTOR'; readonly input: WebSearchRequest };

export type ModuleResponse =
  | { readonly source: 'WORKFLOW'; readonly output: WorkflowOutput }
  | { readonly source: 'API_CALL_EXECUTOR'; readonly output: ApiCallResponse }
  | { readonly source: 'WEB_SEARCH_EXECUTOR'; readonly output: WebSearchResponse };

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
  getTools(refs: readonly DefinitionRef[]): Promise<Result<readonly ToolDefinition[]>>;
}

export interface PromptTemplateReader {
  getPrompt(ref: DefinitionRef): Promise<Result<PromptTemplate>>;
}

export type AgentToolPoolPort = AgentDefinitionReader & PromptTemplateReader;

export interface ApiCallExecutorPort {
  execute(request: ApiCallRequest): Promise<Result<ApiCallResponse>>;
}

export interface WebSearchExecutorPort {
  execute(request: WebSearchRequest): Promise<Result<WebSearchResponse>>;
}

export class NotImplementedError extends Error {
  public constructor(component: string, operation: string) {
    super(`${component}.${operation} is not implemented`);
    this.name = 'NotImplementedError';
  }
}
