# MultiAgentOS M1 接口与跨模块协议

> 本文定义 M1 的接口，是 M1 全部跨模块数据结构与 Port 的唯一字段级权威。
> `packages/libraries/contracts` 已按本文实现全部 Schema 与 Port；二者不一致时以本文为准，并在同一 PR 中修正代码。

## 1. 规范约定

关键词“必须”“不得”“应”具有规范性。

### 1.1 三份文档的分工

| 文档 | 权威内容 |
|---|---|
| 本文 | 每个跨模块类型与 Port 的名称、字段、取值和语义 |
| [SharedContracts](Library/SharedContracts.md) | 这些类型在 `packages/libraries/contracts` 中的 Schema ID、文件位置、owner 与测试 |
| [AgentToolPool](Library/AgentToolPool.md) | 目录机制、加载校验规则与 M1 全部定义实例 |

三者必须一致：本文出现的每个类型在 SharedContracts 的清单中有且只有一个 Schema ID；
AgentToolPool 的定义实例只使用本文第 9 节定义的字段。发现不一致时以本文为准，并在同一 PR 中修正另外两份。

### 1.2 兼容规则

1. `schemaName + major` 唯一确定语义；未知 major 必须拒绝。
2. M1 验收前，全部 Schema 的 major 为 0，属于草稿，按本文原地修改，不另建 major；M1 验收时冻结。
   冻结后同一 major 只能增加语义明确的可选字段或独立 Schema，破坏性变更创建新 major。
3. 所有边界数据先经过运行时 Schema 校验；对象一律 `additionalProperties: false`。
4. 不允许 `any`、任意 `metadata/extensions` 或空成功对象。只有两处开放 JSON 值，均在使用前按指定 Schema 再校验：
   `ModelToolCall.arguments`（Workflow 按 Tool 的 `parametersContract` 校验）与
   `ModelToolSpec.parameters`（由 Protocol Registry 中已注册的 Schema 生成）。

### 1.3 记法

- 使用 TypeScript 记法；`?` 表示可选字段；所有对象发布后不可变（省略 `readonly`）。
- 字段使用 camelCase；标识字段以 `Id` 结尾；时间字段以 `At` 结尾，为 ISO 8601 UTC 字符串；时长字段以 `Ms` 结尾。
- 注释中的 `≤N` 表示字符串最大长度或数组最大元素数，`a..b` 表示整数取值范围。
- 注释写明“某条件下必填”的字段（如 `SyscallRejected.closeReason`、`UnitReport.output`、`RunEnd.reportRef`、
  `ExecutionFact.result`），在 Schema 中以联合变体表达：每个变体只含该条件下允许的字段，条件不成立时带上该字段同样不合法。
  派生的 TypeScript 类型随判别字段收窄，构造这类值时必须按变体一次写全。
- 本文的类型定义为便于阅读，仍写成“一个接口加可选字段”的形式；第 1.4 节列出 Schema 实际强制的全部条件，
  二者不一致时以第 1.4 节为准。

### 1.4 Schema 强制的约束

以下约束全部由 `packages/libraries/contracts` 的 Schema 在运行时强制，Fabric 在每次投递时校验；不满足任何一条的值都不合法。
没有列在这里、又无法由字段类型表达的要求（例如仓库路径是否存在、Unit 输入是否符合该 Unit 的 `inputContract`），
由文中指明的组件检查，Schema 不负责。

**标识与引用**

| 对象 | 约束 |
|---|---|
| `artifactId`、`snapshotId` | body 必须是 64 位小写十六进制 |
| `ArtifactRef` | `artifactId` 必须等于 `'art_' + sha256` |
| 指向产物的字段 | `mediaType` 必须是该字段对应的类型：`ModelCallInput.contextPackRef`、`ContextAssembleInput.orientPackRef` 为 ContextPack；`reportRef` 为 AnalysisReport；`runSummaryRef` 为 RunSummary；`UnitReport.outputRef` 与 `ToolResultStep.outputRef` 为第 6.1 节中该 Unit 的类型。`ReadArtifactRequest.ref` 与 `ArtifactContent.ref` 不限类型 |
| `PinnedDefinitionRef` | `agentRef`、`handoffTargetRef` 的 `kind` 必须为 `AGENT`；`unitRef` 必须为 `UNIT` |
| 行范围 | `SearchHit`、`SourceRef`、`VerifiedSource`、`Provenance` 的 `startLine ≤ endLine`；`FileReadInput` 同时给出两者时亦然 |

**原因码**：每个携带原因码的位置只接受自己的集合。

| 位置 | 允许的原因码 |
|---|---|
| `SyscallRejected`，`issuer = 'GATEWAY'` | `INVALID_REQUEST`、`CALLER_FORBIDDEN`、`RUN_NOT_FOUND`、`RUN_BLOCKED` |
| `SyscallRejected`，`issuer = 'CORE'` | 第 3.4 节中出现位置含 SyscallRejected 的其余原因码，以及 `RUN_NOT_FOUND`、`RUN_BLOCKED` |
| `SyscallRejected.closeReason` | 当且仅当原因码为 `RUN_BLOCKED` 时存在 |
| `UnitReport`、`ToolResultStep`，`status = 'REJECTED'` | `INVALID_INPUT`、`INVALID_ARTIFACT_REF`、`USER_DECLINED`、`BUDGET_WRAP_UP`、`BUDGET_EXHAUSTED`、`FINAL_CALL_USED`、`OUT_OF_SCOPE`、`NOT_FOUND`、`UNSUPPORTED_FILE`、`INVALID_RANGE`、`INVALID_QUERY`、`LIMIT_EXCEEDED` |
| `UnitReport`、`ToolResultStep`，`status = 'FAILED'` | `PROVIDER_UNREACHABLE`、`PROVIDER_RATE_LIMITED`、`PROVIDER_AUTH`、`PROVIDER_ERROR`、`INTERNAL`、`UNIT_TIMEOUT` |
| `ExecutionFact` 与 `ExecutorOutcome` | 按 `outcome` 取第 7.3 节表中的集合 |
| `failurePolicy` 的键 | 上面 UnitReport 两行的并集 |
| `RunFailure` | `category` 必须等于 `REASON_CODE_CATEGORY[code]` |

**Gateway 请求与运行结束**

| 对象 | 约束 |
|---|---|
| `CloseRunRequest` | `COMPLETED` 只带 `reportRef`；`FAILED` 只带 `failure`，且 `failure.source = 'WORKFLOW'` |
| `RunEnd`（RunClosed、RunFinished）与 `RunSummary` | `COMPLETED`：有 `reportRef`，无 `failure`；`FAILED`：有 `failure`，无 `reportRef`；`VIOLATION`：`failure.code` 为三个安全违规原因码之一、`category = 'INTEGRITY'`、`source = 'KERNEL'`，无 `reportRef`；`RUN_TIMEOUT`、`CANCELLED`：二者皆无 |
| `RunSummary.units` | `submitted = ok + rejected + failed + notDelivered` |
| `UnknownEffect` | `MODEL_REQUEST_UNCONFIRMED` 的 `executionKind` 必须为 `MODEL`；`EXECUTION_STOP_UNCONFIRMED` 的 `executionKind` 必须是会派发给 Supervisor 的五种之一 |
| `AdmissionProjection` | `closeReason` 当且仅当 `runState` 不为 `RUNNING` 时存在 |

**UnitReport**

| 情况 | 约束 |
|---|---|
| `status = 'OK'` | `executionKind` 为第 6.1 节的六种之一；`output` 必须是该种 Unit 的输出类型，`outputRef` 必须是该种 Unit 的产物类型；`unitAttemptId` 必填；不得带 `reasonCode` |
| `reasonCode = 'USER_DECLINED'` | `status` 必须为 `REJECTED`；`executionKind` 必须是读取仓库的三种之一；不得带 `unitAttemptId` |
| 其余 `REJECTED`、`FAILED` | `unitAttemptId` 与 `reasonCode` 必填；不得带 `output`、`outputRef` |

**上下文**

| 对象 | 约束 |
|---|---|
| `ContextItem` | `segment` 决定 `role` 与附加字段：INSTRUCTIONS、TOOLS 为 `system`；OBJECTIVE、HANDOFF、ORIENT、SEARCH_HIT、STATUS 为 `user`；HISTORY 为 `assistant`、`tool` 或 `user`。`toolSpecs` 只出现在 TOOLS 且必填；`provenance` 在 ORIENT、SEARCH_HIT 必填，在 HISTORY 的 `tool` 条目可选，其余不得出现；`score` 只出现在 SEARCH_HIT 且必填；`toolCalls` 只出现在 HISTORY 的 `assistant` 条目，出现时至少一项；`toolCallId` 只出现在 HISTORY 的 `tool` 条目且必填 |
| `ContextPack` | ORIENT 包只含 ORIENT 条目，SEARCH 包只含 SEARCH_HIT 条目，二者 `snapshotId` 必填且不得带 `prefixSha256`；ASSEMBLE 包 `prefixSha256` 必填且不含 SEARCH_HIT 条目。`itemId` 必须等于 `${contextPackId}:${序号}` |
| `ContextAssembleInput`、`AssembleExecutorInput` | `final` 必须等于 `status.final` |
| `AssembleExecutorInput` | `orientPack` 必须是 ORIENT 包；`ResolvedStep.outputText` 当且仅当该步骤是 `status = 'OK'` 的 `TOOL_RESULT` 时存在 |
| `ModelExecutorInput.contextPack` | 必须是 ASSEMBLE 包 |
| `ContextAssembleOutput` | `tokenCount ≤ tokenBudget` |
| `StatusFacts` | `roundsUsed ≤ maxRounds` |

**模型与文件**

| 对象 | 约束 |
|---|---|
| `ModelToolCall` | 只有两种形态：`arguments` 为非 `null` 的 JSON 值且不带 `argumentsError`；或 `arguments = null` 且 `argumentsError = 'INVALID_JSON'` |
| `ModelCallOutput` | `finishReason = 'TOOL_CALLS'` 当且仅当 `toolCalls` 非空 |
| `TokenUsage` | `inputCacheHitTokens ≤ inputTokens` |
| `FileReadOutput` | `totalLines = 0` 时 `startLine = 1`、`endLine = 0`；否则 `startLine ≤ endLine ≤ totalLines` |

**Workflow 结构**

| 对象 | 约束 |
|---|---|
| `ToolResultStep` | `status = 'OK'` 时 `output` 与 `outputRef` 必填且类型相配（检索输出配 ContextPack，读取输出配文本）；否则只带该状态的 `reasonCode` |
| `FeedbackStep` | `UNKNOWN_TOOL`、`INVALID_ARGUMENTS`、`TOO_MANY_TOOL_CALLS`、`DUPLICATE_CALL`、`NOT_EXECUTED` 必须带 `toolCallId`；`MODEL_CALL_FAILED`、`WRAP_UP_NOTICE` 不得带；`INVALID_ACTION` 可带可不带 |
| `AnalysisReport` | `degraded = false`：每条结论至少一个来源，`wrapUp` 可选；`degraded = true`：`wrapUp` 必填，`conclusions` 与 `unconfirmed` 必须为空 |

**执行请求与执行事实**

| 对象 | 约束 |
|---|---|
| `ExecutionRequest` | `executionKind` 同时决定 `input`、`scope.kind` 与 `limits`：`maxFiles` 只属于 `REPOSITORY_ORIENT` 且必填，`maxOutputTokens` 只属于 `MODEL` 且必填 |
| `ExecutionScope`（MODEL） | `thinkingEffort` 当且仅当 `thinking = 'ENABLED'` 时存在；`baseUrl` 必须以 `https://` 开头 |
| `ExecutionResult` | `output` 必须是该 `executionKind` 的输出类型；`artifact` 必填，`mediaType` 必须是该种的产物类型 |
| `ExecutionFact` | 携带 `executionKind`，并由它决定其余字段：`COMPLETED` 的 `result` 必须是该种的结果；只有 `MODEL` 带 `requestState`（必填）与 `usage`（可选），其余种类不得带；`MODEL` 的 `COMPLETED` 必须 `requestState = 'SENT'`；`retryable` 只属于 `FAILED` 且必填；`startedAt` 只有 `TERMINATED` 可以缺失 |

## 2. 通讯主体、Fabric 与端口

### 2.1 通讯主体

| 通讯主体 | producer | 提供（被调用）的 Port | 持有（调用）的 Port |
|---|---|---|---|
| UserInteraction | `user-interaction` | `InteractionInboxPort` | `InteractionGatewayPort` |
| Workflow | `workflow` | `WorkflowInboxPort` | `WorkflowGatewayPort`、`CatalogPort`、`PersistencePort` |
| Gateway | `gateway` | `WorkflowGatewayPort`、`InteractionGatewayPort` 的服务端 | Fabric（转发给 Kernel 核心） |
| Kernel 核心 | `kernel-core` | `ExecutionFactSink`、`GatewayForward` 处理器 | `SupervisorPort`、`CatalogPort`、`ArtifactStorePort`、`PersistencePort`、Inbox（经 Fabric `send`） |
| Supervisor | `supervisor` | `SupervisorPort` | `ExecutionFactSink`、ExecutorSet 中的 `Executor` |

规则：

1. 通讯主体之间的每次交互都经 Fabric，包装为 `Envelope`，在接收边界按 Schema 校验 payload；
   Fabric 投递时复制 payload（`structuredClone`）。
2. 组合根（`apps/control-plane`）为每个通讯主体创建一个 Fabric 客户端，客户端固定写入 `Envelope.producer`，主体代码不能修改。
   五个通讯主体使用同一个 `FabricPort`（第 10 节）；上表中的各个 Port 是其上的类型化存根，限定每个主体能调用与提供的范围。
3. 跨通讯主体的 Port 是组合根基于该主体的 Fabric 客户端生成的存根：Workflow 只拿到 `WorkflowGatewayPort`，
   UserInteraction 只拿到 `InteractionGatewayPort`，Supervisor 只拿到 `ExecutionFactSink`。
   `CatalogPort`、`PersistencePort`、`ArtifactStorePort` 由静态库或基础设施直接实现，按上表只注入需要的主体。
4. Gateway 以 `Envelope.producer` 判定调用方身份；producer 与请求类型不匹配时返回 `CALLER_FORBIDDEN`。
5. 静态库（AgentToolPool、ExecutorSet、SharedContracts）不是通讯主体，以函数调用使用。
6. Kernel 核心内部（Core、Monitor、Scheduler、Execution）以函数调用协作，不经 Fabric；
   其接口属于 Kernel 私有，见 [Kernel/Interaction](Kernel/Interaction.md)，不进入 contracts。

### 2.2 Fabric 路由

| schemaName 或地址 | 方式 | 发送方 | 处理方 |
|---|---|---|---|
| `kernel.unit.RegisterAgentRunRequest.v0`、`kernel.unit.SubmitUnitRequest.v0`、`kernel.unit.EndAgentRunRequest.v0`、`kernel.unit.CloseRunRequest.v0` | request | workflow | gateway |
| `kernel.control.CreateRunRequest.v0`、`kernel.control.AnswerAuthorizationRequest.v0`、`kernel.control.CancelRunRequest.v0`、`kernel.control.ReadArtifactRequest.v0`、`kernel.control.ShutdownRequest.v0` | request | user-interaction | gateway |
| `kernel.control.GatewayForward.v0` | request | gateway | kernel-core |
| 地址 `gateway.admission`（`kernel.control.AdmissionProjection.v0`） | send | kernel-core | gateway |
| `kernel.execution.ExecutionRequest.v0`、`kernel.execution.CancelRunExecutionsRequest.v0`、`kernel.execution.SupervisorShutdownRequest.v0` | request | kernel-core | supervisor |
| 地址 `kernel-core.execution-facts`（`kernel.execution.ExecutionFact.v0`） | send | supervisor | kernel-core |
| 地址 `inbox.workflow`（`kernel.unit.WorkflowInboxEvent.v0`） | send | kernel-core | workflow |
| 地址 `inbox.user-interaction`（`kernel.control.InteractionInboxEvent.v0`） | send | kernel-core | user-interaction |

`request` 等待处理方返回响应；`send` 的返回只表示消息已进入接收方队列。

### 2.3 请求标识与幂等

- 每个改变状态的请求携带调用方生成的 `requestId`（前缀 `req_`），一次请求意图对应一个 `requestId`，重传沿用。
- 相同 `requestId` 且内容相同：返回与第一次相同的响应。相同 `requestId` 但内容不同：返回 `REQUEST_CONFLICT`。
  内容相同指请求 payload 的规范 JSON（`canonical-json`）SHA-256 相同。
- 运行内请求的响应由 Core 按运行记录；`createRun`、`shutdown` 的响应由 Core 的运行管理记录。
- 事件按 `eventId` 去重、按 `seq` 排序；`Envelope.messageId` 是传输标识，每次传递都不同，不用于去重。

### 2.4 correlationId

`correlationId` 只用于追踪，把同一运行引发的消息串在一起，不参与任何裁决。

- 运行的 `correlationId` 由 Gateway 在 `createRun` 时生成并按 `workflowRunId` 保存。
  Gateway 转发运行内请求时，以保存的值覆盖调用方在 `BoundaryContext` 中传入的值；Kernel 核心与 Supervisor 之间的消息沿用该值。
- Workflow 与 UserInteraction 不会得到运行的 `correlationId`：`RunCreated` 与 Inbox 事件都不携带它。
  二者传入的 `correlationId` 可以任意生成，各自的记录以 `workflowRunId` 为关联键。
- 没有运行可查的请求沿用调用方传入的值：被拒绝的 `createRun`，以及 `shutdown`。

## 3. 公共类型（`platform.common`）

### 3.1 标识

所有标识的格式为 `<prefix>_<body>`，`body` 匹配 `[A-Za-z0-9][A-Za-z0-9_-]{5,127}`。随机标识的 body 使用 ULID。

| 字段 | 前缀 | 生成者 | 说明 |
|---|---|---|---|
| `workflowRunId` | `wfr` | Gateway（`createRun`） | 一次运行 |
| `agentRunId` | `agr` | Workflow | 一次 AgentRun |
| `requestId` | `req` | Workflow、UserInteraction | 一次请求意图 |
| `unitAttemptId` | `una` | Execution | 一次被受理的 Unit 执行尝试 |
| `executionId` | `exe` | Execution | 一次派发给 Supervisor 的执行实例；技术重试产生新的 `executionId` |
| `eventId` | `evt` | Core（Outbox） | 一个 Inbox 事件 |
| `messageId` | `msg` | Fabric | 一次传递 |
| `correlationId` | `cor` | Gateway（`createRun`） | 同一运行内的全部消息沿用 |
| `questionId` | `qst` | Core | 一次授权询问 |
| `artifactId` | `art` | Execution | body 为内容的 SHA-256（64 位小写十六进制） |
| `contextPackId` | `ctx` | 上下文 Executor | 一个 ContextPack |
| `snapshotId` | `snp` | repository-orient Executor | body 为仓库快照摘要（见 [ExecutorSet](Library/ExecutorSet.md) 3.1） |

`toolCallId` 由模型 provider 返回，原样使用（1..128 个字符）。

### 3.2 上下文与信封

```ts
interface BoundaryContext {
  correlationId: string;
  causationId?: string;          // 引发本消息的 messageId
  tenantId: string;              // M1 固定为 'local'
  projectId: string;             // M1 固定为 'local'
  workflowRunId?: string;        // 运行内消息必填
  workSessionId?: string;        // M1 不使用
  deadline?: string;             // M1 不使用
}

interface Envelope<T> {
  schemaName: string;            // 如 'kernel.unit.SubmitUnitRequest'
  schemaVersion: number;         // major，M1 为 0
  messageType: 'command' | 'query' | 'event' | 'signal' | 'result';
  messageId: string;
  producer: 'user-interaction' | 'workflow' | 'gateway' | 'kernel-core' | 'supervisor';
  occurredAt: string;
  tenantId: string;
  projectId: string;
  correlationId: string;
  causationId?: string;
  workflowRunId?: string;
  payload: T;
}
```

`Envelope` Schema 中的 `workSessionId`、`missionScopeId`、`aggregateId`、`aggregateVersion`、`graphRevision`、
`traceparent` 保留为可选字段，M1 不填写。

### 3.3 通用值

```ts
interface ArtifactRef {
  artifactId: string;
  mediaType: string;             // 见第 6.1 节的媒体类型
  sha256: string;                // 64 位小写十六进制
  size: number;                  // 字节数
}

type ErrorCategory =
  | 'VALIDATION' | 'CONFLICT' | 'POLICY' | 'TIMEOUT' | 'RESOURCE'
  | 'DEPENDENCY' | 'EXECUTION' | 'INTEGRITY' | 'CONTRACT' | 'INTERNAL';

interface ModuleError {          // 只用于同步 Port（CatalogPort 等）的失败返回
  code: string;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  correlationId: string;
  diagnosticsRef?: ArtifactRef;
  detailsRef?: ArtifactRef;
}

type PortResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ModuleError };

interface CapabilityDescriptor {
  capability: string;
  status: 'SUPPORTED' | 'UNSUPPORTED' | 'DEGRADED';
  schemaNames: string[];
  reason?: string;
}
```

调用方只能使用 `code`、`category`、`retryable` 或 `reasonCode` 决策，不得解析 `message` 与 `detail`。

### 3.4 原因码

`ReasonCode` 是一个封闭枚举，下表列出全部取值。

| 原因码 | 出现位置 | 产生者 | 含义 | category |
|---|---|---|---|---|
| `INVALID_REQUEST` | SyscallRejected | Gateway | 请求不符合 Schema | `VALIDATION` |
| `CALLER_FORBIDDEN` | SyscallRejected | Gateway | 调用方无权发起该请求 | `POLICY` |
| `RUN_NOT_FOUND` | SyscallRejected | Gateway、Core | `workflowRunId` 不存在 | `VALIDATION` |
| `RUN_BLOCKED` | SyscallRejected | Gateway、Core | 运行处于 CONVERGING 或 CLOSED，`closeReason` 给出原因 | `CONFLICT` |
| `REQUEST_CONFLICT` | SyscallRejected | Core | 相同 `requestId` 对应不同内容 | `CONFLICT` |
| `RUN_LIMIT` | SyscallRejected | Core | 本进程已经创建过运行，或系统正在关闭 | `CONFLICT` |
| `REPOSITORY_INVALID` | SyscallRejected | Core | 仓库路径不是绝对路径、不存在、不是目录，或其 realpath 与系统数据目录互相包含 | `VALIDATION` |
| `DEFINITION_MISMATCH` | SyscallRejected | Core | `agentRef.digest` 与目录不一致 | `INTEGRITY` |
| `DEFINITION_UNAVAILABLE` | SyscallRejected | Core | 定义不存在、被隔离或撤销 | `DEPENDENCY` |
| `AGENT_RUN_ACTIVE` | SyscallRejected | Core | 已有另一个 ACTIVE 的 AgentRun | `CONFLICT` |
| `AGENT_RUN_EXISTS` | SyscallRejected | Core | `agentRunId` 已经登记 | `CONFLICT` |
| `AGENT_RUN_NOT_FOUND` | SyscallRejected | Core | AgentRun 未登记或不属于该运行 | `VALIDATION` |
| `AGENT_RUN_ENDED` | SyscallRejected | Core | AgentRun 已结束 | `CONFLICT` |
| `FORBIDDEN` | SyscallRejected | Core | Unit 不在该 AgentRun 的固定定义闭包内，或 Agent 的模型 provider 不是配置的 provider | `POLICY` |
| `UNSUPPORTED_CAPABILITY` | SyscallRejected | Core | Unit 的 executionKind 为 `FILE_WRITE`、`COMMAND` 或 `TEST` | `CONTRACT` |
| `INVALID_INPUT` | SyscallRejected、UnitReport | Core、Execution | Unit 输入不符合该 Unit 的 `inputContract`（SyscallRejected）；model-call 引用的 ContextPack 与 `final` 不一致（UnitReport） | `VALIDATION` |
| `QUESTION_NOT_PENDING` | SyscallRejected | Core | 授权询问不存在、已回答或已失效 | `CONFLICT` |
| `INVALID_ARTIFACT_REF` | SyscallRejected、UnitReport | Core、Execution | 引用不存在或不属于该运行（两者不区分） | `VALIDATION` |
| `USER_DECLINED` | UnitReport | Core | 用户拒绝或授权询问超时 | `POLICY` |
| `BUDGET_WRAP_UP` | UnitReport | Core（Monitor） | 普通 model-call 的预留会占用收尾保留额度，未发出 | `RESOURCE` |
| `BUDGET_EXHAUSTED` | UnitReport | Core（Monitor） | 额度已不足以发起任何 model-call，未发出 | `RESOURCE` |
| `FINAL_CALL_USED` | UnitReport | Core | 本运行已经发起过 final-call | `RESOURCE` |
| `OUT_OF_SCOPE` | UnitReport | Executor | 路径越出仓库根目录、命中排除规则或为危险文件 | `POLICY` |
| `NOT_FOUND` | UnitReport | Executor | 路径不存在 | `EXECUTION` |
| `UNSUPPORTED_FILE` | UnitReport | Executor | 不是普通文本文件（目录、二进制、特殊文件） | `EXECUTION` |
| `INVALID_RANGE` | UnitReport | Executor | 行范围不合法（`startLine > endLine` 或起始行超出文件） | `VALIDATION` |
| `INVALID_QUERY` | UnitReport | Executor | 检索表达式不合法 | `VALIDATION` |
| `LIMIT_EXCEEDED` | UnitReport | Executor、Execution | 输出、文件数或报告大小超出限制 | `RESOURCE` |
| `PROVIDER_UNREACHABLE` | UnitReport | Executor | 请求发出前连接、DNS 或 TLS 失败 | `DEPENDENCY` |
| `PROVIDER_RATE_LIMITED` | UnitReport | Executor | provider 返回 429 | `DEPENDENCY` |
| `PROVIDER_AUTH` | UnitReport | Executor | provider 返回 401 或 403 | `DEPENDENCY` |
| `PROVIDER_ERROR` | UnitReport | Executor | provider 返回 5xx 或响应流中断 | `DEPENDENCY` |
| `UNIT_TIMEOUT` | UnitReport、ExecutionFact | Supervisor | 执行到达截止时间被终止 | `TIMEOUT` |
| `INTERNAL` | UnitReport | Executor、Execution | 其他内部错误 | `INTERNAL` |
| `EXECUTION_CANCELLED` | ExecutionFact | Supervisor | 执行因运行收敛被取消；不出现在 UnitReport | `EXECUTION` |
| `SCOPE_MISSING` | ExecutionFact、RunFailure | Executor | 范围约束缺失或格式错误（安全违规） | `INTEGRITY` |
| `PATH_ESCAPE` | ExecutionFact、RunFailure | Executor | 检查通过后实际打开的文件越出根目录（安全违规） | `INTEGRITY` |
| `GUARD_FAILURE` | ExecutionFact、RunFailure | Executor | 执行点防护本身失效（安全违规） | `INTEGRITY` |
| `EXECUTION_STOP_UNCONFIRMED` | RunFailure | Core | 执行在宽限期内未能确认停止 | `INTERNAL` |
| `PIN_FAILED` | RunFailure | Workflow | 固定 Agent 定义失败，或交接目标的 digest 不一致 | `DEPENDENCY` |
| `WORKFLOW_INTERNAL` | RunFailure | Workflow | Workflow 内部错误 | `INTERNAL` |
| `KERNEL_INTERNAL` | RunFailure | Core | Kernel 内部错误 | `INTERNAL` |

`category` 列即 contracts 导出的 `REASON_CODE_CATEGORY`，每个原因码只有一个类别。
`RunFailure.code` 可以是任意原因码：Workflow 判定失败时取导致失败的 SyscallRejected 或 UnitReport 的原因码。

```ts
type ReasonCode =
  | 'INVALID_REQUEST'
  | 'CALLER_FORBIDDEN'
  | 'RUN_NOT_FOUND'
  | 'RUN_BLOCKED'
  | 'REQUEST_CONFLICT'
  | 'RUN_LIMIT'
  | 'REPOSITORY_INVALID'
  | 'DEFINITION_MISMATCH'
  | 'DEFINITION_UNAVAILABLE'
  | 'AGENT_RUN_ACTIVE'
  | 'AGENT_RUN_EXISTS'
  | 'AGENT_RUN_NOT_FOUND'
  | 'AGENT_RUN_ENDED'
  | 'FORBIDDEN'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INVALID_INPUT'
  | 'QUESTION_NOT_PENDING'
  | 'INVALID_ARTIFACT_REF'
  | 'USER_DECLINED'
  | 'BUDGET_WRAP_UP'
  | 'BUDGET_EXHAUSTED'
  | 'FINAL_CALL_USED'
  | 'OUT_OF_SCOPE'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_FILE'
  | 'INVALID_RANGE'
  | 'INVALID_QUERY'
  | 'LIMIT_EXCEEDED'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_ERROR'
  | 'UNIT_TIMEOUT'
  | 'INTERNAL'
  | 'EXECUTION_CANCELLED'
  | 'SCOPE_MISSING'
  | 'PATH_ESCAPE'
  | 'GUARD_FAILURE'
  | 'EXECUTION_STOP_UNCONFIRMED'
  | 'PIN_FAILED'
  | 'WORKFLOW_INTERNAL'
  | 'KERNEL_INTERNAL';
```

## 4. Gateway 端口

### 4.1 端口定义

```ts
interface WorkflowGatewayPort {                     // 只注入 Workflow
  registerAgentRun(request: RegisterAgentRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  submitUnit(request: SubmitUnitRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  endAgentRun(request: EndAgentRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  closeRun(request: CloseRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
}

interface InteractionGatewayPort {                  // 只注入 UserInteraction
  createRun(request: CreateRunRequest, context: BoundaryContext): Promise<RunCreated | SyscallRejected>;
  answerAuthorization(request: AnswerAuthorizationRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  cancelRun(request: CancelRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  readArtifact(request: ReadArtifactRequest, context: BoundaryContext): Promise<ArtifactContent | SyscallRejected>;
  shutdown(request: ShutdownRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
}
```

### 4.2 请求

```ts
interface RegisterAgentRunRequest {
  requestId: string;
  workflowRunId: string;
  agentRunId: string;
  agentRef: PinnedDefinitionRef;                    // kind = 'AGENT'
}

interface SubmitUnitRequest {
  requestId: string;
  workflowRunId: string;
  agentRunId: string;
  unitRef: PinnedDefinitionRef;                     // kind = 'UNIT'
  input: UnitInput;                                 // 按 unitRef 对应 Unit 的 inputContract 校验（第 6 节）
}

interface EndAgentRunRequest {
  requestId: string;
  workflowRunId: string;
  agentRunId: string;
}

type CloseRunRequest =
  | { requestId: string; workflowRunId: string; outcome: 'COMPLETED'; reportRef: ArtifactRef }
  | { requestId: string; workflowRunId: string; outcome: 'FAILED'; failure: RunFailure };   // failure.source = 'WORKFLOW'

interface CreateRunRequest {
  requestId: string;
  goal: string;                                     // 1..4000 个字符
  repositoryPath: string;                           // 绝对路径
}

interface AnswerAuthorizationRequest {
  requestId: string;
  workflowRunId: string;
  questionId: string;
  answer: 'YES' | 'NO';
}

interface CancelRunRequest {
  requestId: string;
  workflowRunId: string;
}

interface ReadArtifactRequest {
  requestId: string;
  workflowRunId: string;
  ref: ArtifactRef;
}

interface ShutdownRequest {
  requestId: string;
}
```

### 4.3 响应

```ts
interface SyscallAck {
  requestId: string;
  outcome: 'ACCEPTED';
}

interface SyscallRejected {
  requestId: string;
  outcome: 'REJECTED';
  reasonCode: ReasonCode;                           // 只取第 3.4 节中出现位置含 SyscallRejected 的原因码
  issuer: 'GATEWAY' | 'CORE';
  closeReason?: CloseReason;                        // reasonCode = RUN_BLOCKED 时必填
}

interface RunCreated {
  requestId: string;
  outcome: 'ACCEPTED';
  workflowRunId: string;
}

interface ArtifactContent {
  requestId: string;
  outcome: 'ACCEPTED';
  ref: ArtifactRef;
  text: string;                                     // M1 的产物全部为 UTF-8 文本或 JSON
}
```

各请求在运行不同状态下的处理见 [Kernel（外部视角）](Module/Kernel.md) 4.3。

## 5. Inbox 事件

### 5.1 信封与端口

```ts
interface InboxEvent<T> {
  eventId: string;
  workflowRunId: string;
  seq: number;                                      // 每个运行、每个接收方从 1 连续递增
  occurredAt: string;
  event: T;
}

type WorkflowInboxEvent = InboxEvent<KernelToWorkflowEvent>;
type InteractionInboxEvent = InboxEvent<KernelToInteractionEvent>;

interface InboxPort<T> {                            // 由接收方实现
  deliver(event: InboxEvent<T>): Promise<void>;
}

type WorkflowInboxPort = InboxPort<KernelToWorkflowEvent>;        // 由 Workflow 实现
type InteractionInboxPort = InboxPort<KernelToInteractionEvent>;  // 由 UserInteraction 实现
```

`deliver` 只做 Schema 校验与入队即返回，返回不表示已经处理。投递语义见 [Kernel（外部视角）](Module/Kernel.md) 4.5。

### 5.2 发给 Workflow 的事件

```ts
type KernelToWorkflowEvent = RunStart | UnitReport | RunClosed;

interface RunStart {
  type: 'RunStart';
  goal: string;
}

interface UnitReport {                              // 每个得到 SyscallAck 的 submitUnit 恰好一个，或随 RunClosed 结束
  type: 'UnitReport';
  requestId: string;
  agentRunId: string;
  unitRef: PinnedDefinitionRef;
  executionKind: ExecutionKind;
  unitAttemptId?: string;                           // 已建立 UnitAttempt 时必填；USER_DECLINED 在建立尝试之前，没有该字段
  status: 'OK' | 'REJECTED' | 'FAILED';
  reasonCode?: ReasonCode;                          // status 为 REJECTED、FAILED 时必填
  output?: UnitOutput;                              // status 为 OK 时必填，按 Unit 的 outputContract 校验
  outputRef?: ArtifactRef;                          // status 为 OK 时按第 6.1 节必填
  budgetState: BudgetState;
}

interface RunEnd {                                  // RunClosed 与 RunFinished 共用的结束信息
  closeReason: CloseReason;
  failure?: RunFailure;                             // closeReason 为 FAILED、VIOLATION 时必填
  reportRef?: ArtifactRef;                          // closeReason 为 COMPLETED 时必填
  unknownEffects: UnknownEffect[];
  runSummaryRef: ArtifactRef;                       // RunSummary 产物（第 11 节）
}

interface RunClosed extends RunEnd {                // 每个运行恰好一个，是发给 Workflow 的最后一个事件
  type: 'RunClosed';
}

type BudgetState = 'NORMAL' | 'WRAP_UP' | 'EXHAUSTED';
type CloseReason = 'COMPLETED' | 'FAILED' | 'RUN_TIMEOUT' | 'CANCELLED' | 'VIOLATION';
```

### 5.3 发给 UserInteraction 的事件

```ts
type KernelToInteractionEvent = AuthorizationRequest | AuthorizationResolved | RunFinished;

interface AuthorizationRequest {
  type: 'AuthorizationRequest';
  questionId: string;
  capability: 'repo.read';
  repositoryPath: string;                           // 仓库根目录的 realpath
  exclusions: string[];                             // 排除规则（glob），见 Kernel/Core 第 4 节
  provider: string;                                 // 读取内容将发送到的模型 provider
  expiresAt: string;
}

interface AuthorizationResolved {
  type: 'AuthorizationResolved';
  questionId: string;
  resolution: 'GRANTED' | 'DECLINED' | 'TIMED_OUT' | 'CANCELLED';
}

interface RunFinished extends RunEnd {              // 每个运行恰好一个，是发给 UserInteraction 的最后一个事件
  type: 'RunFinished';
}
```

RunFinished 与 RunClosed 在同一次处理中由 Core 放入 Outbox，二者的 `RunEnd` 字段完全相同。
`RunEnd` 只是两个 Schema 共用的字段定义，不单独注册 Schema。

### 5.4 结束信息

```ts
interface RunFailure {
  code: ReasonCode;
  category: ErrorCategory;
  source: 'WORKFLOW' | 'KERNEL';
  unitRequestId?: string;                           // 由哪个 submitUnit 引起
  detail?: string;                                  // ≤200，不得包含源码、Prompt、凭据；不用于决策和展示文案
}

interface UnknownEffect {
  unitAttemptId: string;
  executionId: string;
  executionKind: ExecutionKind;
  effect: 'MODEL_REQUEST_UNCONFIRMED' | 'EXECUTION_STOP_UNCONFIRMED';
}
```

| closeReason | failure | reportRef |
|---|---|---|
| `COMPLETED` | 无 | 必填 |
| `FAILED` | 必填；Workflow 判定时 `source = 'WORKFLOW'`，Kernel 判定时 `source = 'KERNEL'` | 无 |
| `RUN_TIMEOUT`、`CANCELLED` | 无 | 无 |
| `VIOLATION` | 必填，`code` 为安全违规原因码，`source = 'KERNEL'` | 无 |

## 6. Unit 的输入与输出

### 6.1 Unit 清单

```ts
type ExecutionKind =                                // platform.common.ExecutionKind，供 catalog 与 kernel 共用
  | 'REPOSITORY_ORIENT' | 'REPOSITORY_SEARCH' | 'FILE_READ'
  | 'CONTEXT_ASSEMBLE' | 'MODEL' | 'REPORT_PUBLISH'
  | 'FILE_WRITE' | 'COMMAND' | 'TEST';              // 后三者在 M1 返回 UNSUPPORTED_CAPABILITY

type UnitInput =
  | RepositoryOrientInput | RepositorySearchInput | FileReadInput
  | ContextAssembleInput | ModelCallInput | ReportPublishInput;

type UnitOutput =
  | RepositoryOrientOutput | RepositorySearchOutput | FileReadOutput
  | ContextAssembleOutput | ModelCallOutput | ReportPublishOutput;
```

| Unit | executionKind | 输入 | 输出（UnitReport.output） | 产物（UnitReport.outputRef）的 mediaType |
|---|---|---|---|---|
| `repository-orient` | `REPOSITORY_ORIENT` | `RepositoryOrientInput` | `RepositoryOrientOutput` | `application/vnd.multiagentos.context-pack+json` |
| `repository-search` | `REPOSITORY_SEARCH` | `RepositorySearchInput` | `RepositorySearchOutput` | `application/vnd.multiagentos.context-pack+json` |
| `file-read` | `FILE_READ` | `FileReadInput` | `FileReadOutput` | `text/plain; charset=utf-8` |
| `context-assemble` | `CONTEXT_ASSEMBLE` | `ContextAssembleInput` | `ContextAssembleOutput` | `application/vnd.multiagentos.context-pack+json` |
| `model-call` | `MODEL` | `ModelCallInput` | `ModelCallOutput` | `application/vnd.multiagentos.model-output+json` |
| `report-publish` | `REPORT_PUBLISH` | `ReportPublishInput` | `ReportPublishOutput` | `application/vnd.multiagentos.analysis-report+json` |

Kernel 自身产生的产物：RunSummary，mediaType 为 `application/vnd.multiagentos.run-summary+json`。

Unit 输入不携带仓库根目录、排除规则或模型目标：这些由 Core 派生，经 `ExecutionScope` 交给 Supervisor（第 7 节）。
Unit 输入中的 `ArtifactRef` 只允许出现在三个位置：`ContextAssembleInput.orientPackRef`、
`ToolResultStep.outputRef`（位于 `ContextAssembleInput.steps`）与 `ModelCallInput.contextPackRef`。
Execution 只在这三个位置解析引用并检查归属。

### 6.2 仓库与文件

```ts
interface RepositoryOrientInput {                   // context.RepositoryOrientInput
  objective: string;                                // 1..4000，即用户目标
}

interface RepositoryOrientOutput {                  // context.RepositoryOrientOutput
  snapshotId: string;
  fileCount: number;
  totalBytes: number;
  summary: string;                                  // ≤4000，目录结构与主要文件的概览
  tokenCount: number;
  truncated: boolean;
}

interface RepositorySearchInput {                   // context.RepositorySearchInput；同时是 search_repository 工具的参数
  query: string;                                    // 1..500
  mode?: 'AUTO' | 'TEXT' | 'PATH' | 'SYMBOL';       // 缺省 AUTO
  maxItems?: number;                                // 1..50，缺省 20
}

interface RepositorySearchOutput {                  // context.RepositorySearchOutput
  snapshotId: string;
  hits: SearchHit[];                                // ≤50
  truncated: boolean;
}

interface SearchHit {
  path: string;                                     // 相对仓库根目录，使用 '/'
  startLine: number;
  endLine: number;
  score: number;                                    // 0..1
  matchKind: 'TEXT' | 'PATH' | 'SYMBOL';
}

interface FileReadInput {                           // executor.FileReadInput；同时是 read_file 工具的参数
  path: string;                                     // 相对仓库根目录，1..1024
  startLine?: number;                               // ≥1，缺省 1
  endLine?: number;                                 // ≥startLine，缺省为 startLine + 399 与文件末行中的较小者
}
// 空文件（0 行）且未给出行范围时返回空内容：startLine = 1、endLine = 0、totalLines = 0

interface FileReadOutput {                          // executor.FileReadOutput
  path: string;
  startLine: number;                                // 实际返回的起始行
  endLine: number;                                  // 实际返回的结束行
  totalLines: number;
  contentSha256: string;                            // 返回内容（UTF-8、LF 换行）的 SHA-256
  fileSha256: string;                               // 整个文件的 SHA-256
}
```

### 6.3 上下文组装与 ContextPack

```ts
interface ContextAssembleInput {                    // context.ContextAssembleInput
  objective: string;                                // 用户目标
  final: boolean;                                   // 是否为 final-call 组装
  handoff?: HandoffBrief;                           // CodeViewer 承接 Planner 交接时必填
  orientPackRef?: ArtifactRef;                      // repository-orient 的产物
  steps: StepRecord[];                              // 本 AgentRun 的历史，按发生顺序
  status: StatusFacts;
}

interface ContextAssembleOutput {                   // context.ContextAssembleOutput
  contextPackId: string;
  tokenCount: number;
  tokenBudget: number;
  truncated: boolean;
  droppedCount: number;
  prefixSha256: string;
  elidedRequestIds: string[];                       // 正文被省略或整轮被移除的 TOOL_RESULT 的 requestId
}

interface ContextPack {                             // context.ContextPack
  contextPackId: string;
  operation: 'ORIENT' | 'SEARCH' | 'ASSEMBLE';
  snapshotId?: string;                              // ORIENT、SEARCH 必填；ASSEMBLE 有 orient 包时沿用
  tokenCount: number;
  tokenBudget: number;
  truncated: boolean;
  droppedCount: number;
  prefixSha256?: string;                            // ASSEMBLE 必填：INSTRUCTIONS 与 TOOLS 段内容的 SHA-256
  items: ContextItem[];
  createdAt: string;
}

interface ContextItem {
  itemId: string;                                   // `${contextPackId}:${序号}`
  segment: 'INSTRUCTIONS' | 'TOOLS' | 'OBJECTIVE' | 'HANDOFF' | 'ORIENT'
         | 'SEARCH_HIT' | 'HISTORY' | 'STATUS';
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  contentSha256: string;
  tokenCount: number;
  reason: string;                                   // ≤200，纳入该条目的原因
  provenance?: Provenance;                          // 内容来自仓库时必填
  toolCallId?: string;                              // role = 'tool' 时必填
  toolCalls?: ModelToolCall[];                      // role = 'assistant' 且为模型工具调用时必填
  toolSpecs?: ModelToolSpec[];                      // segment = 'TOOLS' 时必填
  score?: number;                                   // SEARCH_HIT 必填
}

interface Provenance {
  path: string;
  startLine: number;
  endLine: number;
  contentSha256: string;
  snapshotId?: string;
  retrieval: 'TREE' | 'TEXT' | 'PATH' | 'SYMBOL' | 'FILE_READ';
}

interface ModelToolSpec {                           // 由 Tool 定义与 Protocol Registry 生成
  name: string;                                     // Tool 的 modelName
  description: string;                              // Tool 的 modelDescription
  parameters: Record<string, unknown>;              // parametersContract 对应的 JSON Schema
  purpose: 'UNIT' | 'CONTROL';
}
```

ASSEMBLE 包的段顺序固定为 INSTRUCTIONS、TOOLS、OBJECTIVE、HANDOFF、ORIENT、HISTORY、STATUS。
INSTRUCTIONS、TOOLS、OBJECTIVE、HANDOFF、STATUS 不裁剪。超出预算时按以下顺序裁剪，直到不超出：

1. 从最早的 Round 开始，把 `TOOL_RESULT` 条目的正文替换为固定的省略说明（条目保留，说明正文因预算省略，可缩小范围重新执行）；
2. 移除 ORIENT 段；
3. 从最早的 Round 开始整轮移除 HISTORY：该 Round 的 assistant 条目、全部 tool 条目与其他 FEEDBACK 条目一起移除。

`droppedCount` 记录被省略正文或被移除的条目数，`elidedRequestIds` 记录受影响的 `TOOL_RESULT`。HISTORY 与 ORIENT 都可以裁剪至空，
因此只要不可裁剪段小于预算（启动校验见 [Monitor](Kernel/Monitor.md) 第 4 节），组装必然成功。
裁剪前后，每个 `MODEL_TURN` 中的 `toolCallId` 在 HISTORY 中都必须有一条对应的 `tool` 条目（来自 `TOOL_RESULT` 或带 `toolCallId` 的 `FEEDBACK`）。

token 估算由 contracts 统一提供（[SharedContracts](Library/SharedContracts.md) 4.3），上下文组装、预留与启动校验使用同一组函数：

- `estimateItemTokens(item)`：条目的 `role`、`content`、`toolCallId`、`toolCalls`、`toolSpecs` 组成的规范 JSON 的 UTF-8 字节数，加 16；
- `estimatePackTokens(pack)`：全部条目的 `estimateItemTokens` 之和。

BPE 类 tokenizer 的单个 token 至少覆盖一个字节，因此估算值不低于实际输入 token 数（provider 侧模板开销由每条 16 的固定开销覆盖，
超出时按结算异常处理）。

### 6.4 模型调用

```ts
interface ModelCallInput {                          // executor.ModelCallInput
  contextPackRef: ArtifactRef;                      // context-assemble 的产物
  final: boolean;                                   // 必须与生成该包的 ContextAssembleInput.final 相同；Execution 派发前核对
}

interface ModelCallOutput {                         // executor.ModelCallOutput
  finishReason: 'TOOL_CALLS' | 'STOP' | 'LENGTH' | 'CONTENT_FILTER' | 'OTHER';
  toolCalls: ModelToolCall[];                       // ≤32
  hasText: boolean;                                 // 模型是否返回了文本内容（正文在产物中）
}

interface ModelToolCall {
  toolCallId: string;
  toolName: string;                                 // 模型调用的工具名
  arguments: unknown | null;                        // 解析后的 JSON；无法解析时为 null
  argumentsError?: 'INVALID_JSON';                  // arguments 为 null 时必填
}

interface ModelRawOutput {                          // executor.ModelRawOutput，model-call 产物的内容
  provider: string;
  apiModelId: string;
  providerFinishReason: string;
  text?: string;
  toolCalls: { toolCallId: string; toolName: string; argumentsText: string }[];
  usage?: TokenUsage;
  receivedAt: string;
}
```

model-call Executor 只做结构映射，不解释工具的业务含义：工具名是否属于 Agent、参数是否合法、
控制工具代表 FINISH 还是 HANDOFF，均由 Workflow 判断（见 [Workflow](Module/Workflow.md) 第 5 节）。

### 6.5 报告发布

```ts
interface ReportPublishInput {                      // kernel.unit.ReportPublishInput
  report: AnalysisReport;
}

interface ReportPublishOutput {                     // kernel.unit.ReportPublishOutput
  conclusionCount: number;
  unconfirmedCount: number;
  degraded: boolean;
}
```

`report-publish` 是 Kernel 内建 Unit，由 Execution 直接完成，不派发给 Supervisor（见 [Execution](Kernel/Execution.md) 第 5 节）。

### 6.6 Workflow 提供的结构（`workflow.*`）

```ts
type StepRecord = ModelTurnStep | ToolResultStep | FeedbackStep;

interface ModelTurnStep {
  kind: 'MODEL_TURN';
  round: number;                                    // 该 AgentRun 内的 Round 序号，从 1 开始
  requestId: string;                                // 对应 model-call 的 requestId
  toolCalls: ModelToolCall[];
}

interface ToolResultStep {
  kind: 'TOOL_RESULT';
  round: number;
  requestId: string;                                // 对应工具 Unit 的 requestId
  toolCallId: string;
  toolName: string;
  status: 'OK' | 'REJECTED' | 'FAILED';
  reasonCode?: ReasonCode;                          // status 不为 OK 时必填
  output?: RepositorySearchOutput | FileReadOutput; // status 为 OK 时必填
  outputRef?: ArtifactRef;                          // status 为 OK 时必填
}

interface FeedbackStep {
  kind: 'FEEDBACK';
  round: number;
  code: FeedbackCode;
  toolCallId?: string;                              // 针对某个工具调用时必填
  message: string;                                  // ≤1000，给模型看的说明
}

type FeedbackCode =
  | 'INVALID_ACTION'          // 本轮返回无法形成合法动作
  | 'UNKNOWN_TOOL'            // 工具不属于该 Agent
  | 'INVALID_ARGUMENTS'       // 参数不符合 parametersContract
  | 'TOO_MANY_TOOL_CALLS'     // 超过 maxToolCallsPerRound 的部分
  | 'DUPLICATE_CALL'          // 本 AgentRun 已成功执行过相同调用
  | 'NOT_EXECUTED'            // 因额度进入 EXHAUSTED 而未执行
  | 'MODEL_CALL_FAILED'       // 上一次 model-call 失败，原因码见 message
  | 'WRAP_UP_NOTICE';         // 即将收尾的说明

interface StatusFacts {
  roundsUsed: number;
  maxRounds: number;
  final: boolean;
  budgetState: BudgetState;
  wrapUpReason?: WrapUpReason;
}

type WrapUpReason =
  | 'ROUND_LIMIT' | 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED'
  | 'USER_DECLINED' | 'NO_PROGRESS' | 'REGENERATION_LIMIT';

interface HandoffBrief {                            // handoff_to_code_viewer 工具的参数
  task: string;                                     // 1..2000，交给 CodeViewer 的分析任务
  focusAreas: string[];                             // ≤5，每项 ≤200
  openQuestions: string[];                          // ≤5，每项 ≤300
}

interface AnalysisReportDraft {                     // finish_analysis 工具的参数
  summary: string;                                  // 1..4000
  conclusions: DraftConclusion[];                   // ≤50
  unconfirmed: string[];                            // ≤50，每项 ≤1000
}

interface DraftConclusion {
  statement: string;                                // 1..2000
  sources: SourceRef[];                             // ≤20
}

interface SourceRef {
  path: string;
  startLine: number;
  endLine: number;
}

interface AnalysisReport {                          // report-publish 的输入，UserInteraction 读取后展示
  workflowRunId: string;
  goal: string;
  summary: string;
  conclusions: VerifiedConclusion[];
  unconfirmed: UnconfirmedItem[];
  readSources: VerifiedSource[];                    // 本运行全部读取成功的范围
  wrapUp?: { reason: WrapUpReason };                // 提前收尾时必填
  degraded: boolean;                                // 没有合法 FINISH 时为 true
  agentRounds: AgentRoundsEntry[];
  snapshotId?: string;
  createdAt: string;
}

interface VerifiedConclusion {
  statement: string;
  sources: VerifiedSource[];                        // ≥1
}

interface VerifiedSource {
  path: string;
  startLine: number;
  endLine: number;
  readRequestId: string;                            // 覆盖该范围的 file-read 的 requestId
  readContentSha256: string;                        // 该次 file-read 的 contentSha256
}

interface UnconfirmedItem {
  statement: string;
  reason: 'NO_SOURCE' | 'SOURCE_NOT_READ' | 'MODEL_UNCONFIRMED';
}

interface AgentRoundsEntry {
  agentId: string;
  agentRunId: string;
  roundsUsed: number;
  maxRounds: number;
}
```

## 7. Kernel 核心与 Supervisor

### 7.1 执行请求

```ts
type ExecutorKind = 'REPOSITORY_ORIENT' | 'REPOSITORY_SEARCH' | 'FILE_READ' | 'CONTEXT_ASSEMBLE' | 'MODEL';

interface ExecutionRequest {                        // kernel.execution.ExecutionRequest
  workflowRunId: string;
  unitAttemptId: string;
  executionId: string;
  runEpoch: number;
  executionKind: ExecutorKind;
  input: ExecutorInput;                             // 按 executionKind 选择第 7.2 节的类型
  scope: ExecutionScope;
  limits: ExecutionLimits;
  notBefore?: string;                               // 技术重试的退避时间，Supervisor 到点后才启动
}

type ExecutionScope =
  | { kind: 'REPOSITORY'; repositoryRoot: string; exclusions: string[] }      // 由 Lease 派生
  | { kind: 'MODEL'; provider: string; apiModelId: string;
      apiProtocol: 'OPENAI_CHAT_COMPLETIONS' | 'ANTHROPIC_MESSAGES'; baseUrl: string;
      thinking: 'DISABLED' | 'ENABLED'; thinkingEffort?: string }             // 由固定的 Model 与 Agent 定义派生
  | { kind: 'NONE' };

interface ExecutionLimits {
  deadline: string;                                 // (notBefore ?? 派发时间) + KernelConfig.executionLimits[kind].timeoutMs
  maxOutputBytes: number;
  maxOutputTokens?: number;                         // MODEL 必填
  maxFiles?: number;                                // REPOSITORY_ORIENT 必填
}
```

| executionKind | scope.kind |
|---|---|
| `REPOSITORY_ORIENT`、`REPOSITORY_SEARCH`、`FILE_READ` | `REPOSITORY` |
| `MODEL` | `MODEL` |
| `CONTEXT_ASSEMBLE` | `NONE` |

### 7.2 Executor 输入（Execution 解析后的输入）

```ts
type ExecutorInput =
  | OrientExecutorInput | SearchExecutorInput | FileReadInput
  | AssembleExecutorInput | ModelExecutorInput;

interface OrientExecutorInput {                     // kernel.execution.OrientExecutorInput
  objective: string;
  tokenBudget: number;                              // KernelConfig.budget.orientBudget
}

interface SearchExecutorInput {                     // kernel.execution.SearchExecutorInput
  query: string;
  mode: 'AUTO' | 'TEXT' | 'PATH' | 'SYMBOL';        // 已填入缺省值
  maxItems: number;                                 // 已填入缺省值
  tokenBudget: number;                              // KernelConfig.budget.searchBudget
}

interface AssembleExecutorInput {                   // kernel.execution.AssembleExecutorInput
  objective: string;
  final: boolean;
  tokenBudget: number;                              // final ? finalInputBudget : perCallInputLimit
  instructions: string;                             // 该 AgentRun 固定的 Prompt 正文
  toolSpecs: ModelToolSpec[];                       // final 时只含 finish 控制工具
  handoff?: HandoffBrief;
  orientPack?: ContextPack;
  history: ResolvedStep[];
  status: StatusFacts;
}

interface ResolvedStep {
  step: StepRecord;
  outputText?: string;                              // ToolResultStep.outputRef 解析后的正文
}

interface ModelExecutorInput {                      // kernel.execution.ModelExecutorInput
  contextPack: ContextPack;                         // contextPackRef 解析后的 ASSEMBLE 包
  final: boolean;                                   // true 时只提供并强制调用唯一的控制工具
}
```

Kernel 核心与 Supervisor 之间按可序列化值传递已解析的内容，这是“大对象以 ArtifactRef 引用”规则的例外之一：
Executor 不持有 ArtifactStore 句柄，输入与输出的正文只能随执行请求与执行事实传递，大小受 `ExecutionLimits` 约束。
全部例外只有三处：本节的执行请求与执行事实；`ReportPublishInput.report`（报告发布前还没有引用，大小受 `maxReportBytes` 约束）；
`ArtifactContent.text`（产物读取本身的响应）。

### 7.3 执行事实

```ts
interface ExecutionFact {                           // kernel.execution.ExecutionFact；每个 executionId 恰好一个
  workflowRunId: string;
  unitAttemptId: string;
  executionId: string;
  runEpoch: number;                                 // 原样带回
  executionKind: ExecutorKind;                      // 与所回答的 ExecutionRequest 相同
  outcome: ExecutionOutcome;
  reasonCode?: ReasonCode;                          // outcome 不为 COMPLETED 时必填
  retryable?: boolean;                              // outcome 为 FAILED 时必填
  result?: ExecutionResult;                         // outcome 为 COMPLETED 时必填
  usage?: TokenUsage;                               // MODEL 且 requestState 为 SENT 时尽量提供
  requestState?: RequestState;                      // MODEL 必填
  startedAt?: string;                               // 未启动即被取消时为空
  endedAt: string;
}

type ExecutionOutcome =
  | 'COMPLETED' | 'REJECTED' | 'FAILED' | 'TERMINATED' | 'VIOLATION' | 'STOP_UNCONFIRMED';

type RequestState =
  | 'NOT_SENT'                                      // 请求未发出，或 provider 明确拒绝处理；不产生消耗
  | 'SENT'                                          // provider 已处理，用量以 usage 为准
  | 'UNKNOWN';                                      // 无法确认 provider 是否处理

interface ExecutionResult {
  output: UnitOutput;                               // 按 executionKind 校验
  artifact: { mediaType: string; text: string };    // 必填；由 Execution 写入 ArtifactStore，生成 outputRef
}

interface TokenUsage {                              // executor.TokenUsage
  inputTokens: number;
  outputTokens: number;
  inputCacheHitTokens?: number;
}
```

| outcome | reasonCode |
|---|---|
| `REJECTED` | `OUT_OF_SCOPE`、`NOT_FOUND`、`UNSUPPORTED_FILE`、`INVALID_RANGE`、`INVALID_QUERY`、`LIMIT_EXCEEDED` |
| `FAILED` | `PROVIDER_UNREACHABLE`、`PROVIDER_RATE_LIMITED`、`PROVIDER_AUTH`、`PROVIDER_ERROR`、`INTERNAL` |
| `TERMINATED`、`STOP_UNCONFIRMED` | `UNIT_TIMEOUT`、`EXECUTION_CANCELLED` |
| `VIOLATION` | `SCOPE_MISSING`、`PATH_ESCAPE`、`GUARD_FAILURE` |

### 7.4 端口

```ts
interface SupervisorPort {                          // 由 Supervisor 实现
  execute(request: ExecutionRequest): Promise<void>;                          // 受理即返回
  cancelRun(request: CancelRunExecutionsRequest): Promise<void>;              // 取消该运行全部在途执行
  shutdown(request: SupervisorShutdownRequest): Promise<void>;                // 开始系统关闭
}

interface CancelRunExecutionsRequest {              // kernel.execution.CancelRunExecutionsRequest
  workflowRunId: string;
  runEpoch: number;                                 // 收敛开始后的 runEpoch；runEpoch 小于它的执行一律取消
}

interface SupervisorShutdownRequest {               // kernel.execution.SupervisorShutdownRequest
  requestId: string;                                // 触发关闭的 ShutdownRequest.requestId
}

interface ExecutionFactSink {                       // 由 Kernel 核心实现
  report(fact: ExecutionFact): Promise<void>;       // 返回表示已进入所属运行的运行 Inbox
}
```

### 7.5 Gateway 与 Kernel 核心

```ts
type GatewayForward =                               // kernel.control.GatewayForward
  | { caller: 'workflow'; requestType: 'registerAgentRun'; request: RegisterAgentRunRequest }
  | { caller: 'workflow'; requestType: 'submitUnit'; request: SubmitUnitRequest }
  | { caller: 'workflow'; requestType: 'endAgentRun'; request: EndAgentRunRequest }
  | { caller: 'workflow'; requestType: 'closeRun'; request: CloseRunRequest }
  | { caller: 'user-interaction'; requestType: 'createRun'; request: CreateRunRequest; workflowRunId: string }
  | { caller: 'user-interaction'; requestType: 'answerAuthorization'; request: AnswerAuthorizationRequest }
  | { caller: 'user-interaction'; requestType: 'cancelRun'; request: CancelRunRequest }
  | { caller: 'user-interaction'; requestType: 'readArtifact'; request: ReadArtifactRequest }
  | { caller: 'user-interaction'; requestType: 'shutdown'; request: ShutdownRequest };
// 响应类型与第 4 节对应请求的响应相同

interface AdmissionProjection {                     // kernel.control.AdmissionProjection
  workflowRunId: string;
  runState: 'RUNNING' | 'CONVERGING' | 'CLOSED';
  closeReason?: CloseReason;                        // runState 不为 RUNNING 时必填
}
```

`createRun` 的 `workflowRunId` 由 Gateway 生成并随转发给出。

## 8. ExecutorSet 接口

```ts
interface Executor<K extends ExecutorKind> {        // 由 ExecutorSet 实现，Supervisor 调用
  readonly executionKind: K;
  execute(input: ExecutorInputByKind[K], environment: ExecutorEnvironment): Promise<ExecutorOutcome>;
}

interface ExecutorInputByKind {
  REPOSITORY_ORIENT: OrientExecutorInput;
  REPOSITORY_SEARCH: SearchExecutorInput;
  FILE_READ: FileReadInput;
  CONTEXT_ASSEMBLE: AssembleExecutorInput;
  MODEL: ModelExecutorInput;
}

interface ExecutorEnvironment {
  scope: ExecutionScope;
  limits: ExecutionLimits;
  signal: AbortSignal;                              // 截止时间到达或运行取消时触发
  subprocess: SubprocessRunner;                     // 只有 REPOSITORY_SEARCH 使用
  credentials: ProviderCredentials;                 // 只有 MODEL 使用
  now(): Date;
}

type ExecutorOutcome =                              // reasonCode 只取第 7.3 节表中该 outcome 的原因码
  | { outcome: 'COMPLETED'; result: ExecutionResult; usage?: TokenUsage; requestState?: RequestState }
  | { outcome: 'REJECTED'; reasonCode: ReasonCode }
  | { outcome: 'FAILED'; reasonCode: ReasonCode; retryable: boolean; usage?: TokenUsage; requestState?: RequestState }
  | { outcome: 'VIOLATION'; reasonCode: 'SCOPE_MISSING' | 'PATH_ESCAPE' | 'GUARD_FAILURE' };

interface SubprocessRunner {
  run(command: 'rg', args: string[], options: { cwd: string; signal: AbortSignal; maxOutputBytes: number }):
    Promise<{ exitCode: number | null; signal: string | null; stdout: string; truncated: boolean }>;
}

interface ProviderCredentials {
  apiKeyFor(provider: string): string | undefined;
}
```

`TERMINATED` 与 `STOP_UNCONFIRMED` 由 Supervisor 依据执行是否在宽限期内结束给出，Executor 不返回这两种结果。
`ExecutorOutcome` 不带 `executionKind`：Supervisor 组装 ExecutionFact 时填入请求的 `executionKind`；
对 `MODEL` 执行，Executor 没有给出 `requestState` 时填 `UNKNOWN`，对其他种类则丢弃 `usage` 与 `requestState`。

```ts
type ExecutorRegistry = { [K in ExecutorKind]: Executor<K> };   // createExecutorRegistry() 的返回值
```

注册表是按 `executionKind` 索引的对象而不是 Map：缺少任何一种 Executor 都无法通过编译，
`registry.FILE_READ.execute` 的输入类型也随之确定。

## 9. AgentToolPool（`catalog.*`）

### 9.1 引用

```ts
interface DefinitionRef {                           // 定义文件内书写的引用；digest 不手写
  id: string;                                       // 小写 kebab-case，≤64
  version: string;                                  // v<major>.<minor>.<patch>
}

interface PinnedDefinitionRef {                     // 跨模块传递的完整引用
  kind: 'AGENT' | 'UNIT' | 'TOOL' | 'MODEL' | 'PROMPT';
  id: string;
  version: string;
  digest: string;                                   // 64 位小写十六进制
}

interface ContractRef {                             // 指向 Protocol Registry 中的 Schema
  kind: 'contract';
  id: string;                                       // 如 'executor.FileReadInput'
  version: string;                                  // 如 'v0'
}
```

### 9.2 定义

```ts
interface DefinitionHeader<K> {
  schemaVersion: 'v0';
  kind: K;
  id: string;
  version: string;
  digest: string;                                   // 草稿文件不写，加载时计算
  description: string;                              // ≤2000
}

interface AgentDefinition extends DefinitionHeader<'AGENT'> {
  role: string;                                     // ≤200
  modelRef: DefinitionRef;
  modelSettings: { thinking: 'DISABLED' | 'ENABLED'; thinkingEffort?: string };
  promptRef: DefinitionRef;
  unitRefs: DefinitionRef[];                        // ≥1，封闭集合
  startUnitRefs: DefinitionRef[];                   // ⊆ unitRefs，每个 AgentRun 开始时按顺序提交
  actions: {
    finish: { toolRef: DefinitionRef };                                       // purpose = CONTROL
    handoff?: { toolRef: DefinitionRef; targetAgentRef: DefinitionRef };      // purpose = CONTROL
  };
  limits: { maxRounds: number /* 1..100 */; maxToolCallsPerRound: number /* 0..32 */ };
}

interface UnitDefinition extends DefinitionHeader<'UNIT'> {
  executionKind: ExecutionKind;
  protectedCapabilities: ProtectedCapability[];     // M1 只有 'repo.read'
  inputContract: ContractRef;
  outputContract: ContractRef;
  toolRefs: DefinitionRef[];                        // 0 或 1 个 purpose = UNIT 的 Tool
  effect: 'READ_ONLY' | 'WORKSPACE_WRITE' | 'EXTERNAL';
  isIdempotent: boolean;
  failurePolicy: FailurePolicy;
}

type ProtectedCapability = 'repo.read';
type FailurePolicy = { [code in ReasonCode]?: FailureHandling };  // 未列出的原因码按 FATAL 处理
type FailureHandling = 'RETURN_TO_MODEL' | 'FINAL_CALL' | 'DEGRADED_REPORT' | 'FATAL';

interface ToolDefinition extends DefinitionHeader<'TOOL'> {
  purpose: 'UNIT' | 'CONTROL';                      // UNIT 映射到 Unit；CONTROL 表达 FINISH 或 HANDOFF
  modelName: string;                                // 匹配 ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$
  modelDescription: string;                         // ≤4000
  parametersContract: ContractRef;                  // UNIT：等于所属 Unit 的 inputContract
  riskClass: 'READ_ONLY' | 'LOW' | 'MEDIUM' | 'HIGH';
  sideEffect: 'NONE' | 'WORKSPACE_WRITE' | 'EXTERNAL';
  isIdempotent: boolean;
  contentStatus: 'PLACEHOLDER' | 'FINAL';
}

interface ModelDefinition extends DefinitionHeader<'MODEL'> {
  provider: string;
  apiModelId: string;
  providerModelLabel: string;
  apiProtocol: 'OPENAI_CHAT_COMPLETIONS' | 'ANTHROPIC_MESSAGES';
  baseUrl: string;                                  // https://
  limits: { contextWindowTokens: number; maxOutputTokens: number };
  features: {
    hasJsonOutput: boolean;
    hasToolCalls: boolean;
    hasVision: boolean;
    thinking: { isSupported: boolean; isEnabledByDefault: boolean; effortLevels: string[] };
  };
  pricing: {
    currency: 'USD';
    unit: 'MICRO_USD_PER_MILLION_TOKENS';
    offPeak: { inputCacheHit: number; inputCacheMiss: number; output: number };
    peak: { ratePercent: number; timeZone: 'UTC'; weekdays: number[]; windows: { start: string; end: string }[] };
    source: { url: string; verifiedOn: string };
  };
}

interface PromptDefinition extends DefinitionHeader<'PROMPT'> {
  role: 'system';
  template: string;                                 // ≤100000，字节稳定，作为缓存前缀
  variables: { name: string; description: string }[];   // M1 的 Prompt 不使用变量，为空数组
  contentStatus: 'PLACEHOLDER' | 'FINAL';
}

type Definition = AgentDefinition | UnitDefinition | ToolDefinition | ModelDefinition | PromptDefinition;

type DefinitionStatus = 'ACTIVE' | 'DEPRECATED' | 'QUARANTINED' | 'REVOKED';

interface DefinitionStatusFile {                    // definitions/status.yaml
  schemaVersion: 'v0';
  entries: { kind: DefinitionKind; id: string; version: string; status: DefinitionStatus; reason: string }[];
}
```

### 9.3 查找与固定

```ts
interface CatalogPort {                             // 由 AgentToolPool 实现；返回值深冻结
  getDefinition<K extends DefinitionKind>(lookup: DefinitionLookup & { kind: K }, context: BoundaryContext):
    Promise<PortResult<DefinitionByKind[K]>>;
  pinAgent(request: AgentPinRequest, context: BoundaryContext): Promise<PortResult<PinnedDefinitionSet>>;
  capabilities(): readonly CapabilityDescriptor[];
}

type DefinitionKind = 'AGENT' | 'UNIT' | 'TOOL' | 'MODEL' | 'PROMPT';

interface DefinitionByKind {
  AGENT: AgentDefinition;
  UNIT: UnitDefinition;
  TOOL: ToolDefinition;
  MODEL: ModelDefinition;
  PROMPT: PromptDefinition;
}

interface DefinitionLookup { kind: DefinitionKind; id: string; version: string }
interface AgentPinRequest { id: string; version: string }

interface PinnedDefinitionSet {
  schemaVersion: 'v0';
  agent: AgentDefinition;
  model: ModelDefinition;
  prompt: PromptDefinition;
  units: UnitDefinition[];                          // agent.unitRefs 的全部 Unit
  tools: ToolDefinition[];                          // 这些 Unit 的 Tool 与 agent.actions 的控制工具
  handoffTargetRef?: PinnedDefinitionRef;           // agent.actions.handoff 存在时必填
  refs: PinnedDefinitionRef[];                      // 以上全部成员，按 kind、id、version 排序
}
```

`CatalogPort` 的错误码：`CATALOG_LOOKUP_INVALID`、`CATALOG_DEFINITION_NOT_FOUND`、`CATALOG_VERSION_NOT_FOUND`、
`CATALOG_DEFINITION_UNAVAILABLE`。Workflow 与 Core 各自调用 `pinAgent`，二者得到的 digest 必然相同。

## 10. 平台 Port

```ts
interface ArtifactStorePort {                       // 只注入 Kernel 核心，由 Execution 使用
  put(workflowRunId: string, content: Uint8Array, mediaType: string): Promise<ArtifactRef>;
  get(workflowRunId: string, ref: ArtifactRef): Promise<Uint8Array>;   // 复验 sha256 与 size
  capabilities(): readonly CapabilityDescriptor[];
}

interface PersistencePort {
  repository<T extends { id: string }>(namespace: PersistenceNamespace, workflowRunId: string): RepositoryPort<T>;
  auditLog<T>(namespace: PersistenceNamespace, workflowRunId: string): AuditLogPort<T>;
}

type PersistenceNamespace = 'workflow' | 'kernel-core';

interface RepositoryPort<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(record: T): Promise<void>;                    // 临时文件后原子 rename
}

interface AuditLogPort<T> {
  append(entry: T): Promise<void>;                  // 追加一行 JSON
}

interface FabricPort {                              // 每个通讯主体一个客户端
  register<TRequest, TResponse>(schemaName: string,
    handler: (envelope: Envelope<TRequest>) => Promise<TResponse>): void;
  request<TRequest, TResponse>(schemaName: string, payload: TRequest, context: BoundaryContext): Promise<TResponse>;
  send<T>(address: FabricAddress, schemaName: string, payload: T, context: BoundaryContext): Promise<void>;
  subscribe<T>(address: FabricAddress, handler: (envelope: Envelope<T>) => Promise<void>): void;
  capabilities(): readonly CapabilityDescriptor[];
}

type FabricAddress = 'inbox.workflow' | 'inbox.user-interaction' | 'gateway.admission' | 'kernel-core.execution-facts';

interface LifecyclePort {
  manifest: { moduleId: ModuleId; version: string; dependencies: ModuleId[] };
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<HealthStatus>;
}

type ModuleId =
  | 'fabric' | 'artifact-store' | 'persistence' | 'supervisor'
  | 'kernel-core' | 'gateway' | 'workflow' | 'user-interaction';

interface HealthStatus {
  status: 'UP' | 'DOWN' | 'DEGRADED';
  checkedAt: string;
  details: string[];
}
```

M1 的存储布局见 [Persistence](Infrastructure/Persistence.md) 与 [ArtifactStore](Infrastructure/ArtifactStore.md)。

`FabricPort` 各方法的 `schemaName` 参数传完整的 Schema ID（如 `kernel.unit.SubmitUnitRequest.v0`），
Fabric 据此取得 Schema，并拆出 `Envelope.schemaName` 与 `Envelope.schemaVersion`。
`PersistencePort` 与其他平台 Port 一样提供 `capabilities()`。

## 11. RunSummary

```ts
interface RunSummary {                              // kernel.control.RunSummary；由 Execution 写成产物
  workflowRunId: string;
  closeReason: CloseReason;
  failure?: RunFailure;
  reportRef?: ArtifactRef;
  startedAt: string;
  closedAt: string;
  durationMs: number;
  agentRuns: { agentRunId: string; agentRef: PinnedDefinitionRef; registeredAt: string; endedAt: string;
               rounds: number }[];                 // rounds：已交付的 OK 或 FAILED 的 model-call UnitReport 数
  units: { submitted: number; ok: number; rejected: number; failed: number; notDelivered: number };
  model: { requests: number; finalCallUsed: boolean };
  tokens: { limit: number; used: number; unknown: number; inputTokens: number; outputTokens: number;
            finalBudgetState: BudgetState };
  unknownEffects: UnknownEffect[];
}
```

`units` 由 Core 统计：`submitted` 为得到 SyscallAck 的 submitUnit；`ok`、`rejected`、`failed` 为已交付 UnitReport 的状态，
含建立尝试之前交付的 `USER_DECLINED`；`notDelivered` 为随 RunClosed 结束、没有 UnitReport 的 Unit（含授权挂起中的请求）。
步骤数（StepRecord）属于 Workflow 的运行记录，不在 RunSummary 中。

## 12. 协议注册表

| Family | Owner | M1 Schema | M1 行为 |
|---|---|---|---|
| `platform.common` | contracts | BoundaryContext、Envelope、ArtifactRef、ModuleError、CapabilityDescriptor、ErrorCategory、ReasonCode、ExecutionKind | 完整校验 |
| `platform.config` | contracts | KernelConfig、WorkflowConfig、SystemConfig | 完整校验（第 14.3 节） |
| `kernel.control` | kernel | CreateRunRequest、AnswerAuthorizationRequest、CancelRunRequest、ReadArtifactRequest、ShutdownRequest、SyscallAck、SyscallRejected、RunCreated、ArtifactContent、InteractionInboxEvent、AuthorizationRequest、AuthorizationResolved、RunFinished、RunFailure、UnknownEffect、CloseReason、RunSummary、GatewayForward、AdmissionProjection | 完整校验 |
| `kernel.unit` | kernel | RegisterAgentRunRequest、SubmitUnitRequest、EndAgentRunRequest、CloseRunRequest、WorkflowInboxEvent、RunStart、UnitReport、RunClosed、BudgetState、UnitInput、UnitOutput、ReportPublishInput、ReportPublishOutput | 完整校验 |
| `kernel.execution` | kernel | ExecutionRequest、ExecutionScope、ExecutionLimits、OrientExecutorInput、SearchExecutorInput、AssembleExecutorInput、ModelExecutorInput、ExecutionFact、ExecutionResult、CancelRunExecutionsRequest、SupervisorShutdownRequest | 完整校验 |
| `context` | executor-set | RepositoryOrientInput、RepositoryOrientOutput、RepositorySearchInput、RepositorySearchOutput、ContextAssembleInput、ContextAssembleOutput、ContextPack、ModelToolSpec | 完整校验 |
| `executor` | executor-set | FileReadInput、FileReadOutput、ModelCallInput、ModelCallOutput、ModelToolCall、ModelRawOutput、TokenUsage | 完整校验 |
| `workflow` | workflow | StepRecord、StatusFacts、HandoffBrief、AnalysisReportDraft、AnalysisReport | 完整校验 |
| `catalog` | agent-tool-pool | DefinitionKind、DefinitionRef、PinnedDefinitionRef、ContractRef、AgentDefinition、UnitDefinition、ToolDefinition、ModelDefinition、PromptDefinition、Definition、DefinitionStatus、DefinitionLookup、AgentPinRequest、PinnedDefinitionSet、DefinitionStatusFile | 完整校验 |
| `platform.fabric` | fabric | 能力描述 | 同进程路由；跨进程与可靠投递 Unsupported |
| `platform.lifecycle` | module-host | 能力描述 | 完整支持 |
| `platform.persistence` | persistence | 能力描述 | 运行目录文件存储；事务、Journal Unsupported |
| `platform.artifact` | artifacts | 能力描述 | 本地内容寻址存储 |
| `interaction` | user-interaction | 无 | M1 无跨边界 Schema |
| `checkpoint`、`restore`、`review`、`integration` | 对应 owner | 仅 opaque Ref | Unsupported |

Registry 必须拒绝重复的 `schemaName@major` 与未知 major。未支持的协议只定义 owner、opaque Ref 与明确错误，不冻结未经使用验证的 payload。
每个 Schema 的 ID 与文件位置见 [SharedContracts](Library/SharedContracts.md)。

## 13. 身份链、不可变性与测试

```text
WorkflowRun (wfr) → AgentRun (agr) → submitUnit (req) → UnitAttempt (una) → Execution (exe) → ArtifactRef (art)
Core Outbox → InboxEvent (evt)
```

M1 不实现 WorkSession、SessionTree、TaskGraph、MissionScope 与 TaskAttempt 等长期概念；单活动 Task 由 WorkflowRun 直接承载。

ContextPack、UnitReport、InboxEvent、ExecutionFact、Catalog Definition、AnalysisReport、RunSummary 与 ArtifactRef 发布后不可修改。
每个 Port 必须提供共享 contract test，至少覆盖合法值、额外字段、错误映射、未知 major、不可变输出、
Unsupported 无副作用以及 fake 与真实 adapter 的一致性。

## 14. 模块装配接口

本节规定各模块对组合根（`apps/control-plane`）暴露的工厂函数及其依赖。它们是并行开发的接缝：
各模块只替换自己工厂的实现，签名的修改必须单独评审，并同步 `packages/testing` 中的 fake。
工厂只构造，不启动；启动与停止由 Supervisor 驱动 ModuleHost 完成（[ModuleHost](Infrastructure/ModuleHost.md) 第 2 节）。

### 14.1 Kernel

```ts
function createGateway(deps: GatewayDeps): LifecyclePort;
function createKernelCore(deps: KernelCoreDeps): LifecyclePort;
function createSupervisor(deps: SupervisorDeps): SupervisorModule;

interface GatewayDeps {
  fabric: FabricPort;                               // producer 为 gateway 的客户端
  now?: () => Date;
}

interface KernelCoreDeps {
  fabric: FabricPort;                               // producer 为 kernel-core 的客户端
  catalog: CatalogPort;
  artifacts: ArtifactStorePort;                     // 只由 Execution 使用
  persistence: PersistencePort;                     // Core 取用 kernel-core 命名空间
  registry: ProtocolRegistry;
  config: KernelConfig;
  dataDir: string;
  now?: () => Date;
}

interface SupervisorDeps {
  fabric: FabricPort;                               // producer 为 supervisor 的客户端
  executors: ExecutorRegistry;
  credentials: ProviderCredentials;
  moduleHost: ModuleHostControl;
  config: KernelConfig;
  dataDir: string;                                  // 启动时清空 <dataDir>/tmp/
  now?: () => Date;
}

interface ModuleHostControl {                       // Supervisor 驱动 ModuleHost 的部分
  start(): Promise<void>;                           // 按依赖启动其余全部模块
  stop(): Promise<void>;                            // 按相反顺序停止
}

interface SupervisorModule extends LifecyclePort {
  whenStopped(): Promise<void>;                     // shutdown 请求使全部模块停止后完成
}
```

组合根只调用 `supervisor.start()`，并在 `whenStopped()` 完成后以 UserInteraction 给出的退出码退出进程。

### 14.2 Workflow 与 UserInteraction

```ts
function createWorkflow(deps: WorkflowDeps): WorkflowModule;
function createUserInteraction(deps: UserInteractionDeps): UserInteractionModule;

interface WorkflowDeps {
  gateway: WorkflowGatewayPort;
  catalog: CatalogPort;
  persistence: PersistencePort;                     // Workflow 取用 workflow 命名空间
  registry: ProtocolRegistry;                       // 按 parametersContract 校验工具参数
  config: WorkflowConfig;
  now?: () => Date;
}

interface WorkflowModule extends LifecyclePort {
  inbox: WorkflowInboxPort;                         // 组合根把它接到地址 inbox.workflow
}

interface UserInteractionDeps {
  gateway: InteractionGatewayPort;
  terminal: TerminalPort;
  now?: () => Date;
}

interface UserInteractionModule extends LifecyclePort {
  inbox: InteractionInboxPort;                      // 组合根把它接到地址 inbox.user-interaction
  analyze(command: AnalyzeCommand): Promise<number>;   // 运行一个目标直到结束，返回进程退出码
}

interface AnalyzeCommand {
  goal: string;
  repositoryPath: string;                           // 绝对路径
  details: boolean;                                 // 是否额外展示 RunSummary
}

interface TerminalPort {                            // 由 apps/cli 实现
  write(text: string): void;
  askYesNo(question: string, signal: AbortSignal): Promise<'YES' | 'NO' | undefined>;
  onInterrupt(handler: () => void): () => void;     // 返回值用于取消注册
}
```

`askYesNo` 在 `signal` 触发时以 `undefined` 结束并停止读取，使询问任务不阻塞 Inbox 的处理
（[UserInteraction](Module/UserInteraction.md) 第 4 节）。`analyze` 在展示完成并请求 `shutdown` 后返回，不退出进程。

### 14.3 系统配置（`platform.config`）

```ts
interface SystemConfig {                            // platform.config.SystemConfig
  dataDir: string;                                  // 绝对路径
  kernel: KernelConfig;                             // platform.config.KernelConfig
  workflow: WorkflowConfig;                         // platform.config.WorkflowConfig
}
```

`KernelConfig` 的字段见 [Kernel/Interaction](Kernel/Interaction.md) 第 9 节与 [Monitor](Kernel/Monitor.md) 第 4 节，
`WorkflowConfig` 的字段见 [Workflow](Module/Workflow.md) 第 12 节。组合根的读取与校验见 [M1TechStack](M1TechStack.md) 第 4 节。

### 14.4 组合根

```ts
interface SystemParts {                             // 非基础设施部分的工厂，缺省为各产品包的导出
  createGateway(deps: GatewayDeps): LifecyclePort;
  createKernelCore(deps: KernelCoreDeps): LifecyclePort;
  createSupervisor(deps: SupervisorDeps): SupervisorModule;
  createWorkflow(deps: WorkflowDeps): WorkflowModule;
  createUserInteraction(deps: UserInteractionDeps): UserInteractionModule;
  createExecutorRegistry(): ExecutorRegistry;
}

function composeSystem(options: {
  config: SystemConfig;
  terminal: TerminalPort;
  credentials: ProviderCredentials;
  parts?: Partial<SystemParts>;                     // 测试用 fake 替换其中任意几项
  catalog?: CatalogPort;                            // 缺省为仓库内的定义目录
  now?: () => Date;
}): Promise<System>;
```

尚未实现的产品工厂在被调用时抛出 `NOT_IMPLEMENTED`，不返回占位的成功结果。
`packages/testing` 为每个工厂提供 fake，为 `CatalogPort` 与 `Executor` 提供共享 contract test；
fake 只保证消息的形状与先后顺序符合本文，不实现任何权限、额度或业务逻辑。
