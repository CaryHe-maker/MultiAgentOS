# MultiAgentOS M1 接口与跨模块协议

## 1. 规范约定

关键词“必须”“不得”“应”具有规范性。运行时实现位于 `packages/contracts/src`；其中 ContextRequest、ContextPack 与 ContextPort 尚未完成的变更以本文和 [ContextEngine.md](../Architecture/module/ContextEngine.md) 为目标，差距记录在 [M1Process.md](M1Process.md) 的 C-05。

兼容规则：

1. `schemaName + major` 唯一确定语义；未知 major 必须拒绝。
2. 同一 major 只能增加语义明确的可选字段或独立 Schema；不得删除字段、改变含义或收紧既有合法值。
3. 破坏性变更创建新 major，并提供显式转换或迁移方案。
4. 所有边界数据先经过运行时 Schema 校验；`additionalProperties` 默认为 `false`。
5. 不允许 `any`、任意 `metadata/extensions` 或空成功对象作为扩展点。

## 2. 通信规则

- 同进程同步调用：公开 Port + payload Schema + `BoundaryContext`。
- Event、Signal、异步 Command、持久化边界和跨进程调用：Envelope + Communication Fabric。
- 大对象：Artifact Store；消息只携带 `ArtifactRef`。
- Command 必须携带 `idempotencyKey`；聚合修改携带 `expectedVersion`；Query result 携带 `sourceVersion`。

## 3. 公共协议

```ts
interface BoundaryContext {
  correlationId: string;
  causationId?: string;
  tenantId: string;
  projectId: string;
  workSessionId?: string;
  workflowRunId?: string;
  deadline?: string;
}

interface Envelope<T> {
  schemaName: string;
  schemaVersion: number;
  messageType: 'command' | 'query' | 'event' | 'signal' | 'result';
  messageId: string;
  producer: string;
  occurredAt: string;
  tenantId: string;
  projectId: string;
  correlationId: string;
  causationId?: string;
  workSessionId?: string;
  workflowRunId?: string;
  missionScopeId?: string;
  aggregateId?: string;
  aggregateVersion?: number;
  graphRevision?: number;
  traceparent?: string;
  payload: T;
}

interface WorkspaceRef {
  workspaceId: string;
  rootPath: string;
  repositoryRevision: string;
  isolation: 'WORKTREE' | 'FIXTURE';
}

interface ArtifactRef {
  artifactId: string;
  mediaType: string;
  sha256: string;
  size: number;
}

type ErrorCategory =
  | 'VALIDATION' | 'CONFLICT' | 'POLICY' | 'TIMEOUT' | 'RESOURCE'
  | 'DEPENDENCY' | 'EXECUTION' | 'INTEGRITY' | 'CONTRACT' | 'INTERNAL';

interface ModuleError {
  code: string;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  correlationId: string;
  diagnosticsRef?: ArtifactRef;
  detailsRef?: ArtifactRef;
}

type PortResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ModuleError };
```

调用方只能使用 `code/category/retryable` 决策，不得解析 `message`。`retryable` 不授权自动重试。

## 4. 控制接口

`UserIntent` 是 `RUN | INSPECT | REPORT | CANCEL` 判别联合。每种变体只携带自身所需字段。

```ts
interface KernelControlPort {
  submit(intent: UserIntent, context: BoundaryContext): Promise<PortResult<RuntimeProjection>>;
}

interface WorkflowControlPort {
  create(intent: RunUserIntent, context: BoundaryContext): Promise<PortResult<WorkflowRunView>>;
  inspect(workflowRunId: string, context: BoundaryContext): Promise<PortResult<WorkflowRunView>>;
}
```

调用方向固定为 `UserInteraction -> KernelControlPort -> WorkflowControlPort`。RuntimeProjection 由 Kernel 拥有，至少包含运行状态、`sourceVersion`、`graphRevision`、当前步骤、DefinitionVersion、usage、evidence 和 failure。

## 5. Unit 接口

```ts
type ExecutionKind = 'CONTEXT' | 'MODEL' | 'FILE_READ' | 'FILE_WRITE' | 'COMMAND' | 'TEST';

interface UnitIntent {
  schemaVersion: 'v0';
  unitIntentId: string;
  owner: {
    workflowRunId: string;
    taskRunId: string;
    taskAttemptId: string;
    agentRunId: string;
    agentStepId: string;
  };
  missionScopeId: string;
  graphRevision: number;
  executionKind: ExecutionKind;
  definitionVersionRef?: VersionedRef;
  inputRef?: ArtifactRef;
  input?: unknown;
  outputContractRef: VersionedRef;
  workspace: WorkspaceRef;
  timeoutMs: number;
  idempotencyKey: string;
  deadline: string;
}

interface UnitResult {
  schemaVersion: 'v0';
  unitIntentId: string;
  unitAttemptId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
  outputRef?: ArtifactRef;
  evidenceRefs: ArtifactRef[];
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
  error?: ModuleError;
  completedAt: string;
}

interface KernelUnitPort {
  execute(intent: UnitIntent, context: BoundaryContext): Promise<UnitResult>;
}
```

允许执行 `CONTEXT | MODEL | FILE_READ`。`FILE_WRITE | COMMAND | TEST` 必须返回 `UNSUPPORTED_CAPABILITY`，且不得产生副作用。

## 6. Context 接口

```ts
interface ContextRequestBase {
  requestId: string;
  workflowRunId: string;
  missionScopeId: string;
  graphRevision: number;
  taskRunId: string;
  agentRunId: string;
  workspace: WorkspaceRef;
  tokenBudget: number;
}

type ContextRequest =
  | (ContextRequestBase & { operation: 'ORIENT'; objective: string })
  | (ContextRequestBase & {
      operation: 'SEARCH'; query: string;
      mode: 'AUTO' | 'TEXT' | 'PATH' | 'SYMBOL'; maxItems?: number;
    })
  | (ContextRequestBase & {
      operation: 'ASSEMBLE'; objective: string;
      instructionsRef: ArtifactRef; toolSchemasRef: ArtifactRef;
      orientPackRef: ArtifactRef; steps: StepRecord[]; status: StatusFacts;
    });

interface ContextPort {
  buildContext(
    request: ContextRequest,
    context: BoundaryContext,
  ): Promise<PortResult<ContextPack>>;
}
```

ContextPack 必须包含 `contextPackId`、`requestId`、`operation`、workspace、`repositoryRevision`、`snapshotId`、items、`tokenCount`、`tokenBudget`、`truncated`、`droppedCount`、provenance、`createdAt`，并在 ASSEMBLE 时包含 `prefixSha256`。每个 ContextItem 包含 `itemId`、kind、segment、role、content、`contentSha256`、`tokenCount`、reason 及可选 path/line/score。

ContextPort 失败必须保留 ContextEngine 的稳定错误码，不得统一折叠为异常字符串。

## 7. Catalog 与平台 Port

```ts
interface CatalogPort {
  resolve(query: DefinitionQuery, context: BoundaryContext): Promise<PortResult<DefinitionVersion>>;
  capabilities(): readonly CapabilityDescriptor[];
}

interface ArtifactStorePort {
  put(content: Uint8Array, mediaType: string): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
  capabilities(): readonly CapabilityDescriptor[];
}

interface RepositoryPort<T extends { readonly id: string }> {
  get(id: string): Promise<T | undefined>;
  put(record: T): Promise<void>;
}

interface MessageRouterPort {
  register<TReq, TRes>(schemaName: string, handler: (request: TReq) => Promise<TRes>): void;
  request<TReq, TRes>(schemaName: string, request: TReq): Promise<TRes>;
  capabilities(): readonly CapabilityDescriptor[];
}

interface LifecyclePort {
  manifest: { moduleId: string; version: string; dependencies: readonly string[] };
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<HealthStatus>;
}
```

DefinitionVersion 包含 versioned ref、digest、输入/输出 Contract Ref 和 capabilities；发布后不可变。

## 8. 协议注册表

| Family | Owner | M1 behavior |
|---|---|---|
| `platform.common.*` | contracts | 完整校验 |
| `interaction.*` | user-interaction | UserIntent |
| `workflow.*` | workflow | TaskGraph、WorkflowRunView |
| `kernel.control.*` | kernel | RuntimeProjection |
| `kernel.unit.*` | kernel | UnitIntent、UnitResult |
| `context.*` | context-engine | ContextRequest、ContextPack |
| `catalog.*` | agent-tool-pool | DefinitionQuery、DefinitionVersion |
| `platform.lifecycle.*` | module-host | 生命周期 |
| `platform.persistence.*` | persistence | 文件 Repository；其他能力 Unsupported |
| `platform.communication.*` | communication | 同进程 Router；可靠投递 Unsupported |
| `platform.artifact.*` | artifacts | 本地内容寻址存储 |
| `checkpoint.*`, `restore.*`, `review.*`, `integration.*` | 对应 owner | 仅 opaque Ref、capability 和 Unsupported |

Registry 必须拒绝重复 `schemaName@major` 和未知 major。未支持协议只定义 owner、opaque Ref 与明确错误，不冻结未经使用验证的 payload。

## 9. 身份、不可变性与测试

身份链为：

```text
WorkSession -> PromptRevision -> SessionTreeNode -> WorkflowRun
-> GraphRevision(0) -> MissionScope -> TaskRun -> TaskAttempt
-> AgentRun -> AgentStep -> UnitIntent -> UnitAttempt -> ArtifactRef
```

ContextPack、UnitIntent、UnitResult、DefinitionVersion 和 ArtifactRef 发布后不可修改。每个 Port 必须提供共享 contract tests，至少覆盖合法值、额外字段、错误映射、未知 major、不可变输出、Unsupported 无副作用和 fake/real adapter 一致性。
