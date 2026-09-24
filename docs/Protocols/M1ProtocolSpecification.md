# MultiAgentOS M1 公共协议规范

> 状态：`v0/experimental`  
> 权威范围：`docs/M1Plan/TargetM1.md`  
> 运行时定义：`packages/contracts/src`  
> 适用范围：所有 Module、Infrastructure 和 Executor 边界
> 产品版本：0.1；M1–M5 为里程碑，M5 完成后发布 V1.0

## 1. 兼容承诺

1. `schemaName + major` 唯一确定一种协议语义。M1 的 major 为 `0`；未知 major 必须拒绝。
2. 同一 major 内只能新增有明确含义的可选字段、枚举消费者明确支持的值或新的独立 schema；不得删除字段、改变字段含义、收紧既有合法值或复用旧名称表达新语义。
3. 破坏性变化创建新 major，并提供显式转换器或迁移计划。不得根据字段是否存在猜测版本。
4. 所有跨边界数据必须先通过运行时 schema 校验。同步同进程调用使用公开 Port 与 `BoundaryContext`；Event、Signal、异步 Command、durable boundary 和跨进程调用使用 Envelope 与 Communication Fabric。TypeScript 类型不能替代运行时校验。
5. 已发布的 `ContextPack`、`UnitIntent`、`UnitResult`、`DefinitionVersion` 和 `ArtifactRef` 是不可变值；更正通过创建新对象完成。
6. Command 必须携带 `idempotencyKey`，修改聚合时携带 `expectedVersion`；Query result 必须携带 `sourceVersion`。
7. 不允许 `any`、任意 `metadata/extensions` 或空成功对象充当兼容扩展点。
8. M1 未实现的业务能力必须返回 `ModuleError(code=UNSUPPORTED_CAPABILITY)`，不得写状态、产生副作用或发布成功 Event。

## 2. Envelope

Event、Signal、异步 Command、durable boundary 和跨进程的 Command/Query/Result 使用 `platform.common.Envelope.v0`；同步同进程 Port 使用对应 payload schema 与 `BoundaryContext`。Envelope 固定头字段为：

| 字段 | 必需 | 语义 |
|---|---:|---|
| `schemaName` / `schemaVersion` | 是 | payload 协议名与 major；消费者据此选择 schema |
| `messageType` | 是 | `command/query/event/signal/result` |
| `messageId` / `producer` / `occurredAt` | 是 | 消息身份、生产者和 UTC 时间 |
| `tenantId` / `projectId` | 是 | 从 M1 起保留的隔离维度；M1 固定为本地值 |
| `correlationId` | 是 | 一次用户操作或执行链的关联身份 |
| `causationId` | 条件必需 | 由另一消息引起时指向直接原因 |
| `workSessionId` / `workflowRunId` / `missionScopeId` | 条件必需 | 消息进入对应运行范围后必须存在 |
| `aggregateId` / `aggregateVersion` | 条件必需 | 修改或描述聚合状态时必须存在 |
| `graphRevision` | 条件必需 | Workflow 范围消息必须存在；M1 固定为 `0` |
| `traceparent` | 否 | 后续分布式追踪插槽，不影响领域顺序 |
| `payload` | 是 | 由 `schemaName` 指定并单独校验的内容 |

Envelope 只承载身份、顺序和追踪信息，不承载授权结论、重试策略或业务状态机。

## 3. 公共值协议

| Schema | Owner | M1 语义 |
|---|---|---|
| `platform.common.VersionedRef.v0` | Contracts | owner 对象的 opaque 引用；包含 `kind/id/version` |
| `platform.common.WorkspaceRef.v0` | Kernel | workspace 身份、根路径、repository revision 和隔离类型 |
| `platform.common.ArtifactRef.v0` | Artifact Store | 不可变内容引用；`sha256/size/mediaType` 必须在读取时复验 |
| `platform.common.ModuleError.v0` | Contracts | 结构化错误类别、稳定 code、可重试性、correlation 和诊断引用 |
| `platform.common.CapabilityDescriptor.v0` | Owner | `SUPPORTED/UNSUPPORTED/DEGRADED`，以及适用 schema |
| `platform.common.BoundaryContext.v0` | Contracts | 本地 Port 调用携带 correlation/causation、tenant/project、运行引用与 deadline；不承载业务状态 |
| `Page<T>` | Query owner | `items/sourceVersion/nextCursor`；cursor 对调用方不透明 |

跨边界大对象只能放入 Artifact Store，消息中传 `ArtifactRef`。

## 4. M1 已执行协议

| 协议 | Owner → Consumer | Port / handler | 关键不变量 |
|---|---|---|---|
| `interaction.UserIntent.v0` | UserInteraction → Kernel | `KernelControlPort.submit` | RUN/INSPECT/REPORT/CANCEL 是判别联合；每种操作只携带自身字段并先准入 |
| `workflow.WorkflowRunView.v0` | Workflow → Kernel | `WorkflowControlPort` | Workflow 发布自身业务视图；Kernel 据此合成并拥有 RuntimeProjection |
| `workflow.TaskGraph.v0` | Workflow | Workflow application | M1 恰好一个 Task、无 Edge；M3 只放宽 capability validator |
| `kernel.control.RuntimeProjection.v0` | Kernel → UserInteraction | `KernelControlPort.submit` result | UI 只读投影；`sourceVersion` 标识来源版本 |
| `kernel.unit.UnitIntent.v0` | Workflow → Kernel | `KernelUnitPort.execute` | schema 为后续阶段保留全部 execution kind；M1 只准入 Context/Model/FILE_READ，其余返回 Unsupported |
| `kernel.unit.UnitResult.v0` | Kernel → Workflow | `KernelUnitPort.execute` result | attempt identity、状态、usage、Artifact evidence；Executor 不判断业务成功 |
| `context.ContextRequest.v0` | Kernel → ContextEngine | `ContextPort.buildContext` | workspace 与 Unit 一致；带目标、查询、预算和历史 Observation 引用 |
| `context.ContextPack.v0` | ContextEngine → Kernel | `ContextPort.buildContext` result | repository revision、来源、行范围、token 统计和 provenance，不可变 |
| `catalog.DefinitionQuery.v0` | Workflow/Kernel → AgentToolPool | `CatalogPort.resolve` | 按 kind、稳定 ID、版本范围和 capability 查询 |
| `catalog.DefinitionVersion.v0` | AgentToolPool → Workflow/Kernel | `CatalogPort.resolve` result | `ref/digest/inputContract/outputContract/capabilities`；运行创建后固定 |
| `platform.lifecycle.*` | Module Host ↔ Module/Adapter | `LifecyclePort` | manifest、依赖、start/stop/health；不得决定业务成功 |
| `platform.persistence.*` | Domain → Persistence | `RepositoryPort` | M1 文件原子替换；事务、Journal、Inbox/Outbox 显式 Unsupported |
| `platform.communication.*` | Module ↔ Module | `MessageRouterPort` | handler 语义不随 transport 改变；M1 同步进程内路由 |
| `platform.artifact.*` | Module ↔ Artifact Store | `ArtifactStorePort` | 内容不可变且读时验 hash/size；retention/remote store Unsupported |

## 5. 身份链

M1 从对象创建时保存以下身份，不允许以后通过日志反推：

```text
WorkSession -> PromptRevision -> SessionTreeNode -> WorkflowRun
  -> GraphRevision(0) -> root MissionScope -> TaskRun -> TaskAttempt
  -> AgentRun -> AgentStep -> UnitIntent -> UnitAttempt -> ArtifactRef
```

一个 owner 可以保存其他 owner 的 typed opaque Ref，但不能利用 Ref 读取或修改对方内部状态。

## 6. 后续能力的稳定插槽

下列协议在 M1 只定义 owner、typed opaque Ref、capability 和统一 Unsupported 结果；完整 Port 与 payload 要等真实用例验证后再引入：

| 协议族 | Opaque Ref / Port | 首次实现里程碑 |
|---|---|---:|
| `checkpoint.*` | `WorkflowCheckpointRef`、`SessionCheckpointRef`；participant Port 在 M4 定义 | M4 |
| `restore.*` | `RestoreOperationRef`；participant Port 在 M4 定义 | M4 |
| `review.*` | `HumanReviewRequestRef`、`HumanReviewDecisionRef`；M2 先使用本地确认，持久 Review Port 在 M4 定义 | M2/M4 |
| `integration.*` | `ChangeSetRef`、`IntegrationPlanRef`、`QualityGateResultRef`；Integration Port 在 M3 定义 | M3 |
| `kernel.control.*` | `PolicyDecisionRef` | M4/M5 |
| `kernel.unit.*` | `ExecutionPermitRef`、`EffectRecordRef` | M2–M4 |
| `context.*` | `IndexRevisionRef` | M2/M3 |
| `platform.persistence.*` | `JournalPositionRef` | M2 |
| `platform.communication.*` | `ConsumerOffsetRef` | M2/M3 |
| `platform.artifact.*` | `RetentionTokenRef` | M4 |

增加实现时保留现有 Port 的责任方向；如果完整 payload 需要破坏既有语义，必须新建 major，而不是扩展成任意对象。

## 7. 错误协议

`ModuleError.category` 只允许：`VALIDATION`、`CONFLICT`、`POLICY`、`TIMEOUT`、`RESOURCE`、`DEPENDENCY`、`EXECUTION`、`INTEGRITY`、`CONTRACT`、`INTERNAL`。`code` 是稳定的机器判断值，`message` 仅供展示；调用方不得解析 message 决策。大诊断信息使用 `diagnosticsRef/detailsRef`。

`retryable=true` 只表示同一语义请求在外部条件变化后可能成功，不授权调用方自行重试，也不等同于幂等保证。

## 8. Registry 与发布门

`createM1ProtocolRegistry()` 必须：

- 覆盖 `TargetM1.md` 第 6.5 节的全部协议族；
- 对实际使用的 schema 逐项记录 owner、major/minor、capability 和 handler；
- 拒绝重复的 `schemaName@major` 与未知 major；
- 将后续协议族标记为 `UNSUPPORTED`；
- 通过正向、非法字段、未知 major 和 Unsupported 无副作用测试。

协议从 `v0` 升级为稳定 `v1` 前，必须在固定任务集上验证 producer/consumer fixtures，并在需求追踪记录中链接测试证据。
