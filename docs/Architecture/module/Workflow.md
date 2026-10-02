# MultiAgentOS Workflow

## 1. 定义与边界

Workflow 是目标分解、业务图推进、监督、验收、恢复和补偿语义的唯一权威。它回答“业务上接下来应做什么、结果是否满足目标”，不回答“当前主体是否有权限、在哪执行或分配多少物理资源”。

Workflow 负责 TaskGraph、MissionScope、Task/Agent 状态、GraphPatch、ChangeSet 集成、人工等待、Workflow/Session checkpoint、RestoreOperation、补偿和最终报告。它创建 AgentRun 与 UnitIntent，不创建 UnitAttempt，也不直接调用模型、工具、ContextEngine、文件系统、Git、Sandbox 或外部服务。

## 2. 领域对象

```text
WorkflowRun
├── TaskGraph @ GraphRevision
│   └── TaskRun -> TaskAttempt -> AgentRun -> AgentStep
└── MissionScope Tree
    └── objective / budget / capability ceiling / workspace / cancel boundary

AgentRun -> UnitIntent -> Kernel 准入 -> Execution 创建 UnitAttempt
        -> 候选结果 / ArtifactRef -> Kernel 确认 -> Workflow 消费 Event
WorkflowRun -> WorkflowCheckpoint -> SessionCheckpoint
WorkflowRun -> IntegrationAttempt / RestoreOperation / CompensationTask
```

| 对象 | 语义与不变量 |
|---|---|
| WorkflowRun | 一次完整目标运行；终态不可恢复为运行态 |
| GraphRevision | 完整有效任务图的不可变版本；Patch 产生新版本 |
| TaskRun | 稳定逻辑任务身份及最终 Resolution |
| TaskAttempt | 固定输入、revision、attemptNo 和执行策略的一次尝试 |
| MissionScope | 目标谱系、预算、权限 ceiling、workspace、可见范围、取消和完成边界 |
| AgentRun | 某不可变 AgentDefinitionVersion 在 TaskAttempt 内的智能行为；固定允许的 UnitDefinitionVersion 集合 |
| AgentStep | Context、Model、Action、Observation 的离散持久边界 |
| IntegrationAttempt | 确定性合并 ChangeSet 并运行 QualityGate 的一次尝试 |
| HumanReviewWait | Workflow 对权威 HumanReviewDecision 的持久等待 |
| WorkflowCheckpoint | 同一运行的内部一致恢复边界 |
| SessionCheckpoint | 用户可见、长期保留、可派生新运行的恢复边界 |
| RestoreOperation | 从 SessionCheckpoint 派生运行的持久 Saga |

TaskGraph 决定业务依赖是否就绪；MissionScope Tree 决定业务监督归属及预算/能力/workspace 上限；WorkSession/SessionTree 决定“用户如何组织多次运行”。三者不得互相替代。实际执行机会由 Kernel Scheduler 分配，资源额度、预留与结算由 Monitor 维护。

## 3. 组件

Workflow 内部至少包含：Command Gateway、WorkflowRun Manager、TaskGraph Manager、Readiness/Join Evaluator、TaskAttempt Manager、MissionScope Supervisor、AgentRun Coordinator、Planning/Replanning Coordinator、Integration Coordinator、Human Review Coordinator、Checkpoint Manager、Restore Coordinator、Compensation Coordinator、Durable Runtime Adapter 和 Projector。

领域 Reducer 必须是纯函数：`state + command/event -> new state + domain events`。Application 层只依赖 Port；技术 SDK 位于 Adapter。

### 3.1 定义固定与运行对象

创建 AgentRun 时，Workflow 必须从 AgentToolPool 只读解析一个具体 AgentDefinitionVersion，并固定其 digest、输入输出 Contract 及完整 `allowedUnitRefs`。该集合是本次 AgentRun 的能力上限；目录后续发布的新 Unit 不会自动进入既有运行。

Workflow 只能为固定集合中的 UnitDefinitionVersion 创建 UnitIntent。UnitIntent 必须绑定 agentRunId、agentDefinitionVersionRef、unitDefinitionVersionRef、输入引用、逻辑幂等键、graphRevision、MissionScope 和 deadline。Workflow 不选择运行时 Executor，也不得在 UnitIntent 中携带 executorId。

## 4. TaskGraph 与 GraphRevision

TaskGraph 是带输入输出 Contract 的有向无环图。发布 GraphPatch 的流程固定为：加载 current revision → 校验 baseRevision → 在内存应用 Patch → 验证无环、引用、Contract、限制和影响闭包 → 持久化完整新 revision 与差异 → 发布 Event。任一步失败不得留下部分图。

GraphPatchProposal 至少包含 baseRevision、targetMissionScope、保留/失效节点、Edge/Contract 变化、预算、Capability、Evidence 和回滚说明。未受影响分支继续执行前仍须验证共享 Artifact、workspace ownership、输入 Contract 和权限隔离。

Revision barrier 阻止受影响范围创建新 Unit；迟到结果只有匹配当前 revision、Attempt 和 fencing 时才可提交。

## 5. Readiness 与 Join

Readiness Evaluator 是确定性、无副作用函数。输入为 GraphRevision、上游 Resolution、ArtifactRef、JoinPolicy、MissionScope 状态和 Signal；输出为候选状态、理由、缺失依赖和固定输入绑定。

- ALL：全部 required 上游成功。
- ANY：首个合格结果满足并固定选中分支。
- QUORUM：至少 k 个合格结果且满足最小数据 Contract。
- Custom：实现必须版本化、确定性、超时受控并保存输入 hash。

Join 满足后，迟到分支不得改变输入集合；重新打开必须发布新 GraphRevision。

## 6. MissionScope

MissionScope Supervisor 负责创建监督树、预算继承、capability ceiling、workspace 边界、取消传播、影响闭包和完成条件。父级预算/能力是上限，子级不得扩大。

预算采用 reservation/commit/release：Scheduler 申请资源机会，Monitor 确认额度、预留并按实际 usage 结算；失败或取消后核对消耗，再释放未使用的预留，未知消耗保留待核对状态。Workflow 维护业务 budget envelope、步数与收尾，不成为 Provider 或资源用量的事实源。

父 Scope 取消默认传播到子 Scope；子 Scope 失败是否传播由 required 和 JoinPolicy 决定。Scope 的状态变化必须发布版本化 Event。

## 7. AgentRun 循环

```text
加载 AgentRun checkpoint
-> 依据固定 AgentDefinitionVersion 选择允许的 Unit
-> 创建 Context UnitIntent
-> 创建 Model UnitIntent
-> 校验结构化动作
-> 将 Tool 动作提案映射为已允许的 UnitIntent，或形成 Proposal
-> 追加 Observation
-> 持久化 AgentStep
-> 继续、等待或提交 AgentResult
```

模型只能输出结构化动作提案、Signal、SpawnProposal、GraphPatchProposal 或 AgentResult。Workflow 依据固定定义把合法动作提案转换为 UnitIntent；模型不得自行扩大允许 Unit 集合或指定 Executor。每个等待保存 correlation、类型、deadline 和恢复位置；恢复后复用同一逻辑幂等键。非法输出保存原始 Artifact，并按 Contract 错误采用修复提示、替代定义、重新规划或失败，禁止无限重试。

所有 Tool 调用都必须由一个已发布 UnitDefinitionVersion 封装，一 Unit 对应一个 Tool 粒度操作，Tool 内的固定 Executor 序列由 Execution 推进。Workflow 不生成裸 Tool 调用；若动作提案引用的 Tool 与目标 Unit 不对应，或目标 Unit 不属于 AgentRun 的允许集合，必须拒绝并记录结构化 Contract 错误。

Context 装配、检索和文件读取的具体路径见 ContextEngine 和 Execution 文档。

## 8. TaskAttempt 与结果验收

Attempt 创建以 `(taskRunId, attemptNo)` 唯一，并固定 readiness event sequence、输入 Artifact、GraphRevision 和策略。接收结果时依次校验 owner、revision/barrier、Attempt 非终态、输出 Contract、Artifact 完整性、来源和 acceptance criteria。

失败处理：TRANSIENT/RATE_LIMIT 可在 deadline、预算和幂等条件内重试；TIMEOUT 先检查副作用；CONTRACT 采用替代或 replan；POLICY 等待审核、降级或失败；RESOURCE 排队或降级；PERMANENT 失败传播；UNKNOWN_EFFECT 进入 reconciliation/NEEDS_ATTENTION。

UnitAttemptSucceeded 只说明物理操作成功。AgentResult 经 TaskAttempt 验收后才能形成 Task Resolution。

## 9. 状态机

### 9.1 WorkflowRun

```text
CREATED -> RESTORING? -> PLANNING -> RUNNING <-> PAUSING -> PAUSED
                                      |          |
                                      +-> REPLANNING
                                      +-> CANCELLING -> CANCELLED
                                      +-> FINALIZING -> SUCCEEDED
                                      +-> FAILED
                                      +-> NEEDS_ATTENTION
```

RESTORING 在 required RestoreAction 完成前不得进入普通执行。FINALIZING 执行最终验收和 Kernel drain。NEEDS_ATTENTION 用于未知副作用、恢复不完整或补偿失败，只能经明确处置离开。SUCCEEDED、FAILED、CANCELLED 为不可逆终态。

### 9.2 TaskAttempt 与 AgentRun

TaskAttempt：`CREATED -> WAITING_FOR_ADMISSION -> RUNNING -> VALIDATING -> SUCCEEDED|FAILED`，可进入 WAITING_HUMAN_REVIEW、CANCELLING/CANCELLED 或 ABANDONED。

AgentRun：`CREATED -> ASSEMBLING_CONTEXT -> THINKING -> WAITING_UNIT -> THINKING`，也可进入 WAITING_SIGNAL、WAITING_HUMAN_REVIEW、CHECKPOINTING，最终到 RESULT_SUBMITTED、FAILED 或 CANCELLED。

### 9.3 IntegrationAttempt

`CREATED -> MATERIALIZING -> APPLYING -> VALIDATING -> SUCCEEDED`；旁路终态为 CONFLICTED、FAILED、CANCELLED。重试创建新 IntegrationAttempt，不覆盖原结果。

## 10. Integration

Coding 或脚本 Executor 的结果必须包含不可变 ChangeSet，而不是自然语言成功声明。Integration Coordinator 依据 TaskGraph 拓扑序、显式 integrationOrder、Task logicalKey 和 changeSetId 形成确定性 IntegrationPlan；Event 到达时间不参与排序。

Workflow 通过 Kernel Unit 在干净 workspace 中物化 base、应用 ordered ChangeSet、分类冲突并运行 QualityGate。成功结果绑定 base revision、ordered ChangeSet hash、最终 diff/commit Artifact 和 QualityGateResult。推送、创建 PR 和部署是独立副作用 Unit。

## 11. 人类审核

Workflow 在以下场景持久等待：

| 类型 | 用途 | 决定后的业务行为 |
|---|---|---|
| APPROVAL | 高风险动作、权限或预算突破 | 批准后仍等待 Kernel 重新准入；拒绝则替代、replan 或失败 |
| INFORMATION | 缺少必要事实 | 固定新 PromptRevision/Artifact 输入后继续 |
| DECISION | 多个合法方案需选择 | 固定 option 和 Evidence，必要时发布 GraphPatch |
| ACCEPTANCE | 中间结果或最终结果验收 | 接受完成；拒绝创建返工 Attempt 或 replan |

HumanReviewWait 保存 reviewId、类型、目标引用、requestVersion、graphRevision、policyVersion、parametersHash、allowedDecisions、resumeToken、deadline 和状态。参数、目标、revision、definition、policy、prompt、checkpoint、预算或业务状态变化时，旧 wait 必须失效；超时不得自动批准。

消费 Decision 的顺序为 Inbox 去重 → 绑定/版本/有效期检查 → 锁定 wait 与聚合 → 写 decisionRef → 运行 Reducer → 更新 wait → Event/Outbox → 提交 → 恢复控制流。

## 12. Checkpoint

Workflow 明确区分：durable runtime checkpoint、WorkflowCheckpoint 和 SessionCheckpoint。WorkflowCheckpoint 用于同一运行恢复与诊断；SessionCheckpoint 是用户可见、长期、具有独立 manifest 和 retention 的安全边界。

Checkpoint Manager 负责：

1. Consistency Barrier：停止新 Unit，处理运行中 Unit，刷新事务/Outbox，确认副作用水位。
2. Manifest Builder：收集 TaskGraph、MissionScope、Task/Agent、Signal、Artifact、workspace、effect ledger，以及固定的 Agent/Unit/Tool/Executor DefinitionVersion 引用，计算 integrity hash。
3. Promotion：按策略将一致状态物化为独立 SessionCheckpoint。
4. Retention：调用各 Owner 的 CheckpointParticipant，管理可用性和 GC roots。

SessionCheckpoint 状态为 `CREATING -> PREPARING -> COMMITTING -> AVAILABLE`；也可进入 FAILED、DEGRADED、INCOMPATIBLE、REVOKED、CORRUPTED 或删除流程。只有 AVAILABLE 可以直接恢复。

SessionCheckpoint 不保存 Secret、Grant、Lease、ExecutionPermit、活 Executor 会话或开放审核的可复用授权。

## 13. Restore

RestoreOperation 只用于从 SessionCheckpoint 派生运行。默认创建新的 WorkflowRun 和 durable execution；同一运行 resume 只有在 runtime identity、代码和历史明确兼容时才允许。

状态为 `REQUESTED -> VALIDATING -> PLANNING -> MATERIALIZING -> RECONCILING -> READY`，旁路为 FAILED、CANCELLED、NEEDS_ATTENTION。RestorePlan 对 Workflow 自有状态执行 CLONE/REBUILD；Artifact、Definition、Context、workspace、Grant/Secret 和副作用分别交给权威 Owner REFERENCE、REVALIDATE、REBUILD、MATERIALIZE、REISSUE 或 RECONCILE。

任一 required action 失败时，新运行不得部分启动。UserInteraction 只在新运行提交后追加 SessionTree 分支。

## 14. 取消、重试、重跑与补偿

- Pause 停止创建新工作并在一致边界等待；Resume 延续同一运行。
- Cancel 表达停止目标，先传播 Scope，再等待 Kernel drain；物理终止不等于取消完成。
- Retry 的业务决定由 Workflow 作出；新的 UnitAttempt 由 Execution 经 Kernel 准入后创建，TaskAttempt 由 Workflow 创建；未知效果先核对。Rerun 创建新的业务运行；Fork 从明确输入或 checkpoint 派生。
- Replan 发布新 GraphRevision，不回写历史。
- 已发生副作用由 Compensation Coordinator 基于 EffectRecord 和版本化 policy 创建反向 Task。不可补偿、状态未知或补偿失败进入 MANUAL_INTERVENTION_REQUIRED/NEEDS_ATTENTION。

## 15. 持久性与 durable runtime

Workflow 的聚合、Journal、Outbox 和投影在同一事务提交。Durable Runtime Adapter 隔离 runtime SDK，提供 start、signal、timer、await correlation、status、cancel control flow 和兼容性验证。Runtime 恢复控制流，不拥有 TaskGraph，也不得在可重放步骤直接执行模型、工具、文件、网络或数据库副作用。

所有可恢复 Agent/Workflow 数据在 step 边界写入数据库或 Artifact；不得依赖进程内对象。

## 16. 完成判定

完成候选必须同时满足：required Task Resolution、Join、MissionScope、acceptance、Artifact、Review/Signal、Integration/QualityGate 和副作用状态。Workflow 发布 CompletionProposed 后，Kernel 停止本次范围的新调度，收敛在途步骤、资源持有和执行凭证，核对效果与账本并形成 ExecutionScopeDrained；无未知 effect 且审计完成后，Workflow 才提交最终成功。主体在其他工作中仍有效的长期租约不阻止本次完成。

## 17. 错误、可观测性与测试

Workflow 只解释错误对业务状态的影响；身份、Policy、Execution、Context、Definition 和 Artifact 原始错误由其 Owner 分类。所有错误处理在目标聚合事务中提交，不覆盖终态，不删除原始 Event。

指标包括各状态时长、readiness 延迟、Join 等待、Attempt/Agent 周期、GraphPatch 失败、冲突、重复/迟到 Event、审核等待、checkpoint 创建/验证/GC、restore action、Outbox backlog、预算预留与结算偏差。

测试必须覆盖状态机、DAG/Join 属性、GraphPatch 原子性、MissionScope 继承、Agent 定义固定、Unit 允许集合、裸 Tool 调用拒绝、重复/乱序/迟到结果、pause/cancel 竞态、审核失效、checkpoint Saga 各崩溃点、restore 必需动作失败、ChangeSet 冲突、QualityGate、补偿失败、durable runtime 恢复及最终 drain。
