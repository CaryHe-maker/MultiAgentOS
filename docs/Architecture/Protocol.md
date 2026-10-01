# MultiAgentOS 协议架构

## 1. 范围

本文定义包括 Execution 在内的各 Module 与 Infrastructure 之间的长期通信语义。下列字段表达现有协议基线；具体 Schema 和新增控制机制在各 MVP 中完成版本设计。既有字段不得因概念调整被静默改变，交付范围不改变所开放能力的协议含义。

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

Envelope 本身不是授权凭证；授权请求、凭证引用或决定由显式版本化 payload 表达，不由头部字段自述产生权限。Envelope 不隐含业务 retry 策略或任意扩展字段。BoundaryContext 是同步 Port 的最小等价头，包含 correlation、causation、tenant/project、运行引用和 deadline。

## 4. 身份链

```text
WorkSession -> PromptRevision -> SessionTreeNode -> WorkflowRun
-> GraphRevision -> MissionScope -> TaskRun -> TaskAttempt
-> AgentRun -> AgentStep -> UnitIntent -> UnitAttempt -> ArtifactRef
```

标识在对象创建时产生，需要恢复的对象同时持久化，不得从日志反推。消息进入相应范围后必须携带已有身份。Owner 可以发布 opaque VersionedRef；消费者不得利用 Ref 读取或修改 Owner 内部表。

消息必须区分可信通信主体与其代办的 AgentRun 或系统职责。调用参数中的身份文本不得覆盖通道认证结果。Module 权限与 Agent 权限共同限定操作，不能借下游服务自身权限扩大范围。

## 5. Command 与 Query

Command 必须包含 idempotencyKey；修改现有聚合时包含 expectedVersion。Owner 以 `(tenant, command, idempotencyKey)` 去重：同键同请求返回原结果，同键不同请求返回 `IDEMPOTENCY_KEY_REUSED`。版本冲突返回 `VERSION_CONFLICT`，不得隐式覆盖。

Query 不改变状态，返回 `sourceVersion` 和可选 cursor。Cursor 对调用方不透明并绑定查询范围；不得把查询当作授权或一致性锁。

## 6. Event、Signal 与 Result

- Event 在领域事务提交后通过 Outbox 发布，名称使用已发生事实。
- Signal 传递中断或定向唤醒持久等待，必须绑定目标、correlation、版本和有效期；投递回执不代表中断已生效。
- Result 与原请求/Unit correlation 关联，携带 attempt identity、状态、usage、Artifact 和结构化错误。
- 消费者先执行 Inbox 去重，再校验 owner、revision、aggregate version、Lease/fencing 和当前状态。
- 迟到结果若不再适用，只保存为 Evidence，不覆盖当前终态。

## 7. Definition 与 Unit 协议

Shared Contracts 定义 Agent、Unit、Tool、Executor 的通用协议。AgentToolPool 保存具体且不可变的 AgentDefinitionVersion、UnitDefinitionVersion、ToolDefinitionVersion 和静态 ExecutorDefinitionVersion；引用必须携带稳定 ID、版本和 digest。

AgentDefinitionVersion 通过允许集合限定可请求的 Unit。Unit 对应一个 Tool 粒度的操作；
Tool 封装输入输出、权限需求、效果和 Executor 执行序列。ExecutorDefinitionVersion
描述静态类别，不包含 endpoint、会话、Lease、健康或负载。

现有 `allowedUnitRefs`、`toolRefs` 与新 Tool 序列的字段映射需要显式版本设计，
见 [架构指南](README.md#6-文档衔接清单)。成员关系、固定版本、digest 与撤销检查仍须保留，
不得把定义迁移解释为允许任意 Tool 或 Executor。

Workflow 创建 AgentRun，固定定义闭包，形成不可变 UnitIntent。
Gateway 检查身份、范围和适用租约；无适用资格时 Core 裁决。
Execution 根据获准请求幂等创建 UnitAttempt，Scheduler 为就绪步骤选择实例，
Monitor 预留额度，Supervisor 提供执行环境。

UnitIntent 至少说明 agentRunId、Agent/Unit/Tool 定义引用、输入、逻辑幂等键、
MissionScope、graphRevision 和 deadline；不得携带明文 Secret 或绕过调度的物理端点。
UnitAttempt 关联授权依据、Tool 版本、步骤实例及其 Executor 定义、资源安排和运行目标。
一个 Attempt 可以包含多个 Executor 实例，不再用单一 executorId 代表整个 Tool 序列。

Execution 或 Context 执行目标提供候选 UnitResult/EffectRecord；Kernel 确认接收条件并发布事实，
Workflow 再解释业务影响。实际完成、结果接受和业务成功分别由相应 Owner 维护。
新的实际尝试由 Execution 创建并保留逻辑关联；业务 retry 是否允许由 Workflow 决定。

Tool 没有绕过 Gateway 的独立调用入口。模型 tool call 是动作提案，必须返回 Workflow
形成新业务 UnitIntent。已定义的 Tool 技术步骤可在同一 Attempt 内推进，但不得越过租约范围。

### 7.1 Lease、Grant 与 ExecutionPermit

Grant 表达 Core 确认的授权依据；Lease 表达可在给定条件下使用能力的资格；
ExecutionPermit 表达本次 Attempt 或步骤的最小执行范围。
具体字段映射由版本化契约规定，不能把旧的有限期 Attempt Lease 原地改成永久资格。

Core 保存 Lease 权威记录，Gateway 使用可信验证视图，Workflow 或其他持有者保存凭证或引用。
Lease 可长期或不设预定到期日，但仍受主体、资源、Tool 版本及撤销约束。
复用 Lease 不复用旧 Attempt，也不免除幂等、资源和使用点检查。

fencing 用于拒绝旧执行持有者，即使其长期租约仍有效也不能提交旧尝试的结果。
Scheduler 管理调度代次，Execution 和资源提交边界绑定并验证相应执行资格。
验证不清楚时默认拒绝；撤销传播与离线缓存有效期由 MVP 明确承诺。

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

普通进程恢复、Unit retry、replan 和 compensation 不创建 RestoreOperation。恢复不从 checkpoint 继承有效 Grant、Lease、Secret、ExecutionPermit、开放审核或 Executor 会话。持久授权依据仍由 Core 管理，永久租约也需重新确认当前归属与适用版本。Execution 作为执行状态 Owner 提供步骤及效果核对，不接管 Workflow 的恢复编排。

## 10. 人类审核协议

Workflow 产生 HumanReviewIntent 并持久化业务等待；Kernel 创建 HumanReviewRequest，验证审查者身份、角色、职责分离、参数绑定、policyVersion 和有效期，将 UserInteraction 提交的 ReviewResponse 裁决为不可变 HumanReviewDecision。

审核类型包括 APPROVAL、INFORMATION、DECISION 和 ACCEPTANCE。参数、资源、graphRevision、DefinitionVersion、PromptRevision、checkpoint、预算或 Policy 变化会使旧请求失效。超时默认不批准。APPROVAL 只允许 Workflow 继续等待 Kernel 重新准入，不直接产生 Grant。

## 11. 错误协议

错误类别固定为 VALIDATION、CONFLICT、POLICY、TIMEOUT、RESOURCE、DEPENDENCY、EXECUTION、INTEGRITY、CONTRACT 和 INTERNAL。需要表达未知副作用时使用稳定 code `UNKNOWN_EFFECT` 并归入 EXECUTION/INTEGRITY 决策路径。

`code` 用于机器决策，`message` 只用于展示；大诊断写入 Artifact。`retryable=true` 仅说明外部条件变化后可能成功，不授权调用方自动重试，也不保证幂等。

### 11.1 AgentOS 调用、中断与异常

Core 的控制分派职责维护服务规则、控制操作身份、目标、处理状态和因果关联。
Gateway 根据身份与租约分派调用，有效租约不要求重复进入 Core 裁决。
服务必须区分接受、处理中及完成；不可用服务不得返回占位成功。

中断需区分请求收到、送达、接受和实际生效。Scheduler 阻止新推进，
Execution 响应安全点，Supervisor 监管时限并在必要时回收受影响执行域。
共享进程不得因单个 Attempt 的控制请求无依据影响其他工作。

故障异常记录已知事实、影响范围、即时保护与待处理问题。
紧急保护可以先于完整诊断；执行故障主动通知 Workflow，业务修复由 Workflow 决定。
panic 仅用于可信基础失守，不因普通无权限、工具失败或用户 Executor 消息直接触发。

调用可产生中断，中断失败可产生异常，三者共享关联但不等同于消息类型或 OS signal。
控制记录不能替代 Execution 的实际停止事实。重复控制请求需幂等，控制通道不能被无限饿死。

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

最终完成前必须满足 required Task/Join、处理 required Signal/Review、提交所需 Artifact，收敛本次执行范围的在途操作、临时执行资格和资源持有，并记录、确认或补偿外部副作用。不要求撤销主体在其他范围仍有效的长期租约。

## 14. 安全与可观测性

身份、tenant/project、correlation/causation、revision、attempt 和 policy references 必须贯穿协议。日志和 trace 不记录完整 Prompt、源代码、Secret 或工具结果；使用 ArtifactRef 和脱敏摘要。审计记录主体、意图、Policy/Review 引用、before/after version、准入结果和副作用事实。

### 14.1 流式输出

执行面可通过授权的逻辑流通道提供进度与输出片段；消息关联运行、Attempt 和来源。
Stream 不代表已提交结果，不得覆盖权威终态或触发新授权。
订阅范围、顺序、输出限额、慢消费者和断线补读需明确。
仅展示供应商实际提供且允许展示的推理内容或摘要，不假定可获取内部推理。

## 15. 协议测试

测试必须覆盖正反 Schema、未知 major、兼容 fixture、定义 digest、Agent→Unit 与 Unit→Tool 成员关系、Tool 脱离 Unit 调用、Executor capability 匹配、幂等键复用、版本冲突、重复/乱序/迟到消息、旧 revision、旧 fencing、Signal 先到、Outbox/Inbox 崩溃、审核失效、checkpoint participant 部分失败、恢复动作幂等和完成状态不可跳层。
