# MultiAgentOS 协议架构

## 1. 范围

本文定义 Module、Infrastructure 和 Execution 之间的长期通信语义。具体 Schema 由 Owner 发布到 Protocol Registry；实现状态不改变本文语义。

## 2. 基本原则

1. 每类状态只有一个写入 Owner；其他组件使用 Command、Query、Event、Signal、Result 或 ArtifactRef 协作。
2. 同进程同步调用使用公开 Port、运行时校验 payload 和 BoundaryContext。
3. Event、Signal、异步 Command、持久化边界及跨进程调用使用 Envelope。
4. 所有消息至少一次处理安全；重复、乱序和迟到是正常输入。
5. Command 不等于成功，Event 只描述已提交事实，Result 只描述执行结果。
6. 传输、持久化和业务状态机相互独立；Transport 不解释领域语义。

## 3. Envelope

Envelope 头至少包含：

| 字段 | 语义 |
|---|---|
| `schemaName/schemaVersion` | payload 协议身份 |
| `messageType` | command、query、event、signal 或 result |
| `messageId/producer/occurredAt` | 消息身份、来源和 UTC 时间 |
| `tenantId/projectId` | 隔离范围 |
| `correlationId/causationId` | 执行链与直接原因 |
| `workSessionId/workflowRunId/missionScopeId` | 所在运行范围，适用时必需 |
| `aggregateId/aggregateVersion` | 聚合身份与已提交版本 |
| `graphRevision` | TaskGraph 相关消息的版本屏障 |
| `traceparent` | 分布式追踪上下文 |
| `payload` | 由 schemaName 指定并独立校验的内容 |

Envelope 不承载授权结论、业务 retry 策略或隐式扩展字段。BoundaryContext 是同步 Port 的最小等价头，包含 correlation、causation、tenant/project、运行引用和 deadline。

## 4. 身份链

```text
WorkSession -> PromptRevision -> SessionTreeNode -> WorkflowRun
-> GraphRevision -> MissionScope -> TaskRun -> TaskAttempt
-> AgentRun -> AgentStep -> UnitIntent -> UnitAttempt -> ArtifactRef
```

标识必须在对象创建时产生并持久化，不得从日志反推。消息进入相应范围后必须携带已有身份。Owner 可以发布 opaque VersionedRef；消费者不得利用 Ref 读取或修改 Owner 内部表。

## 5. Command 与 Query

Command 必须包含 idempotencyKey；修改现有聚合时包含 expectedVersion。Owner 以 `(tenant, command, idempotencyKey)` 去重：同键同请求返回原结果，同键不同请求返回 `IDEMPOTENCY_KEY_REUSED`。版本冲突返回 `VERSION_CONFLICT`，不得隐式覆盖。

Query 不改变状态，返回 `sourceVersion` 和可选 cursor。Cursor 对调用方不透明并绑定查询范围；不得把查询当作授权或一致性锁。

## 6. Event、Signal 与 Result

- Event 在领域事务提交后通过 Outbox 发布，名称使用已发生事实。
- Signal 定向唤醒持久等待，必须绑定目标、correlation、版本和有效期。
- Result 与原请求/Unit correlation 关联，携带 attempt identity、状态、usage、Artifact 和结构化错误。
- 消费者先执行 Inbox 去重，再校验 owner、revision、aggregate version、Lease/fencing 和当前状态。
- 迟到结果若不再适用，只保存为 Evidence，不覆盖当前终态。

## 7. Definition 与 Unit 协议

Shared Contracts 定义 Agent、Unit、Tool、Executor 的通用协议。AgentToolPool 保存具体且不可变的 AgentDefinitionVersion、UnitDefinitionVersion、ToolDefinitionVersion 和静态 ExecutorDefinitionVersion；引用必须携带稳定 ID、版本和 digest。

AgentDefinitionVersion 通过 `allowedUnitRefs` 声明封闭的 Unit 集合；UnitDefinitionVersion 通过 `toolRefs` 声明封闭的 Tool 集合，并通过 `requiredCapabilities` 描述执行要求。ExecutorDefinitionVersion 只描述静态执行器类别，不包含 endpoint、会话、Lease、健康度或负载。

Workflow 创建 AgentRun，并固定 Agent 定义及其 Unit/Tool 引用闭包。Workflow 只能为该 AgentRun 允许的 UnitDefinitionVersion 创建不可变 UnitIntent。Kernel 必须重新解析固定 digest，验证 Agent→Unit 与 Unit→Tool 成员关系，完成身份、Policy、capability、workspace、budget、revision 和资源准入，再按 capability 选择运行时 Executor，创建 UnitAttempt 与 ExecutionPermit。

UnitIntent 至少绑定 agentRunId、agentDefinitionVersionRef、unitDefinitionVersionRef、输入引用、逻辑幂等键、MissionScope、graphRevision 和 deadline；不得包含明文 Secret、长期凭据、Executor endpoint 或可绕过调度的 executorId。UnitAttempt 绑定选定的 ExecutorDefinitionVersionRef、运行时 ExecutorInstance、Lease、fencing 和 Permit。

Execution Adapter 或 ContextEngine 产生 UnitResult/EffectRecord，Kernel 校验后发布 Event，Workflow 再解释业务影响。逻辑 retry 创建新的 UnitAttempt，并保留同一逻辑 Unit identity；业务 retry 是否允许由对应 Owner 决定。

Tool 没有独立调用协议。任何 Tool 调用都必须由 UnitDefinitionVersion 封装、经 Workflow 形成 UnitIntent，并由 Kernel 创建新的 UnitAttempt；模型 tool call 仅是动作提案，不得在 Model Adapter 内直接执行。

## 8. MissionScope 协议

MissionScope 是 Workflow 拥有的跨模块控制上下文，绑定目标谱系、graphRevision、预算、capability ceiling、workspace、context refs、取消边界和完成条件。

- ContextEngine 以 `missionScopeId + graphRevision` 构造目标谱系和最小 TaskGraph 切片，并按 ACL 过滤。
- Kernel 将 capability ceiling、预算、workspace、controlState 和 revision 纳入准入。
- AgentToolPool 仅按目标类型和 CapabilityRequirement 筛选静态定义，不保存 MissionScope、AgentRun 或 UnitAttempt 实例。
- Infrastructure 只传递、存储和索引 MissionScopeRef，不解释其业务语义。

MissionScope 不是 Grant 或 Lease。控制状态进入 pausing、cancelling 或 revision barrier 后，Kernel 不得为受影响范围签发不兼容的新执行许可。

## 9. Checkpoint 与恢复协议

系统区分：durable runtime 的控制流 checkpoint、Workflow 内部一致边界 WorkflowCheckpoint，以及用户可见、长期保留的 SessionCheckpoint。三者身份、所有者和生命周期不得混用。

SessionCheckpoint manifest 保存 Workflow 状态引用、eventSequence、graphRevision、root MissionScope、PromptRevision、DefinitionVersion、Artifact/workspace/effect 引用、依赖 Owner、版本/digest、hash、保存/恢复策略、retention token、重建配方和完整性 hash。它是自包含恢复清单，不复制其他 Module 的领域行。

所有依赖 Owner 实现 CheckpointParticipant：prepare、commit、abort、query、release retention。创建是可恢复 Saga；全部 required token ACTIVE 后才能 AVAILABLE。

从 SessionCheckpoint 派生运行使用 RestoreOperation/RestorePlan。每个 RestoreAction 声明 owner、strategy、source/target ref、required、idempotencyKey 和验收 Contract；策略限定为 CLONE、REFERENCE、REBUILD、REVALIDATE、REISSUE、MATERIALIZE、RECONCILE 或 INVALIDATE。

普通进程恢复、Unit retry、replan 和 compensation 不创建 RestoreOperation。恢复不继承 Grant、Lease、Secret、ExecutionPermit、开放审核或 Executor 会话。

## 10. 人类审核协议

Workflow 产生 HumanReviewIntent 并持久化业务等待；Kernel 创建 HumanReviewRequest，验证审查者身份、角色、职责分离、参数绑定、policyVersion 和有效期，将 UserInteraction 提交的 ReviewResponse 裁决为不可变 HumanReviewDecision。

审核类型包括 APPROVAL、INFORMATION、DECISION 和 ACCEPTANCE。参数、资源、graphRevision、DefinitionVersion、PromptRevision、checkpoint、预算或 Policy 变化会使旧请求失效。超时默认不批准。APPROVAL 只允许 Workflow 继续等待 Kernel 重新准入，不直接产生 Grant。

## 11. 错误协议

错误类别固定为 VALIDATION、CONFLICT、POLICY、TIMEOUT、RESOURCE、DEPENDENCY、EXECUTION、INTEGRITY、CONTRACT 和 INTERNAL。需要表达未知副作用时使用稳定 code `UNKNOWN_EFFECT` 并归入 EXECUTION/INTEGRITY 决策路径。

`code` 用于机器决策，`message` 只用于展示；大诊断写入 Artifact。`retryable=true` 仅说明外部条件变化后可能成功，不授权调用方自动重试，也不保证幂等。

## 12. 版本与兼容

`schemaName + major` 唯一确定语义。未知 major 拒绝；同 major 只允许兼容扩展；破坏性变化创建新 major 和显式迁移。Agent/Unit/Tool/Executor DefinitionVersion、GraphRevision、UnitIntent、UnitResult、ContextPack、Checkpoint manifest 和 Artifact 发布后不可变。

恢复、重放或延迟消费时必须按消息携带的版本解析，禁止使用“当前默认版本”替换历史语义。

## 13. 完成协议

物理 Unit 成功不能直接完成 Task。状态传播顺序固定为：

```text
UnitAttempt result -> AgentRun decision -> TaskAttempt acceptance
-> TaskRun resolution -> readiness/join recompute
-> MissionScope completion -> WorkflowRun completion candidate
-> Kernel execution-scope drain -> final completion
```

最终完成前必须满足 required Task/Join、关闭有效 Lease、处理 required Signal/Review、提交所需 Artifact、回收 Grant，并记录、确认或补偿外部副作用。

## 14. 安全与可观测性

身份、tenant/project、correlation/causation、revision、attempt 和 policy references 必须贯穿协议。日志和 trace 不记录完整 Prompt、源代码、Secret 或工具结果；使用 ArtifactRef 和脱敏摘要。审计记录主体、意图、Policy/Review 引用、before/after version、准入结果和副作用事实。

## 15. 协议测试

测试必须覆盖正反 Schema、未知 major、兼容 fixture、定义 digest、Agent→Unit 与 Unit→Tool 成员关系、Tool 脱离 Unit 调用、Executor capability 匹配、幂等键复用、版本冲突、重复/乱序/迟到消息、旧 revision、旧 fencing、Signal 先到、Outbox/Inbox 崩溃、审核失效、checkpoint participant 部分失败、恢复动作幂等和完成状态不可跳层。
