# MultiAgentOS Kernel

## 1. 定义与边界

Kernel 是身份、Policy、执行准入、运行时调度、Grant、Lease、fencing、HumanReviewDecision、审计和 RuntimeProjection 的唯一权威。它决定一个 UnitIntent 能否执行、由哪一个运行时 Executor 执行，以及执行结果能否提交；它不创建 AgentRun、不决定业务下一步、不修改静态定义，也不把物理成功解释为 Task 成功。

Workflow 创建 AgentRun 和 UnitIntent；Kernel 创建 UnitAttempt。AgentToolPool 保存不可变定义；Kernel 仅以只读方式解析并校验这些定义。

## 2. 权威对象

| 对象 | 语义 |
|---|---|
| AdmissionDecision | 对一个 UnitIntent 的版本化准入结论及理由 |
| UnitAttempt | 一次具体执行尝试，绑定 UnitIntent、定义版本、运行时 Executor、Lease 与 fencing |
| ExecutionPermit | 对最小 capability、workspace、资源、网络、Secret 和期限的短期许可 |
| ExecutorInstance | 运行时执行目标的身份、健康度、负载和可用 capability 投影 |
| Grant / Lease | 限定权限和时间的执行资格；不表示业务所有权 |
| EffectRecord | 已发生、未发生或未知副作用的权威执行事实 |
| AuditRecord | 身份、意图、定义、Policy、准入、调度和结果校验记录 |
| RuntimeProjection | 面向 UserInteraction 的版本化运行视图 |

Kernel 不拥有 AgentDefinitionVersion、UnitDefinitionVersion、ToolDefinitionVersion 或 ExecutorDefinitionVersion 的内容；这些对象由 AgentToolPool 发布。

## 3. Unit 准入

Kernel 按以下固定顺序处理 UnitIntent：

```text
校验 Schema、身份链、幂等键与 deadline
-> 读取 AgentRun 固定的 AgentDefinitionVersionRef
-> 按 digest 读取 Agent/Unit/Tool 定义闭包
-> 验证 Unit 属于 Agent.allowedUnitRefs
-> 验证 Tool 属于 Unit.toolRefs
-> 校验输入输出 Contract 与 graphRevision
-> 校验 MissionScope capability ceiling、Policy、预算和 workspace
-> 按 Unit.requiredCapabilities 筛选运行时 Executor
-> 创建 UnitAttempt、Grant、Lease、fencing 与 ExecutionPermit
-> 调度并提交审计事实
```

任一步失败均不得创建可执行 Permit。定义未知、未固定、被隔离或撤销、digest 不匹配、Agent→Unit 或 Unit→Tool 成员关系无效、capability 不足时默认拒绝。目录中的风险和 capability 声明是准入输入，不是授权结论。

## 4. Executor 选择

AgentToolPool 的 ExecutorDefinitionVersion 描述静态执行器类别；Kernel 维护运行时 ExecutorInstance 投影。选择流程必须同时满足：

1. ExecutorInstance 引用一个有效且已固定的 ExecutorDefinitionVersion；
2. 提供 UnitDefinitionVersion 要求的全部 capability；
3. 支持对应输入输出 Contract、Tool、数据等级和隔离级别；
4. 满足 workspace、Secret、网络、资源、地域和 deadline 约束；
5. 处于可接收新工作的健康状态。

多个候选同时满足时使用版本化、可审计的确定性策略或显式调度策略。UnitIntent 不得指定物理 executorId；调用方只能声明 UnitDefinitionVersion 和允许的约束。ContextEngine 可以作为 CONTEXT capability 的执行目标，Model/Tool/Workspace/Sandbox Adapter 由 Execution 执行面承载，但两者都必须接收 Kernel 创建的 UnitAttempt 与 Permit。

## 5. Tool 调用约束

Tool 没有独立准入路径。所有 Tool 调用必须封装为 Unit，并满足以下条件：

- AgentDefinitionVersion 允许该 UnitDefinitionVersion；
- UnitDefinitionVersion 明确允许该 ToolDefinitionVersion；
- UnitIntent 的输入通过 Unit 和 Tool 的 Contract 校验；
- Kernel 完成新的准入并创建 UnitAttempt；
- Executor 只能获得 Permit 投影出的最小 Tool、Secret 与网络能力。

模型产生的 tool call 只是动作提案。Model Adapter、Workflow、ContextEngine 或 Tool Adapter 均不得直接执行它，也不得复用其他 UnitAttempt 的 Permit。

## 6. 结果提交

Executor 将 UnitResult、ArtifactRef、EffectRecord 和 usage 提交给 Kernel，不回调 Workflow。Kernel 依次校验 attempt identity、Lease、fencing、graphRevision、deadline、Executor 身份、输出 Contract、Artifact 完整性和副作用状态，再原子提交结果、审计和 Outbox Event。

重复结果按幂等键返回原结论。旧 fencing、过期 Lease、旧 revision 或终态后的结果只可保存为 Evidence。未知副作用进入 reconciliation；不得自动创建重复执行。Kernel 发布已校验事实后，Workflow 才能更新 AgentStep、继续循环或进行业务验收。

## 7. 生命周期、取消与恢复

- Retry 创建新的 UnitAttempt，并递增 fencing；不得覆盖原 Attempt。
- Pause 或 revision barrier 停止受影响范围的新准入。
- Cancel 停止签发 Permit，并请求运行中 Executor 协作终止；物理终止不等于业务取消完成。
- 完成前 Kernel 停止新准入、drain 有效 Lease、核对 Grant、EffectRecord 和审计，再发布 ExecutionScopeDrained。
- 恢复不继承旧 Grant、Lease、Permit、Secret materialization 或运行时 Executor 会话；所有动态权限重新签发。

## 8. 安全与审计

Kernel 在准入和结果提交两个边界重验 tenant/project、identity、Policy、definition digest、graphRevision 和 MissionScope。Grant、Lease、Permit 和审核决定必须短期、范围明确、可撤销且可审计。

审计至少记录主体、AgentRun、UnitIntent/UnitAttempt、Agent/Unit/Tool/Executor 定义引用、候选与选中 Executor、Policy/Review 引用、预算、workspace、准入结论、fencing、效果和错误。Secret、完整 Prompt、源代码和 Tool 结果正文不得进入审计记录。

## 9. 禁止行为

Kernel 不得修改 AgentToolPool 定义、替 Workflow 选择业务动作、绕过 Agent→Unit→Tool 成员校验、允许裸 Tool 调用、让 Executor 回调 Workflow、以运行时健康状态回写 ExecutorDefinitionVersion，或把 UnitResult 直接提升为 Task/Workflow 成功。

## 10. 验证

测试必须覆盖 Agent→Unit 与 Unit→Tool 合法/非法成员关系、定义 digest 与撤销状态、capability 匹配、无候选 Executor、确定性选择、Policy/预算/workspace 拒绝、幂等准入、重复与迟到结果、Lease 过期、旧 fencing、revision barrier、Tool 脱离 Unit 调用、未知副作用、取消竞态、恢复重签发和最终 drain。

通用对象与 Schema 见 [SharedContracts](../infrastructure/SharedContracts.md)，跨模块消息与版本规则见 [Protocol](../Protocol.md)，物理执行机制见 [Execution](Execution.md)。
