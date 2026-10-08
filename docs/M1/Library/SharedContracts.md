# MultiAgentOS M1 SharedContracts

## 1. 定位

SharedContracts 是静态库 `@multiagentos/contracts`（`packages/contracts`），提供 M1 全部跨模块 Schema、
由 Schema 派生的 TypeScript 类型、Port 接口、Protocol Registry 与校验工具。它不运行服务，不保存状态。
长期规划见 [SharedContracts 架构](../../Architecture/Library/SharedContracts.md)。

字段与语义以 [M1Interface](../M1Interface.md) 为准。本文规定每个类型落在哪个 Schema ID、哪个文件、由谁负责，
以及与现有代码的迁移差异。

## 2. 规则

- Schema 使用 TypeBox 定义，`$id` 为 `<family>.<Name>.v<major>`，M1 的 major 全部为 0（见 M1Interface 1.2）。
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
| `checkpoint`、`restore`、`review`、`integration` | 现有 opaque Ref | 各自目录 |
| `interaction` | M1 无 Schema | `interaction/`（空） |

## 4. 标识、Port 与工具

### 4.1 标识

`platform-common/ids.ts` 导出 `IdSchemas`，前缀与生成者见 M1Interface 3.1：

| 键 | 前缀 | 状态 |
|---|---|---|
| `workflowRunId`、`agentRunId`、`unitAttemptId`、`messageId`、`correlationId`、`contextPackId`、`artifactId` | `wfr`、`agr`、`una`、`msg`、`cor`、`ctx`、`art` | 已有 |
| `requestId`、`executionId`、`eventId`、`questionId`、`snapshotId` | `req`、`exe`、`evt`、`qst`、`snp` | 新增 |
| `workSessionId`、`missionScopeId` | `wss`、`msc` | 保留，供 `BoundaryContext` 与 `Envelope` 的可选字段使用 |
| `promptRevisionId`、`sessionTreeNodeId`、`taskRunId`、`taskAttemptId`、`agentStepId`、`unitIntentId` | — | 删除（M1 不使用） |

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
| `PortResult` | 3.3 | — | 同步 Port 的返回 |

### 4.3 工具

| 导出 | 文件 | 用途 |
|---|---|---|
| `canonicalJson`、`sha256Hex` | `platform-common/canonical-json.ts` | 规范 JSON 与摘要；用于 digest、请求幂等与快照摘要 |
| `validate`、`assertValid`、`ContractValidationError` | `platform-common/validation.ts` | 运行时校验 |
| `unsupported` | `platform-common/validation.ts` | 构造 `UNSUPPORTED_CAPABILITY` 的 `ModuleError` |
| `REASON_CODES`、`REASON_CODE_CATEGORY` | `platform-common/reason-code.ts` | 原因码枚举与其 `ErrorCategory`（M1Interface 3.4） |
| `ProtocolRegistry` | `protocol-registry.ts` | 按 `schemaName + major` 注册与查找；拒绝重复与未知 major；为 `ContractRef` 解析 Schema |
| `MEDIA_TYPES` | `platform-common/media-types.ts` | M1Interface 6.1 的五种产物 mediaType 与 RunSummary 的 mediaType |

## 5. 文件依赖顺序

后面的文件只能导入前面的文件：

```text
platform-common/* → kernel-unit/budget-state.ts
→ executor/model-tool-call.ts → executor/file-read.ts → executor/model-call.ts
→ context/context-pack.ts → context/repository.ts
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
→ ports.ts → protocol-registry.ts → index.ts
```

`kernel-unit/budget-state.ts` 没有任何导入，因此排在最前，供 `workflow.StatusFacts` 使用。
`catalog/definition-schemas.ts` 只导入 `platform-common/`，保持现有约束（不导入 `schemas.ts`）。

## 6. 与现有代码的差异

| 现有 | 处理 |
|---|---|
| `schemas.ts` 中的 `UnitIntent`、`UnitResult`、`UnitOwner`、`Usage`、`UserIntent` 及其变体、`TaskGraph`、`RuntimeProjection`、`WorkflowRunView`、`WorkspaceRef`、`PageSchema` | 删除；由第 3 节的 Schema 取代 |
| `context.ContextRequest.v0`、`context.ContextPack.v0`（旧字段） | 删除 ContextRequest；ContextPack 按 M1Interface 6.3 重写 |
| `ExecutionKindSchema`（`CONTEXT` 等旧值） | 改为 `platform.common.ExecutionKind.v0` 的九个取值 |
| `ports.ts` 中的 `KernelUnitPort`、`KernelControlPort`、`ContextPort`、`MessageRouterPort`、`MessageHandler` | 删除；由第 4.2 节的 Port 取代 |
| `ArtifactStorePort.put/get` | 增加 `workflowRunId` 参数 |
| `RepositoryPort` | 保留；新增 `PersistencePort` 与 `AuditLogPort` |
| `platform-communication/`、`platform.communication.*` | 目录改名为 `platform-fabric/`，family 改为 `platform.fabric` |
| `catalog/definition-schemas.ts` 的 Agent、Unit、Tool 字段 | 按 M1Interface 9.2 修改，差异清单见 [AgentToolPool](AgentToolPool.md) 第 8 节 |
| `VersionedRef`、`OpaqueRef` 与 opaque Ref Schema | 保留，只用于第 3.9 节的未支持协议 |

## 7. 测试

| 位置 | 覆盖 |
|---|---|
| `packages/contracts/src/**/*.test.ts` | 每个顶层 Schema 的合法值、缺失必填字段、额外字段、取值越界；条件必填规则（如 `RUN_BLOCKED` 必须带 `closeReason`） |
| `packages/contracts/src/protocol-registry.test.ts` | 全部顶层 Schema 已注册；重复注册与未知 major 被拒绝；`ContractRef` 可解析 |
| `packages/contracts/src/platform-common/reason-code.test.ts` | 原因码枚举与 M1Interface 3.4 一致，每个原因码有唯一 `ErrorCategory` |
| `packages/testing/src/harnesses/*-contract.test.ts` | 每个 Port 的共享 contract test 同时运行 fake 与真实实现 |
| `packages/testing/src/architecture.test.ts` | 文件依赖顺序无环；其他 workspace 不定义公共 Schema |

Schema 变更由三人评审，并同时提交兼容说明、正反例与 contract test（见 [M1Plan](../M1Plan.md) 第 4 节）。
