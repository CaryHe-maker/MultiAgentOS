import type {
  ArtifactRef,
  BoundaryContext,
  CapabilityDescriptor,
  ContextPack,
  ContextRequest,
  DefinitionQuery,
  DefinitionVersion,
  ModuleError,
  RuntimeProjection,
  UnitIntent,
  UnitResult,
  UserIntent,
} from './schemas.js';
export type PortResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ModuleError };
export interface KernelUnitPort {
  execute(intent: UnitIntent, context: BoundaryContext): Promise<UnitResult>;
}
export interface KernelControlPort {
  submit(intent: UserIntent, context: BoundaryContext): Promise<PortResult<RuntimeProjection>>;
}
export interface ContextPort {
  buildContext(request: ContextRequest, context: BoundaryContext): Promise<ContextPack>;
}
export interface CatalogPort {
  resolve(query: DefinitionQuery, context: BoundaryContext): Promise<PortResult<DefinitionVersion>>;
  capabilities(): readonly CapabilityDescriptor[];
}
export interface ArtifactStorePort {
  put(content: Uint8Array, mediaType: string): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
  capabilities(): readonly CapabilityDescriptor[];
}
export interface RepositoryPort<T extends { readonly id: string }> {
  get(id: string): Promise<T | undefined>;
  put(record: T): Promise<void>;
}
export type MessageHandler<TRequest, TResponse> = (request: TRequest) => Promise<TResponse>;
export interface MessageRouterPort {
  register<TRequest, TResponse>(
    schemaName: string,
    handler: MessageHandler<TRequest, TResponse>,
  ): void;
  request<TRequest, TResponse>(schemaName: string, request: TRequest): Promise<TResponse>;
  capabilities(): readonly CapabilityDescriptor[];
}
export interface HealthStatus {
  readonly status: 'UP' | 'DOWN' | 'DEGRADED';
  readonly checkedAt: string;
  readonly details: readonly string[];
}
export interface LifecyclePort {
  readonly manifest: {
    readonly moduleId: string;
    readonly version: string;
    readonly dependencies: readonly string[];
  };
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<HealthStatus>;
}
