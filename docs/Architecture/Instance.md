# MultiAgentOS 运行实例

本文以端到端路径说明组件如何形成闭环。字段和消息语义以 [Protocol.md](Protocol.md) 为准。

## 1. 启动与组合

```text
Control Plane 最小引导入口 -> Kernel 控制基础
-> Supervisor / ModuleHost 校验配置、依赖和协议 Registry
-> 装配 Persistence / Artifact / Communication Adapter
-> 启动 AgentToolPool / ContextEngine / Workflow / Execution / UserInteraction
-> 执行 health/readiness
-> 开放 CLI/Web/API
```

启动失败按依赖逆序停止已启动组件。Migration、Protocol major 或必需 capability 不满足时不得进入 READY。

## 2. 创建 WorkSession 与运行

```text
User -> UserInteraction: 创建 WorkSession、PromptRevision、UserIntent
UserInteraction -> Kernel: submit(UserIntent, IdentityContext)
Kernel: 认证、授权、版本、Policy 与幂等准入
Kernel -> Workflow: 已准入 CreateWorkflow Command
Workflow: 创建 WorkflowRun、根 MissionScope、GraphRevision
Workflow -> AgentToolPool: 解析 AgentDefinitionVersion 及 Unit/Tool 定义闭包
Workflow: 固定定义引用并创建 AgentRun
Workflow -> Outbox: WorkflowCreated
Kernel: 汇总 RuntimeProjection
Kernel -> UserInteraction: 版本化投影
```

CLI/Web 不直接创建 WorkflowRun。UserInteraction 只在已提交 Event 后展示运行节点。

## 3. Repository Analysis

### 3.1 已知文件

Workflow 创建 CONTEXT(ORIENT/ASSEMBLE) 和 FILE_READ UnitIntent；Kernel 准入后分别调用 ContextEngine 与 Execution。模型根据不可变 ContextPack/Observation 提出 FINAL；Workflow 验证 repository revision、path、line 和 provenance 后生成报告。

### 3.2 未知文件

```text
ORIENT -> MODEL -> SEARCH(PATH/TEXT/SYMBOL) -> Observation
-> MODEL -> READ -> Observation -> MODEL -> FINAL
```

ContextEngine 维护检索台账和去重。零结果返回查询建议，不用无关内容填充。Workflow 检测重复动作和无进展循环。

### 3.3 跨文件数据流与影响分析

模型通过多轮 SEARCH/READ 连接接口、实现、调用方、测试和配置。ContextEngine 在 token 预算内保留最近 Observation、压缩旧步骤并维持稳定前缀。Workflow 要求每条关键链路有来源；影响分析只生成变更位置和风险时，不隐式执行写入。

## 4. Agent 与 Unit 循环

```text
Workflow: readiness -> TaskAttempt -> AgentRun
Workflow: 从 AgentRun.allowedUnitRefs 创建 UnitIntent
Workflow -> Kernel: UnitIntent + 固定定义引用
Kernel: 校验 Agent->Unit->Tool 成员关系
Kernel: capability/Policy/budget/revision/workspace admission
Gateway: 有效租约直接进入执行路径，否则由 Core 裁决并签发
Execution: 幂等创建 UnitAttempt，准备 Tool 的 Executor 序列
Scheduler / Monitor: 为就绪步骤选择实例、分配容量和预留额度
Supervisor: 提供受限执行环境
Execution / Context 执行目标 -> Kernel: 候选 UnitResult + ArtifactRef + EffectRecord
Kernel: fencing/revision/Contract/integrity validation
Kernel -> Workflow: committed Event
Workflow: AgentStep -> acceptance -> next Unit or AgentResult
```

重复 Event 由 Inbox 去重；迟到或旧 fencing 结果只保存 Evidence。所有 Tool 调用必须由 UnitDefinitionVersion 封装。模型 tool call 只是动作提案，必须由 Workflow 映射为 AgentRun 允许的 UnitIntent，再返回 Kernel 重新准入，不能在 Model Adapter 内直接执行。

### 4.1 Tool 序列与租约复用

一个 Unit 对应一个 Tool 粒度操作，Execution 按固定序列推进 Executor。
原子 Executor 表示最小组合操作，不保证全部效果可回滚。
有效租约可复用于后续请求，但仍创建本次执行关联并检查定义、范围及当前额度。
模型提出的新业务动作必须返回 Workflow，不能在现有序列上任意追加。

### 4.2 API 调度与计量

多个就绪模型步骤由 Scheduler 在 API 池中安排容量；Monitor 预留预算，
Execution 模型网关实际发送请求并提供用量。步骤未就绪时不能提前长期占据 API 槽位。
未知消耗留待核对，不能在超时后直接释放全部预留。拥塞反馈只能在硬额度内调节。

## 5. 并行 Task 与 Join

Readiness Evaluator 根据当前 GraphRevision 创建多个 TaskAttempt；每个 Attempt 使用独立 MissionScope 子树、预算和 workspace。ALL/ANY/QUORUM 满足后固定输入集合。迟到分支不能改变已满足 Join，除非新 GraphRevision 明确重新打开。

父 Scope 取消传播到子 Scope；子任务失败是否阻断父级由 required 与 JoinPolicy 决定。

## 6. Coding、ChangeSet 与集成

```text
TaskAttempt -> Kernel -> isolated Execution workspace
-> FILE_WRITE / COMMAND / TEST Unit
-> ChangeSet + executor evidence
Workflow: 验收 ChangeSet
-> 确定性 IntegrationPlan
-> Kernel -> clean integration workspace
-> apply ordered ChangeSets -> QualityGate
-> IntegratedRevision / conflict evidence
```

IntegrationPlan 开始物化后不可修改。Base mismatch、路径预检冲突、patch 冲突或 QualityGate 失败均停止完成并保留 Evidence。Push、PR 和部署另发副作用 Unit。

## 7. 运行中变更与 replan

Agent 或用户提出 GraphPatchProposal，Workflow 校验 baseRevision、影响闭包、Contract、预算和能力后发布新 GraphRevision。受影响 Scope 进入 revision barrier；Kernel 停止签发不兼容 Permit。未受影响分支仅在输入、Artifact、workspace 和权限仍有效时继续。

并发 Patch 由 expected revision 决胜；失败提案基于最新事实重新计算，不自动合并。

## 8. 人类审核

```text
Workflow -> Kernel: HumanReviewIntent
Kernel: Policy/risk -> HumanReviewRequest
Kernel -> UserInteraction: ReviewProjection + filtered Evidence
User -> UserInteraction: ReviewResponse
UserInteraction -> Kernel: response
Kernel: identity/role/SoD/parameters/version/expiry validation
Kernel -> Workflow: HumanReviewDecision
Workflow: apply decision in aggregate transaction
-> if APPROVAL, submit Unit again for fresh admission
```

参数、revision、definition、policy 或预算变化使旧决定失效。超时默认拒绝继续；取消与决定并发时由聚合版本和状态机裁决。

## 9. 保存 SessionCheckpoint

```text
Workflow: consistency barrier + candidate manifest
-> participant.prepareRetention by owner
-> materialize required Artifact/workspace recipe
-> persist manifest + integrityHash + Outbox
-> participant.commitRetention
-> verify required tokens ACTIVE
-> SessionCheckpoint AVAILABLE
-> UserInteraction displays checkpoint
```

任一 required dependency 不存在、不可保留、不可重建或 Contract 不兼容时，abort/release 并进入 FAILED/INCOMPATIBLE。可选依赖失败只能产生带缺失清单的 DEGRADED，不得伪装 AVAILABLE。

## 10. 从 SessionCheckpoint 派生运行

```text
User selects AVAILABLE checkpoint
-> UserInteraction creates optional PromptRevision
-> Kernel validates identity/visibility/restore permission
-> Workflow validates manifest/integrity/retention
-> creates RESTORING WorkflowRun + RestoreOperation
-> executes RestorePlan by owner
-> Artifact REFERENCE, Definition REVALIDATE, Context REBUILD,
   workspace MATERIALIZE, Grant/Secret REISSUE, effects RECONCILE
-> all required actions pass
-> new run READY/PLANNING
-> SessionTree adds committed branch
```

普通进程重启、Unit retry、replan 或 compensation 不走此路径。新运行不继承旧 Lease、Permit、Secret、开放审核或 Executor 会话。

## 11. Pause、Cancel 与补偿

Pause 使受影响 Scope 停止创建新 Unit，并在一致边界进入 PAUSED；Resume 延续同一运行。Cancel 传播 Scope，Kernel 停止新准入并 drain/终止 Execution。只有 Workflow 在结果、Lease 和 effect 状态明确后提交 CANCELLED。

已发生外部副作用时，Workflow 依据 EffectRecord 创建显式 CompensationTask。补偿失败、不可补偿或效果未知进入 NEEDS_ATTENTION，不得隐藏历史或伪报成功。

### 11.1 AgentOS 调用与中断处理

取消调用经 Gateway 验证，Core 控制分派器记录目标与处理者；
Scheduler 停止受影响调度，Execution 在安全点停止序列，Supervisor 监管或终止执行域。
Monitor 核对消耗，Execution 汇报效果，Kernel 返回控制结果，Workflow 才确认业务取消。
收到或送达信号不等于实际停止；不可取消的远程请求仍需跟踪。
本次取消不自动撤销其他工作使用的长期租约。

## 12. 故障、重启与重连

- Control Plane 崩溃：durable runtime 恢复控制流；Outbox/Inbox 保证事实不丢失、不重复生效。
- Executor 失联：Supervisor 先限制相关执行域，Execution 核对步骤及外部效果；符合重试规则并重新获准后才创建新 Attempt，旧 fencing 结果拒绝。Lease 到期不证明外部操作未发生。
- Artifact 写入成功但事务失败：对象成为孤儿，grace period 后 GC。
- Provider 状态未知：进入 effect reconciliation，不自动重复调用。
- UI 断线：运行继续；重连依据事件游标和 Query 重建视图。
- Index 不可用：ContextEngine 使用兼容旧版本或显式 DEGRADED，不混合半构建索引。
- 必需恢复依赖缺失：Checkpoint 标记 DEGRADED/INCOMPATIBLE，不启动部分运行。

### 12.1 异常升级与 panic

Execution、Monitor、Supervisor 或 Core 发现异常后提供已知事实和影响范围。
紧急保护可以先行，Core 分派器跟踪处理与升级，执行故障主动通知 Workflow。
工具崩溃、超时等优先局部处理；权限账本损坏等关键安全不变量失守才进入安全停机。
停机冻结新调度并回收执行域，不依赖已崩溃 Kernel 必然发出最后通知。

## 13. 最终完成

```text
Workflow: all required Task/Join/Acceptance/QualityGate satisfied
-> CompletionProposed
Kernel + Execution: stop new work in scope, drain active executions,
   reconcile effects, verify audit/resource usage and scoped permits
-> ExecutionScopeDrained
Workflow: FINALIZING -> SUCCEEDED
Kernel -> RuntimeProjection -> UserInteraction
```

任一 required Signal/Review、Artifact、在途执行、待收敛资源、未知 effect 或验收未完成都会阻止成功。主体在其他范围有效的长期租约不单独阻止本次完成。报告包含结论、来源、Agent/Unit/Tool/Executor DefinitionVersion、GraphRevision、ChangeSet/QualityGate、步骤、用量、成本、未确认项和错误。

## 14. 查询运行状态

INSPECT/REPORT 由 UserInteraction 提交 Kernel。Kernel 组合 Workflow 的版本化业务视图和自身执行事实，发布 RuntimeProjection。UserInteraction 不读取 Workflow Repository、Kernel 审计表、Artifact Store 或 Executor 内部状态。

### 14.1 只读能力与流式展示

可信 Module 可以使用范围受限的长期租约读取定义或 Artifact，不必每次进入 Core。
访问边界仍检查身份、数据范围和有效性，ArtifactRef 不是授权。

UserInteraction 经授权逻辑通道订阅暂态输出，权威状态仍来自 Kernel 汇总视图。
断线重建、顺序和慢消费者处理与确认结果分开，模型片段不能直接变为成功状态。
