# MultiAgentOS M1 接口与跨模块协议

> 本文定义 M1 的目标接口。`packages/contracts` 中现有代码仍为 v0 协议（`UnitIntent`、`UnitResult`、
> `KernelUnitPort`、`ContextPort`、`KernelControlPort` 等），迁移差距由 GitHub Issues 跟踪；文档更新不表示代码已迁移。

## 1. 规范约定

关键词“必须”“不得”“应”具有规范性。运行时实现位于 `packages/contracts/src`；尚未完成的变更以本文为目标。

兼容规则：

1. `schemaName + major` 唯一确定语义；未知 major 必须拒绝。
2. 同一 major 只能增加语义明确的可选字段或独立 Schema；不得删除字段、改变含义或收紧既有合法值。
3. 破坏性变更创建新 major，并提供显式转换或迁移方案。
4. 所有边界数据先经过运行时 Schema 校验；`additionalProperties` 默认为 `false`。
5. 不允许 `any`、任意 `metadata/extensions` 或空成功对象作为扩展点。

## 2. 通信规则

- 跨通讯主体的交互都经 MessageRouter，payload 在主体边界按 Schema 校验，并携带 `BoundaryContext`：
  - 请求-响应：外部 syscall、UserInteraction 请求与跨主体的 Kernel 内部请求；
  - 单向事件：Core 的 Outbox 向 Workflow、UserInteraction 的 Inbox 投递 `InboxEvent`。
- Kernel 核心（Core、Monitor、Scheduler、Execution）内部直接函数调用，不经 MessageRouter；组件之间只经职责接口与内部 syscall 交互。
- Kernel 核心与 Supervisor 之间经第 7 节的接口交换可序列化消息。
- 大对象：Artifact Store；消息只携带 `ArtifactRef`。
- 改变状态的请求必须携带 `requestId` 并按其幂等；事件按 `messageId` 去重、按 `seq` 排序。

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

interface VersionedRef {                            // 固定定义的引用
  kind: 'AGENT' | 'UNIT' | 'TOOL' | 'MODEL' | 'PROMPT';
  id: string;
  version: string;                                  // v<major>.<minor>.<patch>
  digest: string;
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

## 4. UserInteraction 请求与 Inbox 事件

```ts
interface InboxEvent<T> extends Envelope<T> {      // messageType 为 'event'；messageId 用于去重
  workflowRunId: string;
  seq: number;                                      // 每个 WorkflowRun、每个接收方从 1 递增
}

interface InteractionRequests {                     // UserInteraction 经 Gateway 发起
  createRun(req: { goal: string; repositoryPath: string; requestId: string }): Promise<RunCreated | AdmissionException>;
  answerAuthorization(req: { workflowRunId: string; questionId: string; answer: 'YES' | 'NO'; requestId: string }): Promise<SyscallAck | AdmissionException>;
  cancelRun(req: { workflowRunId: string; requestId: string }): Promise<SyscallAck | AdmissionException>;
  readArtifact(req: { workflowRunId: string; ref: ArtifactRef; requestId: string }): Promise<ArtifactContent | SyscallRejected | AdmissionException>;
  shutdown(req: { requestId: string }): Promise<SyscallAck | AdmissionException>;
}

type KernelToInteractionEvent =
  | { type: 'AuthorizationRequest'; questionId: string; repositoryPath: string;
      exclusions: readonly string[]; provider: string; expiresAt: string }
  | { type: 'RunFinished'; closeReason: RunClosed['closeReason'];
      reportRef?: ArtifactRef; unknownEffects: readonly string[] };

interface InteractionInboxPort {
  deliver(event: InboxEvent<KernelToInteractionEvent>): Promise<void>;
}
```

Inbox 接口由 UserInteraction、Workflow 实现，由 `apps/control-plane` 注入 Kernel；投递语义见
[Kernel（外部视角）](module/Kernel.md) 4.5。`readArtifact` 对不属于该运行或不存在的引用统一返回
`SyscallRejected(OUT_OF_SCOPE)`。

## 5. Unit 接口

### 5.1 目标接口

Workflow 经 Gateway 发起 4 种 syscall，Kernel 以返回值或 Inbox 事件回应，语义见 [Kernel（外部视角）](module/Kernel.md) 第 4 节。

```ts
type ExecutionKind =
  | 'REPOSITORY_ORIENT' | 'REPOSITORY_SEARCH' | 'FILE_READ'
  | 'CONTEXT_ASSEMBLE' | 'MODEL' | 'REPORT_PUBLISH'
  | 'FILE_WRITE' | 'COMMAND' | 'TEST';            // 后三者在 M1 返回 UNSUPPORTED_CAPABILITY

type BudgetState = 'NORMAL' | 'WRAP_UP' | 'EXHAUSTED';

interface WorkflowSyscalls {
  registerAgentRun(req: { workflowRunId: string; agentRunId: string; agentRef: VersionedRef; requestId: string }): Promise<SyscallAck | AdmissionException>;
  submitUnit(req: { workflowRunId: string; agentRunId: string; unitRef: VersionedRef; input: unknown; requestId: string }): Promise<SyscallAck | AdmissionException>;
  endAgentRun(req: { agentRunId: string; requestId: string }): Promise<SyscallAck | AdmissionException>;
  closeRun(req: { workflowRunId: string; outcome: 'COMPLETED' | 'FAILED'; reportRef?: ArtifactRef; requestId: string }): Promise<SyscallAck | AdmissionException>;
}

interface UnitReport {                              // 每个被受理的 submitUnit 恰好一个，或随 RunClosed 结束
  requestId: string;
  agentRunId: string;
  unitRef: VersionedRef;
  status: 'OK' | 'REJECTED' | 'FAILED';
  reasonCode?: string;                              // 见 module/Kernel 第 10 节
  outputRef?: ArtifactRef;
  output?: unknown;                                 // 小型结构化结果
  budgetState: BudgetState;
}

interface RunClosed {
  workflowRunId: string;
  closeReason: 'COMPLETED' | 'FAILED' | 'RUN_TIMEOUT' | 'CANCELLED' | 'VIOLATION';
  usageSummaryRef: ArtifactRef;                     // 运行记录的执行部分，Workflow 在 M1 中不读取 token 数
  unknownEffects: readonly string[];
}

type KernelToWorkflowEvent =
  | { type: 'RunStart'; goal: string }
  | ({ type: 'UnitReport' } & UnitReport)
  | ({ type: 'RunClosed' } & RunClosed);

interface WorkflowInboxPort {
  deliver(event: InboxEvent<KernelToWorkflowEvent>): Promise<void>;
}
```

`SyscallAck`、`AdmissionException`、`SyscallRejected`、`RunCreated`、`ArtifactContent` 的字段由 contracts 定义，
至少包含 `requestId` 与原因码；`RunCreated` 携带 Gateway 生成的 `workflowRunId`。
UnitReport 不携带额度数值；Workflow 按 `requestId` 对应结果，不依赖到达顺序。

## 6. Unit 的输入输出

```ts
type ContextRequest =                               // repository-orient、repository-search、context-assemble 的输入
  | { operation: 'ORIENT'; objective: string; tokenBudget: number }
  | { operation: 'SEARCH'; query: string; mode: 'AUTO' | 'TEXT' | 'PATH' | 'SYMBOL';
      maxItems?: number; tokenBudget: number }
  | { operation: 'ASSEMBLE'; objective: string; final: boolean; tokenBudget: number;
      orientPackRef?: ArtifactRef; steps: readonly StepRecord[]; status: StatusFacts };

interface FileReadInput {                           // file-read 的输入；path 为相对仓库根目录的路径
  path: string;
  startLine?: number;
  endLine?: number;
}

interface ModelCallInput {                          // model-call 的输入
  contextPackRef: ArtifactRef;
  final: boolean;
}

interface ReportPublishInput {                      // report-publish 的输入
  report: AnalysisReport;
}
```

Unit 输入不携带仓库根目录、工作区或权限范围：这些由 Core 依据 Lease 派生，经 Supervisor 注入 Executor。
Agent 指令与工具 Schema 由 Execution 依据 AgentRun 的固定定义解析（见 [Execution](kernel/Execution.md) 第 3 节）。
`StepRecord`、`StatusFacts`、`AnalysisAction`、`AnalysisReport` 由 `workflow.*` Schema 定义，尚未冻结。

ContextPack 必须包含 `contextPackId`、`requestId`、`operation`、`repositoryRevision`、`snapshotId`、items、`tokenCount`、`tokenBudget`、`truncated`、`droppedCount`、provenance、`createdAt`，并在 ASSEMBLE 时包含 `prefixSha256`。每个 ContextItem 包含 `itemId`、kind、segment、role、content、`contentSha256`、`tokenCount`、reason 及可选 path/line/score。

ContextPack 是三个上下文与检索 Unit 的输出，由 Supervisor 装配的上下文与检索 Executor 生成。
失败必须保留稳定错误码，不得统一折叠为异常字符串。

## 7. Catalog、Supervisor 与平台 Port

```ts
interface CatalogPort {
  getDefinition<K extends DefinitionKind>(
    lookup: DefinitionLookup & { kind: K },
    context: BoundaryContext,
  ): Promise<PortResult<DefinitionByKind[K]>>;
  pinAgent(request: AgentPinRequest, context: BoundaryContext): Promise<PortResult<PinnedDefinitionSet>>;
  capabilities(): readonly CapabilityDescriptor[];
}

interface ExecutionRequest {                       // Execution → Supervisor
  attemptId: string;
  runEpoch: number;
  executionKind: ExecutionKind;
  input: unknown;                                   // Execution 已解析的输入，按 executionKind 校验
  scope: ExecutionScope;                            // Core 依据 Lease 派生：仓库根目录、排除规则、外发 provider
  limits: { deadline: string; maxOutputBytes: number; maxTokens?: number };
}

type ExecutionOutcome =
  | 'COMPLETED' | 'REJECTED' | 'FAILED' | 'TERMINATED' | 'VIOLATION' | 'STOP_UNCONFIRMED';

interface ExecutionFact {                           // Supervisor → Kernel 核心；每个执行实例恰好一个终态
  attemptId: string;
  runEpoch: number;
  outcome: ExecutionOutcome;
  reasonCode?: string;
  output?: unknown;                                 // 结果内容由 Execution 写入 ArtifactStore
  usage?: { inputTokens: number; outputTokens: number };
  effects: readonly string[];
}

interface SupervisorPort {                          // 由 Supervisor 实现
  execute(request: ExecutionRequest): Promise<void>;                // 受理即返回
  cancel(request: { attemptId: string; runEpoch: number }): Promise<void>;
  cancelRun(request: { workflowRunId: string }): Promise<void>;
}

interface ExecutionFactSink {                       // 由 Kernel 核心实现
  report(fact: ExecutionFact): Promise<void>;
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
  send<T>(address: string, message: T): Promise<void>;          // 单向；返回表示已进入接收方队列
  subscribe<T>(address: string, handler: (message: T) => Promise<void>): void;
  capabilities(): readonly CapabilityDescriptor[];
}

interface LifecyclePort {
  manifest: { moduleId: string; version: string; dependencies: readonly string[] };
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<HealthStatus>;
}
```

M1 定义类型为 `AGENT | UNIT | TOOL | MODEL | PROMPT`，Schema 见 `packages/contracts/src/catalog/`。每个定义包含精确版本 `v<major>.<minor>.<patch>` 和内容 digest；digest 覆盖其引用目标的 digest，因此固定 Agent digest 即固定整个 Agent → Unit → Tool / Model / Prompt 闭包。`v0.x` 版本是草稿，可以直接修改，digest 在启动时计算；从 `v1.0.0` 起定义发布后不可变，文件中的 digest 由 `pnpm run catalog:seal` 写入，已发布版本只能引用已发布版本。状态变化只写入 `status.yaml`。Agent 必须在 `modelSettings` 中显式声明是否开启思考模式及其档位。

- `getDefinition` 只做精确查找；错误码为 `CATALOG_LOOKUP_INVALID`、`CATALOG_DEFINITION_NOT_FOUND`、`CATALOG_VERSION_NOT_FOUND` 和 `CATALOG_DEFINITION_UNAVAILABLE`（QUARANTINED/REVOKED）。
- Workflow 收到 RunStart 后为 Planner 与 CodeViewer 各调用一次 `pinAgent`，此后只读取返回的
  `PinnedDefinitionSet`，不得再次查找；`registerAgentRun` 的 `agentRef` 取自该集合，Core 登记时核对 digest。
- Kernel 核心与 Supervisor 只经 `SupervisorPort` 与 `ExecutionFactSink` 协作：Execution 调用 `execute`，Core 调用 `cancel` 与 `cancelRun`；
  `ExecutionFact` 进入所属运行的队列后由 Execution 与 Core 处理，`runEpoch` 不一致的事实只作为证据保存。
- 定义文件位于 `packages/agent-tool-pool/definitions/`，启动时全部校验；任何问题都阻止启动。设计说明见 [AgentToolPool](library/AgentToolPool.md)。

## 8. 协议注册表

| Family | Owner | M1 behavior |
|---|---|---|
| `platform.common.*` | contracts | 完整校验 |
| `interaction.*` | user-interaction | M1 无跨边界 Schema |
| `workflow.*` | workflow | StepRecord、StatusFacts、AnalysisAction、AnalysisReport |
| `kernel.control.*` | kernel | UserInteraction 请求、RunCreated、SyscallRejected、AuthorizationRequest、RunFinished |
| `kernel.unit.*` | kernel | Workflow syscall、SyscallAck、AdmissionException、RunStart、UnitReport、RunClosed、InboxEvent |
| `kernel.execution.*` | kernel | ExecutionRequest、ExecutionFact、ExecutionScope |
| `context.*` | executor-set（上下文与检索 Executor） | ContextRequest、ContextPack |
| `executor.*` | executor-set | FileReadInput、ModelCallInput、ReportPublishInput |
| `catalog.*` | agent-tool-pool | Agent/Unit/Tool/Model/Prompt Definition、DefinitionLookup、PinnedDefinitionSet |
| `platform.lifecycle.*` | module-host | 生命周期 |
| `platform.persistence.*` | persistence | 文件 Repository；其他能力 Unsupported |
| `platform.communication.*` | communication | 同进程 Router；可靠投递 Unsupported |
| `platform.artifact.*` | artifacts | 本地内容寻址存储 |
| `checkpoint.*`, `restore.*`, `review.*`, `integration.*` | 对应 owner | 仅 opaque Ref、capability 和 Unsupported |

Registry 必须拒绝重复 `schemaName@major` 和未知 major。未支持协议只定义 owner、opaque Ref 与明确错误，不冻结未经使用验证的 payload。

## 9. 身份、不可变性与测试

身份链为：

```text
WorkflowRun -> AgentRun -> submitUnit(requestId) -> UnitAttempt -> ArtifactRef
```

M1 不实现 WorkSession、SessionTree、TaskGraph、MissionScope 与 TaskAttempt 等长期概念；
单活动 Task 由 WorkflowRun 直接承载。

ContextPack、UnitReport、InboxEvent、ExecutionFact、Catalog Definition 和 ArtifactRef 发布后不可修改。每个 Port 必须提供共享 contract tests，至少覆盖合法值、额外字段、错误映射、未知 major、不可变输出、Unsupported 无副作用和 fake/real adapter 一致性。
