# MultiAgentOS Kernel.Execution

## 1. 定位

Execution 是 Kernel 六组件之一，负责实际执行过程。
它组织 UnitAttempt、执行队列、行为步骤、输入输出、效果和执行相关状态。
Execution 提交 ExecutorSet 中的执行定义引用，由 Supervisor 装配并执行；
Execution 不作为独立 Module，也不是第二套权限系统。

Core 作权限和结果裁决，Scheduler 分配机会，Monitor 核对资源，
Supervisor 管执行环境，Workflow 作业务验收。

## 2. 行为组织

```text
UnitIntent →（Core 完成定义核验与权限检查）→ UnitAttempt → 执行队列
  → 一个或多个 Executor 步骤（定义引用交 Supervisor 装配执行）
  → 运行实例 / 受管执行环境
  → 结果、产物与效果事实
```

权限检查在建立 UnitAttempt 之前由 Core 完成。声明了受保护能力的 Unit 由 Core 检查适用 Lease，
未声明的 Unit 使用可信开发者授予的权限。
Execution 不能自行移除受保护能力声明或扩大授权，Executor 也不能自由派生未声明操作。

Executor 原子性描述组合粒度，不能据此推断效果可回滚或操作可安全重试。

## 3. 执行状态

Execution 拥有尝试、步骤关联、输入输出、实际进度和效果记录。
模板由 AgentToolPool 提供，行为代码由 ExecutorSet 提供，运行状态不保存在静态库中。

重复请求须关联已有处理，新的实际尝试保留历史关系。
派发、执行与回执可能部分成功；无法确认时保留未知状态，不直接重跑。
旧尝试或取消后的结果可作为证据保存，不能自行推进当前业务。

## 4. 内核协作

需要受限资源时，Execution 经内部 syscall 向 Core 申请，由 Core 调用 Scheduler 分配机会、
调用 Monitor 预留额度。执行完成后，Execution 经内部 syscall 向 Core 提交结果检查，
用量随之交给 Core，由 Core 调用 Monitor 结算。环境与停止事实交由 Supervisor 协调。
这些是 Kernel 内部职责协作，不要求外部 Gateway 回环。

Execution 不持有 Lease 内容，通过内核服务取得所需裁决。
Core 接受结果不等于 Workflow 验收成功，结果被拒绝也不能抹去实际费用或效果。

已执行的 Unit 由 Execution 依据 Core 的判定封装结果并交付 Workflow；不由原子 Executor 回调 Workflow。
Core 的判定携带运行控制状态的版本，Execution 交付前再次核对，状态已变时不再交付，
结果只作为证据保存。运行收敛时，Core 等待 Execution 正在进行的交付结束。

## 5. 上下文行为与长期状态

原 ContextEngine 的组装、检索、压缩和排序能力进入 ExecutorSet，由具体 Executor 实现。
Execution 为这些行为提供受控输入、状态与资源，不新增独立上下文 Module。

| 长期概念 | 所有权 |
|---|---|
| 上下文构建记录与检索台账 | Execution 管理运行关联、已使用材料和诊断 |
| 仓库快照与索引关联 | Execution 管理适用版本、来源与可用性 |
| ContextPack | 构建关联归 Execution；不可变正文归 ArtifactStore 保存 |
| 检索结果、缓存与索引 | 可重建派生数据，不覆盖来源事实 |
| 用户偏好与业务决定 | 仍由 UserInteraction、Workflow 等对应 Owner 管理 |

并非每个交付阶段都需要上述全部状态，但引入时必须保留明确 Owner。
共享索引不可因单次运行恢复而整体回滚；来源失效必须传递至派生结果和可见视图。

## 6. 模型与工具

模型、文件、搜索、上下文、代码修改和外部服务调用均为受控行为。
具体协议适配及算法位于行为实现或其依赖中，Execution 负责调用与结果管理。

模型 tool call 是业务动作提案，交由 Workflow 解释并形成新的 UnitIntent。
固定行为链内的技术步骤可在已获准范围内推进，但不能借此自由扩展业务动作。
API 调用机会归 Scheduler，实际消费归 Monitor，Executor 不建立自己的预算权威。

## 7. 工作环境与数据保护

Execution 使用受限工作环境处理文件、模型输入和外部效果，
Supervisor 管理环境的隔离、停止及回收。
并行修改具有独立工作范围；环境重建依赖可验证依据，不依赖旧活句柄。

凭据只提供给确实需要的行为，不进入普通输出、日志、上下文或恢复保存点。
不可信 Executor 不得修改执行管理状态或取得内核控制能力。
ArtifactStore 由 Execution 管辖，产物只由 Execution 写入与发布。
业务产物（如最终报告）由业务 Owner 以 Unit 形式提交，Execution 发布后返回引用；
产物的业务用途和保留需求仍归相应 Owner。

## 8. 中断、恢复与效果

取消阻止新推进，Execution 响应安全点并报告在途调用与效果。
Supervisor 处理停止与回收，Monitor 核对消费。收到信号不等于实际停止。

普通执行失败与基础失守分开；异常交由 Core 组织处理。
未知效果先核对，业务重试与补偿由 Workflow 决定。
恢复核对当前状态和权限，不复活旧 Lease、凭据或执行会话。

## 9. 验证关注点

验证涵盖步骤合法性、定义与实现匹配、越权拒绝、执行取消、
重复和迟到结果、产物完整性、未知效果、资源交接及运行间数据隔离。
上下文还需验证来源、版本、访问范围、预算与恢复后适用性。
