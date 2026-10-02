# MultiAgentOS 整体架构

## 1. 系统目标

目标运行平台为 **Ubuntu LTS**。本文定义长期能力、职责和系统不变量；具体接口、算法与部署参数由各 MVP 细化。长期能力不因某个 MVP 暂不实现而被移除。

MultiAgentOS 将持续数分钟至数天的软件工程和知识工作转化为可验证的 TaskGraph，并在 Agent、确定性执行器和隔离 workspace 之间推进。系统必须：

1. 将非确定性模型行为约束在可控制、可恢复、可审计的闭环中。
2. 使模型、工具、文件、网络和数据库操作可追溯到目标、身份、权限、预算、图版本和因果链。
3. 以任务依赖、输入输出 Contract、Artifact 和验收条件组织协作，避免无主结果。
4. 在崩溃、重复消息、网络分区、Executor 失联和迟到结果下保持领域状态一致。
5. 允许用户检查、暂停、恢复、取消、审核、重新规划、派生运行和获取完整报告。
6. 交付结构化结果、来源、ChangeSet、测试证据、成本、权限决策和未解决问题。

系统不自研通用数据库、消息代理、容器 runtime、模型 Provider 或 durable workflow engine；这些能力通过 Adapter 集成。系统不承诺任意外部副作用 exactly-once，不把模型推理当作可信事实，也不允许 Agent 自行扩大权限。

## 2. 设计原则

1. **单一权威**：每类领域状态只有一个写入 Owner。
2. **意图与执行分离**：Workflow 描述做什么；Kernel 决定能否、何时、何地以及使用何种资源执行；Execution 维护实际执行过程。
3. **事实驱动**：上层只消费已提交的下层 Event，不接受 Executor 跨层回调。
4. **业务图与持久控制流分离**：TaskGraph 表达业务依赖；durable runtime 只恢复控制流。
5. **不可变引用优先**：GraphRevision、Agent/Unit/Tool/Executor DefinitionVersion、UnitIntent、Checkpoint manifest 和 Artifact 发布后不可修改。
6. **至少一次下的幂等**：重复、重放、乱序和迟到是正常输入。
7. **最小权限与执行时重验**：目录声明不是授权；副作用发生前重新校验身份、Policy、Grant、Lease、revision、预算和 deadline。
8. **派生数据可重建**：投影、索引、缓存和遥测不得反向覆盖事实源。
9. **默认拒绝**：未知能力、版本、状态和数据范围不产生副作用。
10. **证据完整**：业务成功必须由 Contract、Artifact、provenance 和验收事实支持。

## 3. 逻辑架构

```text
Web / CLI / IDE
       |
UserInteraction
       |
Kernel Control Plane
       |
+------+--------------+----------------+
| Workflow            | ContextEngine  | AgentToolPool
| 业务图、监督、恢复   | 上下文与检索   | Agent/Unit/Tool/Executor 静态定义
+------+--------------+----------------+
       |
Kernel Gateway / Core / Scheduler / Monitor / Supervisor
       |
Execution: Model · Tool · Workspace · Sandbox · Git
       |
Module Host · Shared Contracts · Persistence
Communication Fabric · Artifact Store
```

UserInteraction、Workflow、Kernel、ContextEngine、AgentToolPool 和 Execution 是独立逻辑模块，但调用方向受约束。Execution 的运行管理代码属于可信系统，不可信 Executor 实现需另行隔离。模块、代码包与 OS 进程不要求一一对应。

Kernel 由 Gateway、Core、Scheduler、Monitor、Supervisor 五个主组件组成。Gateway 负责统一入口；Core 管理授权、租约与控制分派；Scheduler 分配执行机会和 API 容量；Monitor 管理指标与资源预算账本；Supervisor 监管模块和执行域。ModuleHost 归 Supervisor 管辖，Communication Fabric 归 Kernel 管辖；二者仍通过基础设施 Port 提供机制，不解释业务语义。

## 4. 权威矩阵

| Owner | 权威对象 | 不负责 |
|---|---|---|
| UserInteraction | WorkSession、SessionTree、InteractionTurn、PromptRevision、用户草稿和原始 ReviewResponse | 运行状态、授权结论、恢复快照内容 |
| Workflow | WorkflowRun、TaskGraph/GraphRevision、MissionScope、Task/Agent、IntegrationAttempt、Workflow/SessionCheckpoint、RestoreOperation、补偿 | 身份认证、物理资源、执行、检索实现 |
| Kernel | Identity/Policy、HumanReviewDecision、Grant、Lease、执行许可、调度关系、资源预算账本、进程监管、控制操作、结果接收决定和 RuntimeProjection | AgentRun、UnitAttempt 内部进度、任务依赖、业务验收、Session 内容、定义内容 |
| Execution | UnitAttempt、Executor 步骤实例、执行序列进度、候选结果、Artifact/EffectRecord 关联 | 租约签发、资源额度裁决、Task/Workflow 验收 |
| ContextEngine | ContextRecord、RepositorySnapshot、IndexRevision、RetrievalResult、ContextPack | Task 状态、权限签发、通用工具目录 |
| AgentToolPool | 具体且不可变的 AgentDefinitionVersion、UnitDefinitionVersion、ToolDefinitionVersion、ExecutorDefinitionVersion，以及其引用的 Model、Prompt、Contract | 运行实例、凭据、动态预算、授权和执行 |
| Infrastructure | 生命周期、Shared Contracts、Schema、事务提交、消息投递、Artifact 字节与完整性 | 具体定义、领域决策和业务状态机 |

Shared Contracts 定义 Agent、Unit、Tool、Executor 及其运行时对象的通用协议；AgentToolPool 只保存符合这些协议的具体静态版本。

## 5. 核心对象与三个结构

```text
WorkSession -> PromptRevision -> SessionTreeNode -> WorkflowRun
                                            |
WorkflowRun -> TaskGraph @ GraphRevision     |
           -> MissionScope Tree              |
           -> TaskRun -> TaskAttempt -> AgentRun @ AgentDefinitionVersion
                                           -> UnitIntent @ UnitDefinitionVersion
                                           -> UnitAttempt @ ToolDefinitionVersion
                                                -> Executor 步骤实例 @ ExecutorDefinitionVersion
                                                -> Processes / ArtifactRef / EffectRecord
```

- TaskGraph：业务依赖、输入输出和 Join。
- MissionScope Tree：目标谱系、监督、预算、能力上限、workspace、上下文和取消边界。
- WorkSession/SessionTree：用户组织、观察和派生多次运行的交互结构。

三个结构具有不同 Owner 和语义，不得合并为一棵“万能任务树”。需要耐久记录的 ID 在对象创建时持久化，不得通过日志反推。

能力组织为 Unit → Tool → Executor 执行序列。Unit 对应一个 Tool 粒度的操作；Tool 封装权限需求和执行序列，实际资格由租约赋予。Executor 的原子性指组合粒度，不保证事务原子性或可回滚。Process 承载运行实例，隔离与复用由交付设计明确。静态定义引用的契约衔接见 [架构指南](README.md#6-文档衔接清单)。

## 6. 运行闭环

```text
UserIntent -> Kernel 准入 -> Workflow 创建/变更业务状态
Workflow -> 固定 Agent/Unit/Tool 定义闭包 -> 创建 AgentRun/UnitIntent
Gateway -> 校验身份、定义与租约；无适用租约时由 Core 裁决
Execution -> 根据获准请求幂等创建 UnitAttempt，准备 Tool 执行序列
Scheduler / Monitor -> 为就绪步骤选择 Executor、分配资源和预留预算
Supervisor -> 监管受限执行环境
Execution / Context 执行目标 -> 候选 UnitResult/Artifact/EffectRecord
Kernel -> 校验并发布 Event/RuntimeProjection
Workflow -> 验收、继续、等待、replan、补偿或完成
UserInteraction -> 展示投影与证据
```

模型输出始终是提案。所有 Tool 调用必须封装为 Unit；模型 tool call 必须返回 Workflow 形成 UnitIntent，并重新经过 Kernel 准入。Executor 的物理成功、模型的 FINAL 声明或工具的 exit code 均不能越过 Workflow 验收直接完成 Task。

## 7. 图、监督与并行

TaskGraph 采用不可变 GraphRevision。Readiness 根据依赖、Join、输入 Contract、Artifact、MissionScope 和 revision barrier 确定。支持 ALL、ANY、QUORUM 和版本化 custom evaluator；相同输入必须产生相同决定。

并行 TaskAttempt/AgentRun 使用独立 workspace、预算和 capability ceiling。结果通过 Artifact/ChangeSet 交付，由确定性 IntegrationPlan 在干净 workspace 中集成。Event 到达顺序不得决定集成顺序。

动态 replan 通过 GraphPatch 创建新 revision；影响闭包之外的分支只有在 Contract、Artifact、workspace 和权限隔离仍成立时才能继续。

## 8. 执行与副作用

Agent 的模型、工具、文件、网络、Context 和外部数据库操作通过 UnitIntent 表达。AgentDefinitionVersion 限定允许的 Unit；Unit 引用对应 Tool，Tool 定义 Executor 执行序列与能力需求。Gateway 检查适用租约，Core 在必要时作授权裁决，Execution 创建 UnitAttempt，Scheduler 与 Monitor 安排资源，Supervisor 落实执行环境约束。

可信 Module 的静态定义或 Artifact 读取可预先获得范围受限的系统租约，不必每次形成业务 Unit 或进入 Core。有效租约快速路径只省去重复裁决，不省去身份、版本、范围、执行记录和资源检查。Core 维护权威租约，持有者只能保存凭证或引用。

Lease 可以短期、长期或不设预定到期日；永久租约仍可撤销且受主体、范围和版本约束。ExecutionPermit 表达本次 Attempt 或步骤的最小执行范围，不等同于可复用 Lease。过期或撤销的执行资格不得继续使用，旧执行实例还需通过 fencing 等机制隔离，不能只检查长期租约是否尚未到期。

副作用记录 EffectRecord。未知效果不得自动重试；先 reconciliation，必要时人工确认。取消停止新准入并请求 drain，不能把进程终止直接解释为业务取消。旧 fencing、旧 revision 或过期 Lease 的结果不能提交当前状态。

## 9. Checkpoint、恢复与补偿

系统区分三类恢复边界：

| 类型 | Owner | 用途 |
|---|---|---|
| Runtime checkpoint | durable runtime | step、timer、signal 和控制流恢复 |
| WorkflowCheckpoint | Workflow | 同一运行的一致恢复、暂停续跑和诊断 |
| SessionCheckpoint | Workflow | 用户可见、长期保留、跨进程派生运行 |

SessionCheckpoint 使用独立 manifest、integrity hash 和跨 Owner retention token，不是可能被 GC 的 WorkflowCheckpoint 行的别名。它不复制其他 Module 数据库行，而是保存版本化引用、内容 hash、保留证明或重建配方。

普通崩溃使用 runtime resume；Unit 失败使用新 Attempt；设计错误使用 replan；外部效果使用 compensation/reconciliation。只有从 SessionCheckpoint 派生运行时创建 RestoreOperation。恢复不从 checkpoint 继承有效 Secret、Grant、Lease、Permit、开放审核或 Executor 会话；持久授权依据可以保留，但永久租约也须按当前主体与定义重新确认。Kernel 提供执行范围收敛、资格和资源核对，Execution 提供 Attempt、步骤与效果事实，Workflow 仍负责恢复编排。

## 10. 人类在环

UserInteraction 收集响应；Workflow 拥有业务等待和决定后的状态转换；Kernel 拥有身份验证、职责分离、Policy、审核请求与权威决定。审核分为 APPROVAL、INFORMATION、DECISION 和 ACCEPTANCE。

审核绑定目标、参数 hash、graphRevision、definition、policyVersion、有效期和审查要求。任何绑定变化使旧审核失效。批准只允许流程回到准入点，不直接授权副作用。

## 11. 数据与一致性

- 每个 Module 使用独立 Schema/角色，不得写其他 Module 的表。
- 领域变化、Journal、Outbox 和本模块投影在同一事务提交。
- 跨模块协作使用 Port、Envelope、Event 和 ArtifactRef，不使用跨 Schema 隐式 Join。
- Inbox 去重，Outbox 至少一次发送，optimistic version 防止并发覆盖。
- Artifact Store 保存不可变大对象；数据库保存引用和业务所有权。
- 投影、索引和缓存可由事实源重建。

运行时状态按 Owner 保存，不提供任意模块可写的全局“AgentOS 内存”。Execution 保存 Attempt 和步骤，Core 保存租约及控制操作，Scheduler 保存调度关联，Monitor 保存预算账本，Supervisor 保存监管事实。审计由各 Owner 记录并关联，不单设可改写全部状态的权威。

## 12. 协议与版本

Command 携带 idempotencyKey 和适用的 expectedVersion；Query 返回 sourceVersion；Event 表示已提交事实；Signal 传递中断或唤醒持久等待；Result 描述异步或 Unit 结果。所有边界运行时校验。

Schema、Definition、Graph、Checkpoint 和 Artifact 显式版本化。未知 major 拒绝；破坏性变化使用新 major 和迁移，不根据字段存在性猜测版本。详细规则见 [Protocol.md](Protocol.md)。

## 13. 安全

安全责任按所有权分布：Core 管授权与接收决定，Gateway 管入口，Scheduler 管推进，Monitor 管额度与账本，Supervisor 管 Sandbox、进程和资源限制；Execution 在受限环境内管理 workspace、步骤、输入输出和 Secret 使用；ContextEngine 管 ACL/revision 过滤；Artifact/Persistence/Communication 管数据和传输保护。Executor 不各自实现权限政策，统一可信入口和执行基础设施落实约束。

租约防篡改不能代替 OS 隔离。用户 Executor 不得直接修改可信 Execution 状态、获得控制面凭据或通过宿主资源旁路访问。租约验证不可确认时默认拒绝。

所有输入均不可信。Secret 不进入 Prompt、协议正文、日志、Artifact 或 checkpoint。tenant/project 在协议、Repository、数据库策略和 Artifact 访问层重复校验。审计记录主体、意图、Policy/Review 引用、版本、准入和效果，但对 Prompt、源代码和个人数据分级脱敏。

## 14. 可观测性

所有事务和执行关联 workflowRunId、missionScopeId、task/attempt、agent、unit/attempt、graphRevision、aggregateVersion、correlation 和 causation。指标至少覆盖状态时长、readiness/Join、队列、模型/tool usage、Lease/fencing、审核、checkpoint/restore、Outbox/Inbox、Artifact、检索质量、错误和成本。

Telemetry 是派生数据，不是业务事实源。Monitor 的预算账本是权威状态，不能用可丢失或采样指标替代。完整 Prompt、源码、工具结果和 Secret 不得作为 span attribute。

流式输出通过受控逻辑通道展示，与 Kernel 已接受结果和 Workflow 验收分开。订阅需绑定身份和运行范围；模型推理展示仅限供应商实际提供且允许展示的内容或摘要。

## 15. 部署与演进边界

系统从模块化单体开始，目标运行平台为 Ubuntu LTS。当前 `apps/control-plane` 是最终组合根；最小引导入口先建立 Kernel，再由 Supervisor 下的 ModuleHost 装配独立 package 和 Adapter，避免自引导依赖环。领域包只依赖 Shared Contracts 和声明的 Port。进程拆分、远程 Executor、外部 broker、数据库或对象存储替换不得改变领域 Owner、协议语义和主调用方向。

部署必须支持 readiness、drain、Schema migration、备份/PITR、Artifact 一致性验证和灾难恢复演练。数据库恢复不自动恢复 Lease、Grant、Secret 或活 Executor。具体 Ubuntu LTS 版本、IPC、进程映射与隔离配置由各 MVP 给出验证；长期技术基线保留在 TechStack，未开放能力应明确范围，而非削弱其语义。

## 16. 系统级不变量

1. 人类输入固定经 UserInteraction 和 Kernel；UserInteraction 不直写运行状态。
2. Workflow 创建 AgentRun 和 UnitIntent；Execution 根据 Kernel 获准的请求创建 UnitAttempt。Workflow 不得绕过 Kernel 直连执行组件。
3. AgentRun 只能使用其固定 AgentDefinitionVersion 允许的 Unit；所有 Tool 调用必须封装为 Unit。
4. Kernel 必须验证 Agent→Unit→Tool 成员关系，并按 Unit capability 选择运行时 Executor。
5. Executor 不回调 Workflow；结果先由 Kernel 校验。
6. ContextEngine 不扩大 ACL、不修改工作区、不决定任务成功。
7. AgentToolPool 的目录声明不构成执行授权，静态 Executor 定义不等同于运行时 Executor 实例。
8. 未持有当前 revision、有效 Permit/Lease 和最新 fencing 的 Attempt 不得产生可提交副作用。
9. 最终完成前必须满足 required Task/Join、验收、Artifact、Signal/Review、execution drain 和 effect reconciliation。
10. 未知能力、协议 major、权限、效果或完整性状态默认拒绝。
11. 终态、不可变版本和已发布 Artifact 不得原地覆盖。
12. Architecture 的算法与所有权变更必须同步更新协议、交付范围和自动化测试。

### 16.1 AgentOS 控制机制

AgentOS 调用、中断信号、故障异常由 Core 内的控制分派职责统一登记处理者、关联目标与跟踪结果。调用接受不等于完成，中断送达不等于生效；Execution 响应安全点，Scheduler 限制推进，Monitor 提供超限依据，Supervisor 监管与回收。

权限变化默认在后续检查点体现；在途长操作仍需超时和监管。执行故障主动通知 Workflow，由其决定业务重试或补偿。普通失败不触发全局 panic；关键安全不变量失守时进入受控安全停机。

## 17. 验证

验证分为 Schema/contract、领域状态机与属性、Adapter、事务故障注入、集成、端到端、安全、恢复和性能基准。必须覆盖重复/乱序/迟到消息、进程 kill、Outbox ack 丢失、Executor 失联、旧 fencing、并发 GraphPatch、审核失效、checkpoint Saga 部分失败、restore 缺失依赖、Artifact 损坏、越权访问、集成冲突和最终 drain。
