# MultiAgentOS M1 SharedContracts

## 1. 定位

SharedContracts 是静态库 `@multiagentos/contracts`（`packages/libraries/contracts`），提供 M1 全部跨模块 Schema、
由 Schema 派生的 TypeScript 类型、Port 接口、Protocol Registry 与校验工具。它不运行服务，不保存状态。
长期规划见 [SharedContracts 架构](../../Architecture/Library/SharedContracts.md)。

字段与语义以 [M1Interface](../M1Interface.md) 为准。本文规定每个类型落在哪个 Schema ID、哪个文件、由谁负责，
以及对应的测试。

## 2. 规则

- Schema 使用 TypeBox 定义，`$id` 为 `<family>.<Name>.v<major>`，M1 的 major 全部为 0（见 M1Interface 1.2）。
- 运行时校验使用 TypeBox 自带的编译器（`typebox/compile`），每个 Schema 只编译一次；不引入第二个校验库。
- 条件必填的字段以联合变体表达（M1Interface 1.3）；跨字段的相等或大小关系以 `Type.Refine` 表达。
  M1Interface 1.4 列出的每条约束都必须由 Schema 强制，并在 `kernel-protocol.test.ts` 中有反例。
- 约束收紧而 TypeScript 类型不变的字段，使用 `artifactRefOf(mediaType)`、`pinnedRefOf(kind)` 与
  `reasonCodeOf(codes)` 构造：Schema 只接受指定的媒体类型、定义种类或原因码集合。
- TypeScript 类型一律由 Schema 派生（`Static<typeof XSchema>`），发布值使用 `DeepReadonly`。
- 跨两个以上 family 使用、或作为消息 payload 的类型注册为顶层 Schema；只在一个 Schema 内部使用的结构作为嵌套类型，
  与父 Schema 放在同一文件，不单独注册。
- 文件之间不得形成导入环。按第 5 节的顺序，后面的文件只能导入前面的文件。
- `catalog/definition-schemas.ts` 只导入 `platform-common/`，不导入其他 family。
- 其他 workspace 不得建立第二套公共 Schema，也不得只靠 TypeScript interface 通过边界。

## 3. Schema 清单

“节”指 [M1Interface](../M1Interface.md) 中的章节。

### 3.1 `platform.common`

| Schema ID | 嵌套类型 | 文件 | 节 |
|---|---|---|---|
| `platform.common.BoundaryContext.v0` | — | `platform-common/common-schemas.ts` | 3.2 |
| `platform.common.Envelope.v0` | — | `platform-common/common-schemas.ts` | 3.2 |
| `platform.common.ArtifactRef.v0` | — | `platform-common/common-schemas.ts` | 3.3 |
| `platform.common.ErrorCategory.v0` | — | `platform-common/common-schemas.ts` | 3.3 |
| `platform.common.ModuleError.v0` | — | `platform-common/common-schemas.ts` | 3.3 |
| `platform.common.CapabilityDescriptor.v0` | — | `platform-common/common-schemas.ts` | 3.3 |
| `platform.common.ReasonCode.v0` | — | `platform-common/reason-code.ts` | 3.4 |
| `platform.common.ExecutionKind.v0` | — | `platform-common/execution-kind.ts` | 6.1 |

### 3.2 `executor`

| Schema ID | 嵌套类型 | 文件 | 节 |
|---|---|---|---|
| `executor.ModelToolCall.v0` | — | `executor/model-tool-call.ts` | 6.4 |
| `executor.FileReadInput.v0` | — | `executor/file-read.ts` | 6.2 |
| `executor.FileReadOutput.v0` | — | `executor/file-read.ts` | 6.2 |
| `executor.TokenUsage.v0` | — | `executor/model-call.ts` | 7.3 |
| `executor.ModelCallInput.v0` | — | `executor/model-call.ts` | 6.4 |
| `executor.ModelCallOutput.v0` | — | `executor/model-call.ts` | 6.4 |
| `executor.ModelRawOutput.v0` | — | `executor/model-call.ts` | 6.4 |

### 3.3 `context`

| Schema ID | 嵌套类型 | 文件 | 节 |
|---|---|---|---|
| `context.ModelToolSpec.v0` | — | `context/context-pack.ts` | 6.3 |
| `context.ContextPack.v0` | ContextItem、Provenance | `context/context-pack.ts` | 6.3 |
| `context.RepositoryOrientInput.v0` | — | `context/repository.ts` | 6.2 |
| `context.RepositoryOrientOutput.v0` | — | `context/repository.ts` | 6.2 |
| `context.RepositorySearchInput.v0` | — | `context/repository.ts` | 6.2 |
| `context.RepositorySearchOutput.v0` | SearchHit | `context/repository.ts` | 6.2 |
| `context.ContextAssembleInput.v0` | — | `context/assemble.ts` | 6.3 |
| `context.ContextAssembleOutput.v0` | — | `context/assemble.ts` | 6.3 |

### 3.4 `workflow`

| Schema ID | 嵌套类型 | 文件 | 节 |
|---|---|---|---|
| `workflow.StepRecord.v0` | ModelTurnStep、ToolResultStep、FeedbackStep、FeedbackCode | `workflow/step-record.ts` | 6.6 |
| `workflow.StatusFacts.v0` | WrapUpReason | `workflow/step-record.ts` | 6.6 |
| `workflow.HandoffBrief.v0` | — | `workflow/handoff.ts` | 6.6 |
| `workflow.AnalysisReportDraft.v0` | DraftConclusion、SourceRef | `workflow/report.ts` | 6.6 |
| `workflow.AnalysisReport.v0` | VerifiedConclusion、VerifiedSource、UnconfirmedItem、AgentRoundsEntry | `workflow/report.ts` | 6.6 |

`WrapUpReason` 与 `AnalysisReport.wrapUp` 共用 `workflow/step-record.ts` 中的定义。

### 3.5 `catalog`

| Schema ID | 嵌套类型 | 文件 | 节 |
|---|---|---|---|
| `catalog.DefinitionKind.v0` | — | `catalog/definition-schemas.ts` | 9.3 |
| `catalog.DefinitionRef.v0` | — | `catalog/definition-schemas.ts` | 9.1 |
| `catalog.PinnedDefinitionRef.v0` | — | `catalog/definition-schemas.ts` | 9.1 |
| `catalog.ContractRef.v0` | — | `catalog/definition-schemas.ts` | 9.1 |
| `catalog.AgentDefinition.v0` | modelSettings、actions、limits | `catalog/definition-schemas.ts` | 9.2 |
| `catalog.UnitDefinition.v0` | ProtectedCapability、FailurePolicy、FailureHandling | `catalog/definition-schemas.ts` | 9.2 |
| `catalog.ToolDefinition.v0` | — | `catalog/definition-schemas.ts` | 9.2 |
| `catalog.ModelDefinition.v0` | limits、features、pricing | `catalog/definition-schemas.ts` | 9.2 |
| `catalog.PromptDefinition.v0` | variables | `catalog/definition-schemas.ts` | 9.2 |
| `catalog.Definition.v0` | — | `catalog/definition-schemas.ts` | 9.2 |
| `catalog.DefinitionStatus.v0` | — | `catalog/definition-schemas.ts` | 9.2 |
| `catalog.DefinitionLookup.v0` | — | `catalog/catalog-schemas.ts` | 9.3 |
| `catalog.AgentPinRequest.v0` | — | `catalog/catalog-schemas.ts` | 9.3 |
| `catalog.PinnedDefinitionSet.v0` | — | `catalog/catalog-schemas.ts` | 9.3 |
| `catalog.DefinitionStatusFile.v0` | entries | `catalog/catalog-schemas.ts` | 9.2 |

`catalog/catalog-schemas.ts` 同时导出常量 `CATALOG_ERROR_CODES`。

### 3.6 `kernel.control`

| Schema ID | 嵌套类型 | 文件 | 节 |
|---|---|---|---|
| `kernel.control.CloseReason.v0` | — | `kernel-control/run-outcome.ts` | 5.2 |
| `kernel.control.RunFailure.v0` | — | `kernel-control/run-outcome.ts` | 5.4 |
| `kernel.control.UnknownEffect.v0` | — | `kernel-control/run-outcome.ts` | 5.4 |
| `kernel.control.SyscallAck.v0` | — | `kernel-control/responses.ts` | 4.3 |
| `kernel.control.SyscallRejected.v0` | — | `kernel-control/responses.ts` | 4.3 |
| `kernel.control.RunCreated.v0` | — | `kernel-control/responses.ts` | 4.3 |
| `kernel.control.ArtifactContent.v0` | — | `kernel-control/responses.ts` | 4.3 |
| `kernel.control.CreateRunRequest.v0` | — | `kernel-control/interaction-requests.ts` | 4.2 |
| `kernel.control.AnswerAuthorizationRequest.v0` | — | `kernel-control/interaction-requests.ts` | 4.2 |
| `kernel.control.CancelRunRequest.v0` | — | `kernel-control/interaction-requests.ts` | 4.2 |
| `kernel.control.ReadArtifactRequest.v0` | — | `kernel-control/interaction-requests.ts` | 4.2 |
| `kernel.control.ShutdownRequest.v0` | — | `kernel-control/interaction-requests.ts` | 4.2 |
| `kernel.control.AuthorizationRequest.v0` | — | `kernel-control/interaction-events.ts` | 5.3 |
| `kernel.control.AuthorizationResolved.v0` | — | `kernel-control/interaction-events.ts` | 5.3 |
| `kernel.control.RunFinished.v0` | — | `kernel-control/interaction-events.ts` | 5.3 |
| `kernel.control.InteractionInboxEvent.v0` | — | `kernel-control/interaction-events.ts` | 5.1 |
| `kernel.control.RunSummary.v0` | — | `kernel-control/run-summary.ts` | 11 |
| `kernel.control.GatewayForward.v0` | — | `kernel-control/gateway-forward.ts` | 7.5 |
| `kernel.control.AdmissionProjection.v0` | — | `kernel-control/gateway-forward.ts` | 7.5 |

### 3.7 `kernel.unit`

| Schema ID | 嵌套类型 | 文件 | 节 |
|---|---|---|---|
| `kernel.unit.BudgetState.v0` | — | `kernel-unit/budget-state.ts` | 5.2 |
| `kernel.unit.ReportPublishInput.v0` | — | `kernel-unit/report-publish.ts` | 6.5 |
| `kernel.unit.ReportPublishOutput.v0` | — | `kernel-unit/report-publish.ts` | 6.5 |
| `kernel.unit.UnitInput.v0` | — | `kernel-unit/unit-io.ts` | 6.1 |
| `kernel.unit.UnitOutput.v0` | — | `kernel-unit/unit-io.ts` | 6.1 |
| `kernel.unit.RegisterAgentRunRequest.v0` | — | `kernel-unit/workflow-syscalls.ts` | 4.2 |
| `kernel.unit.SubmitUnitRequest.v0` | — | `kernel-unit/workflow-syscalls.ts` | 4.2 |
| `kernel.unit.EndAgentRunRequest.v0` | — | `kernel-unit/workflow-syscalls.ts` | 4.2 |
| `kernel.unit.CloseRunRequest.v0` | — | `kernel-unit/workflow-syscalls.ts` | 4.2 |
| `kernel.unit.RunStart.v0` | — | `kernel-unit/workflow-events.ts` | 5.2 |
| `kernel.unit.UnitReport.v0` | — | `kernel-unit/workflow-events.ts` | 5.2 |
| `kernel.unit.RunClosed.v0` | — | `kernel-unit/workflow-events.ts` | 5.2 |
| `kernel.unit.WorkflowInboxEvent.v0` | — | `kernel-unit/workflow-events.ts` | 5.1 |

`UnitInput`、`UnitOutput` 是 M1Interface 6.1 中各输入、输出 Schema 的联合，供 Gateway 做 `SubmitUnitRequest` 的第一层校验；
Core 再按该 Unit 定义的 `inputContract` 做精确校验。

### 3.8 `kernel.execution`

| Schema ID | 嵌套类型 | 文件 | 节 |
|---|---|---|---|
| `kernel.execution.ExecutionScope.v0` | — | `kernel-execution/execution-request.ts` | 7.1 |
| `kernel.execution.ExecutionLimits.v0` | — | `kernel-execution/execution-request.ts` | 7.1 |
| `kernel.execution.OrientExecutorInput.v0` | — | `kernel-execution/execution-request.ts` | 7.2 |
| `kernel.execution.SearchExecutorInput.v0` | — | `kernel-execution/execution-request.ts` | 7.2 |
| `kernel.execution.AssembleExecutorInput.v0` | ResolvedStep | `kernel-execution/execution-request.ts` | 7.2 |
| `kernel.execution.ModelExecutorInput.v0` | — | `kernel-execution/execution-request.ts` | 7.2 |
| `kernel.execution.ExecutionRequest.v0` | ExecutorKind | `kernel-execution/execution-request.ts` | 7.1 |
| `kernel.execution.ExecutionResult.v0` | — | `kernel-execution/execution-fact.ts` | 7.3 |
| `kernel.execution.ExecutionFact.v0` | ExecutionOutcome、RequestState | `kernel-execution/execution-fact.ts` | 7.3 |
| `kernel.execution.CancelRunExecutionsRequest.v0` | — | `kernel-execution/supervisor-requests.ts` | 7.4 |
| `kernel.execution.SupervisorShutdownRequest.v0` | — | `kernel-execution/supervisor-requests.ts` | 7.4 |

### 3.9 平台与未支持的 family

| Family | 内容 | 文件 |
|---|---|---|
| `platform.fabric` | Fabric 的 `CapabilityDescriptor`；`ConsumerOffsetRef`（opaque） | `platform-fabric/` |
| `platform.lifecycle` | ModuleHost 的 `CapabilityDescriptor` | `platform-lifecycle/` |
| `platform.persistence` | Persistence 的 `CapabilityDescriptor`；`JournalPositionRef`（opaque） | `platform-persistence/` |
| `platform.artifact` | ArtifactStore 的 `CapabilityDescriptor`；`RetentionTokenRef`（opaque） | `platform-artifact/` |
| `checkpoint`、`restore`、`review`、`integration` | opaque Ref | 各自目录 |
| `interaction` | M1 无 Schema | `interaction/`（空） |

`VersionedRef`、`OpaqueRef` 与 `OpaqueRefSchema` 位于 `platform-common/opaque-ref.ts`，只供上表的 opaque Ref 使用；
`platform.common.VersionedRef.v0` 一并注册。

### 3.10 `platform.config`

| Schema ID | 嵌套类型 | 文件 | 节 |
|---|---|---|---|
| `platform.config.KernelConfig.v0` | BudgetConfig、executionLimits | `platform-config/system-config.ts` | 14.3 |
| `platform.config.WorkflowConfig.v0` | — | `platform-config/system-config.ts` | 14.3 |
| `platform.config.SystemConfig.v0` | — | `platform-config/system-config.ts` | 14.3 |

缺省值不属于契约：`DEFAULT_KERNEL_CONFIG` 由 `@multiagentos/kernel` 导出，`DEFAULT_WORKFLOW_CONFIG` 由 `@multiagentos/workflow` 导出。

## 4. 标识、Port 与工具

### 4.1 标识

`platform-common/ids.ts` 导出 `IdSchemas`，前缀与生成者见 M1Interface 3.1：

| 键 | 前缀 | 说明 |
|---|---|---|
| `workflowRunId`、`agentRunId`、`unitAttemptId`、`messageId`、`correlationId`、`contextPackId`、`artifactId` | `wfr`、`agr`、`una`、`msg`、`cor`、`ctx`、`art` | 见 M1Interface 3.1 |
| `requestId`、`executionId`、`eventId`、`questionId`、`snapshotId` | `req`、`exe`、`evt`、`qst`、`snp` | 见 M1Interface 3.1 |
| `workSessionId`、`missionScopeId` | `wss`、`msc` | 保留，供 `BoundaryContext` 与 `Envelope` 的可选字段使用 |

### 4.2 Port

`ports.ts` 导出以下接口，字段与方法见 M1Interface：

| Port | 节 | 实现者 | 使用者 |
|---|---|---|---|
| `WorkflowGatewayPort` | 4.1 | Gateway（经 Fabric 存根） | Workflow |
| `InteractionGatewayPort` | 4.1 | Gateway（经 Fabric 存根） | UserInteraction |
| `WorkflowInboxPort` | 5.1 | Workflow | Kernel 核心（经 Fabric） |
| `InteractionInboxPort` | 5.1 | UserInteraction | Kernel 核心（经 Fabric） |
| `SupervisorPort` | 7.4 | Supervisor | Kernel 核心 |
| `ExecutionFactSink` | 7.4 | Kernel 核心 | Supervisor |
| `Executor`、`ExecutorInputByKind`、`ExecutorEnvironment`、`ExecutorOutcome`、`SubprocessRunner`、`ProviderCredentials` | 8 | ExecutorSet、Supervisor | Supervisor |
| `CatalogPort` | 9.3 | AgentToolPool | Workflow、Kernel 核心 |
| `ArtifactStorePort` | 10 | ArtifactStore | Kernel 核心（Execution） |
| `PersistencePort`、`RepositoryPort`、`AuditLogPort` | 10 | Persistence | Workflow、Kernel 核心 |
| `FabricPort`、`FabricAddress` | 10 | Fabric | 全部通讯主体 |
| `LifecyclePort`、`ModuleId`、`HealthStatus` | 10 | 各模块 | ModuleHost |
| `ExecutorRegistry` | 8 | ExecutorSet | 组合根、Supervisor |
| `PortResult` | 3.3 | — | 同步 Port 的返回 |

第 14 节的模块装配接口（各 `createXxx` 工厂、`XxxDeps`、`TerminalPort` 等）由各模块包导出，不在 contracts 中。

### 4.3 工具

| 导出 | 文件 | 用途 |
|---|---|---|
| `canonicalJson`、`sha256Hex` | `platform-common/canonical-json.ts` | 规范 JSON 与摘要；用于 digest、请求幂等与快照摘要 |
| `validate`、`assertValid`、`ContractValidationError` | `platform-common/validation.ts` | 运行时校验（TypeBox 编译器） |
| `newId`、`ulid` | `platform-common/new-id.ts` | 生成 `<prefix>_<ULID>` 形式的随机标识（M1Interface 3.1） |
| `parseSchemaId` | `protocol-registry.ts` | 把 Schema ID 拆为 `Envelope.schemaName` 与 `schemaVersion` |
| `unsupported` | `platform-common/validation.ts` | 构造 `UNSUPPORTED_CAPABILITY` 的 `ModuleError` |
| `REASON_CODES`、`REASON_CODE_CATEGORY` | `platform-common/reason-code.ts` | 原因码枚举与其 `ErrorCategory`（M1Interface 3.4） |
| `GATEWAY_REJECTED_CODES`、`CORE_REJECTED_CODES`、`UNIT_REJECTED_CODES`、`UNIT_FAILED_CODES`、`EXECUTOR_REJECTED_CODES`、`EXECUTOR_FAILED_CODES`、`VIOLATION_CODES`、`TERMINATION_CODES` | `platform-common/reason-code.ts` | 各位置允许的原因码集合及对应类型（M1Interface 1.4） |
| `EXECUTOR_KINDS`、`REPOSITORY_KINDS` | `platform-common/execution-kind.ts` | 会派发给 Supervisor 的五种执行，以及其中读取仓库的三种 |
| `ProtocolRegistry`、`createM1ProtocolRegistry` | `protocol-registry.ts` | 按 `schemaName + major` 注册与查找；拒绝重复与未知 major；为 `ContractRef` 解析 Schema，并生成工具参数的 JSON Schema |
| `MEDIA_TYPES` | `platform-common/media-types.ts` | M1Interface 6.1 的五种产物 mediaType 与 RunSummary 的 mediaType |
| `estimateTextTokens`、`estimateItemTokens`、`estimatePackTokens` | `context/token-estimate.ts` | 统一的输入 token 上界估算（M1Interface 6.3）；上下文 Executor、Execution 与启动校验共用，放在 contracts 中使 Kernel 不必导入 ExecutorSet |

## 5. 文件依赖顺序

后面的文件只能导入前面的文件：

```text
platform-common/* → kernel-unit/budget-state.ts
→ executor/model-tool-call.ts → executor/file-read.ts → executor/model-call.ts
→ context/context-pack.ts → context/token-estimate.ts → context/repository.ts
→ workflow/step-record.ts → workflow/handoff.ts → workflow/report.ts
→ context/assemble.ts
→ catalog/definition-schemas.ts → catalog/catalog-schemas.ts
→ kernel-control/run-outcome.ts → kernel-control/responses.ts
→ kernel-unit/report-publish.ts → kernel-unit/unit-io.ts
→ kernel-unit/workflow-syscalls.ts → kernel-unit/workflow-events.ts
→ kernel-control/interaction-requests.ts → kernel-control/interaction-events.ts
→ kernel-control/run-summary.ts → kernel-control/gateway-forward.ts
→ kernel-execution/execution-request.ts → kernel-execution/execution-fact.ts
→ kernel-execution/supervisor-requests.ts
→ platform-config/system-config.ts
→ ports.ts → protocol-registry.ts → index.ts
```

`kernel-unit/budget-state.ts` 没有任何导入，因此排在最前，供 `workflow.StatusFacts` 使用。
`catalog/definition-schemas.ts` 只导入 `platform-common/`。各 family 的 opaque Ref 文件只导入 `platform-common/opaque-ref.ts`。

## 6. 测试

| 位置 | 覆盖 |
|---|---|
| `packages/libraries/contracts/src/**/*.test.ts` | 每个顶层 Schema 的合法值、缺失必填字段、额外字段、取值越界；条件必填规则（如 `RUN_BLOCKED` 必须带 `closeReason`） |
| `packages/libraries/contracts/src/protocol-registry.test.ts` | 已注册的 Schema ID 与第 3 节逐一相同；重复注册与未知 major 被拒绝；`ContractRef` 可解析 |
| `packages/libraries/contracts/src/kernel-protocol.test.ts` | M1Interface 1.4 每条约束的正例与反例 |
| `packages/libraries/contracts/src/platform-common/reason-code.test.ts` | 原因码枚举与 M1Interface 3.4 一致，每个原因码有唯一 `ErrorCategory` |
| `packages/libraries/contracts/src/context/token-estimate.test.ts` | 估算覆盖 `toolSpecs` 与 `toolCalls`；估算值不低于固定样本的实际 token 数；相同输入结果稳定 |
| `packages/testing/src/harnesses/*-contract.test.ts` | 每个 Port 的共享 contract test 同时运行 fake 与真实实现 |
| `packages/testing/src/architecture.test.ts` | 文件依赖顺序无环；其他 workspace 不定义公共 Schema |

Schema 变更由三人评审，并同时提交兼容说明、正反例与 contract test（见 [M1Plan](../M1Plan.md) 第 4 节）。
