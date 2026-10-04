# MultiAgentOS 整体架构

> 架构版本：M1 阶段；面向长期系统。

## 1. 系统目标

MultiAgentOS 将软件工程与知识工作组织为可验证的任务，协调 Agent 与执行能力完成目标。
系统关注结果质量、执行权限、资源消耗、来源证据和故障后的可解释性。
并行是一种推进策略，不是每个目标的必需形式。

长期能力包括人工参与、任务重规划、隔离执行、持久运行和恢复。
模型判断是提案，执行事实与验收证据才是业务完成的依据。

## 2. 三个 Module

| Module | 负责 | 不负责 |
|---|---|---|
| UserInteraction | 用户会话、意图、原始审核响应和展示 | 授权裁决、业务状态写入 |
| Workflow | 目标分解、任务图、AgentRun、验收、恢复和补偿 | 直接执行模型与工具、管理 Lease |
| Kernel | 权限、调度、执行、资源、监管与系统控制 | 替代 Workflow 作业务验收 |

Kernel 采用宏内核组织，Execution 成为内部组件。ContextEngine 不再作为独立 Module，
其行为由 ExecutorSet 提供，运行由 Kernel 管理。

## 3. 逻辑结构

```text
用户 → UserInteraction → Kernel.Gateway → Workflow
                              ↑              │
                              └─ UnitIntent ─┘
Kernel
  Gateway · Core · Scheduler · Execution · Supervisor · Monitor
                                │
                                └─ 调用 ExecutorSet 行为实现
Kernel → 确认执行事实 → Workflow 验收 → 用户视图

静态库：AgentToolPool · ExecutorSet · SharedContracts
基础设施：ArtifactStore · ModuleHost · Fabric · Persistence
```

AgentToolPool 是模板类集合，ExecutorSet 是原子行为代码，SharedContracts 是公共契约库。
静态库不拥有独立服务身份和自主生命周期，不自行维护运行实例。

ArtifactStore 归 Execution，ModuleHost 归 Supervisor，Fabric 归 Core。
Persistence 的启停由 ModuleHost 管理。基础设施管辖不转移领域数据的决定权。

## 4. Kernel 内部权威

| 组件 | 权威职责 |
|---|---|
| Gateway | 外部 syscall 接入、来源检查、入口控制与分派、限流 |
| Core | 授权依据、Lease、控制操作和结果裁决 |
| Scheduler | 执行机会、目标选择、API 容量与调度关联 |
| Execution | UnitAttempt、步骤、执行进度、输出及效果关联 |
| Supervisor | 模块和执行环境的健康、停止、隔离与回收 |
| Monitor | 资源额度、预留、消费、结算、观测与限流控制 |

实际完成、结果被接受和业务成功分别由 Execution、Core、Workflow 表达。
内部协调可以集中组织，但不能将这些事实混为一个任意可写的状态。

## 5. 核心概念

| 概念 | 含义 |
|---|---|
| WorkSession / SessionTree | 用户组织、观察和派生运行的交互结构 |
| TaskGraph | 任务依赖与结果汇合关系 |
| MissionScope | 目标谱系、预算和能力上限、工作范围及取消边界 |
| AgentRun | Workflow 管理的一次 Agent 行为过程 |
| Unit / UnitIntent | 操作单元及其执行请求 |
| Tool | 执行链中可选的权限封装 |
| Executor | 开发者提供的原子软件行为 |
| UnitAttempt | Kernel.Execution 管理的一次实际执行尝试 |

交互树、业务图和目标范围具有不同语义，不合并为万能任务树。
Unit 可经过 Tool 封装，再由一个或多个 Executor 执行。存在 Tool 时进行对应权限审核和
Lease 检查；无 Tool 时依据开发者授予的权限。路径由可信模板和代码确定，
调用者不能自行移除 Tool 改变权限。Executor 的原子性不保证可回滚或事务原子性。

## 6. 权限与系统调用

外部 Module 经 Gateway 请求 Kernel 服务；内部组件间存在内部 syscall 概念，
其接入方式将在 M1 具体设计阶段明确。

Lease 内容仅由 Core 持有。Gateway、Workflow、Execution 及其他组件不保存实体、快照或缓存，
通过系统调用取得所请求操作的裁决。合法检查不等于直接访问 Lease；
Core 之外直接读取或修改 Lease 实体属于越权，进入 panic 处置。

开发者授权与 Lease 授权都不免除工作范围、数据保护、资源和监管约束。
静态能力存在不代表任意调用者可以执行它。

## 7. 执行闭环

Workflow 固定使用的模板和行为版本，形成 UnitIntent，经 Gateway 进入 Kernel。
Kernel 组织权限判断、尝试创建、调度及资源安排，由 Execution 调用 Executor。
输出、实际效果和消耗在内核核对后，交由 Workflow 验收。

模型动作始终是提案。Workflow 检查能力组合的合法性，再提交操作，不替代 Core 作权限裁决。
模型和 Workflow 不得直接调用 ExecutorSet 来绕过 Kernel。

## 8. 状态、上下文与证据

每类运行状态具有明确 Owner。静态库不保存跨运行共享的可变业务状态，
基础设施只提供保存与传递机制，不产生第二个领域权威。

上下文算法由 Executor 实现。长期所需的检索台账、上下文构建记录、索引和快照关联由
Execution 管理，正文作为不可变 Artifact 保存；用户偏好与业务决定仍归相应模块。
这些概念不要求所有交付阶段同时建设完整状态系统。

模板、发布结果和历史事实不可静默覆盖。结果应能关联输入、执行与来源；
缓存、索引和视图不反向覆盖事实源。仓库材料不会因进入上下文而获得指令权威。

## 9. 并行、集成与重规划

Workflow 判断依赖是否就绪，Kernel 判断何时具备执行条件。
并行工作有明确修改范围和资源边界，共享资源与冲突不能由完成先后偶然决定。

变更以可核验产物交付，Workflow 决定集成安排，Kernel 在受控环境执行。
集成验收独立于 Executor 自报成功。重规划产生新业务版本，受影响旧工作必须停止推进
或经过核对，迟到结果不得覆盖当前结论。

## 10. 人工参与、恢复与完成

人工参与包括权限审批、信息补充、方案选择和结果验收，不限定为单一交互节点。
UserInteraction 收集响应，Core 处理权限与审核适用性，Workflow 解释业务影响。
批准不跳过后续执行检查，超时不能自动视为批准。

控制流恢复、同一运行的业务恢复点、用户可见的长期保存点具有不同身份和生命周期。
Workflow 组织恢复，Kernel 核对权限、效果、资源和环境。恢复不复活旧 Lease、
凭据或执行会话，历史产物存在也不自动授予当前访问权。

取消停止新推进并收敛在途执行。进程退出不等于业务取消成功，未知效果先核对。
最终完成须满足业务验收、必要产物与审核、执行范围收敛及效果处理，
不因其他工作仍有有效授权而无限等待。

## 11. 系统不变量

- 业务执行统一进入 Kernel，Executor 不直接回调业务层推进任务。
- Lease 由 Core 独占，系统调用只交付操作所需裁决。
- Tool 的有无由可信定义决定，不能由模型改变。
- 可信执行管理与不可信代码分离，宏内核不授予任意代码内核权限。
- 权威账本不能由可丢失指标替代，未知消耗不记作零。
- 重复、乱序、取消竞争和未知副作用必须可解释，不能盲目重跑。
- 敏感正文与凭据不进入普通日志，数据访问受身份与范围约束。
- 模块、库、组件和执行进程不强制一一对应，部署变化不暗中改变职责。
