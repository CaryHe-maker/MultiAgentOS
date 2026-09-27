# MultiAgentOS 运行实例

本文以端到端路径说明组件如何形成闭环。字段和消息语义以 [Protocol.md](Protocol.md) 为准。

## 1. 启动与组合

```text
Control Plane -> Module Host
-> 校验配置和协议 Registry
-> 启动 Persistence / Artifact / Communication Adapter
-> 启动 AgentToolPool / ContextEngine / Workflow / Kernel / UserInteraction
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
Kernel: 按 Unit.requiredCapabilities 选择运行时 Executor
Kernel -> Execution/ContextEngine: UnitAttempt + Permit
Executor -> Kernel: UnitResult + ArtifactRef + EffectRecord
Kernel: fencing/revision/Contract/integrity validation
Kernel -> Workflow: committed Event
Workflow: AgentStep -> acceptance -> next Unit or AgentResult
```

重复 Event 由 Inbox 去重；迟到或旧 fencing 结果只保存 Evidence。所有 Tool 调用必须由 UnitDefinitionVersion 封装。模型 tool call 只是动作提案，必须由 Workflow 映射为 AgentRun 允许的 UnitIntent，再返回 Kernel 重新准入，不能在 Model Adapter 内直接执行。

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

## 12. 故障、重启与重连

- Control Plane 崩溃：durable runtime 恢复控制流；Outbox/Inbox 保证事实不丢失、不重复生效。
- Executor 失联：Lease 过期后创建新 Attempt；旧 fencing 结果拒绝。
- Artifact 写入成功但事务失败：对象成为孤儿，grace period 后 GC。
- Provider 状态未知：进入 effect reconciliation，不自动重复调用。
- UI 断线：运行继续；重连依据事件游标和 Query 重建视图。
- Index 不可用：ContextEngine 使用兼容旧版本或显式 DEGRADED，不混合半构建索引。
- 必需恢复依赖缺失：Checkpoint 标记 DEGRADED/INCOMPATIBLE，不启动部分运行。

## 13. 最终完成

```text
Workflow: all required Task/Join/Acceptance/QualityGate satisfied
-> CompletionProposed
Kernel: stop new permits, drain active leases, reconcile effects,
   verify audit/resources/grants
-> ExecutionScopeDrained
Workflow: FINALIZING -> SUCCEEDED
Kernel -> RuntimeProjection -> UserInteraction
```

任一 required Signal/Review、Artifact、Lease、未知 effect 或验收未完成都会阻止成功。报告包含结论、来源、Agent/Unit/Tool/Executor DefinitionVersion、GraphRevision、ChangeSet/QualityGate、步骤、用量、成本、未确认项和错误。

## 14. 查询运行状态

INSPECT/REPORT 由 UserInteraction 提交 Kernel。Kernel 组合 Workflow 的版本化业务视图和自身执行事实，发布 RuntimeProjection。UserInteraction 不读取 Workflow Repository、Kernel 审计表、Artifact Store 或 Executor 内部状态。
