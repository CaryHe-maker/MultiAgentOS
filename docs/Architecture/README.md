# MultiAgentOS 架构指南

> 架构版本：M1 阶段。本文档库描述当前阶段长期系统，M1的具体设计选择见M1文档库。

## 1. 系统组织

MultiAgentOS 采用宏内核思想：UserInteraction 负责用户交互，Workflow 负责业务推进，Kernel 统一管理权限与执行。

| 分类 | 组成 |
|---|---|
| Module | UserInteraction、Workflow、Kernel |
| Kernel 组件 | Gateway、Core、Scheduler、Execution、Supervisor、Monitor |
| 静态库 | AgentToolPool、ExecutorSet、SharedContracts |
| Infrastructure | ArtifactStore、ModuleHost、Fabric、Persistence |
| 通讯主体 | Kernel 核心、Supervisor、Gateway（逻辑独立）、Workflow、UserInteraction |

静态库提供模板、行为代码与契约，不是自主运行的服务。
Kernel 核心包含 Core、Monitor、Scheduler、Execution，是同一进程的模块化单体，组件数据按模块隔离；
Supervisor 独立管理 Executor 子进程。每个 WorkflowRun 在任一时刻只由一个 Kernel 核心实例处理。
Kernel 内部保留清晰的状态所有权，不提供任意组件可写的全局状态。

## 2. 阅读路线

1. [Overall](Overall.md)：系统关系、权威归属和不变量。
2. [Kernel](module/Kernel.md)：六组件、通讯主体、运行组织、权限、Lease 与系统调用。
3. [Protocol](Protocol.md)：请求、事实、结果和恢复的共同语义。
4. [Instance](Instance.md)：运行、控制、集成和恢复示例。
5. [Evolution](Evolution.md)：部署阶段、分片与架构演进。
6. [TechStack](TechStack.md)：长期目标技术栈、技术选型与替换边界。

## 3. Module 与组件

| 文档 | 职责 |
|---|---|
| [UserInteraction](module/UserInteraction.md) | 会话、意图、审核交互与展示 |
| [Workflow](module/Workflow.md) | 业务图、AgentRun、验收、恢复与补偿 |
| [Kernel](module/Kernel.md) | 统一控制与执行管理 |
| [Execution](kernel/Execution.md) | Kernel 内的尝试、步骤、效果与上下文状态 |
| [Supervisor](kernel/Supervisor.md) | 系统生命周期、Executor 子进程与执行事实 |

## 4. 静态库

| 文档 | 内容 |
|---|---|
| [AgentToolPool](library/AgentToolPool.md) | Agent、Unit、Tool 等模板类及其组合 |
| [ExecutorSet](library/ExecutorSet.md) | Executor 原子软件行为代码，包括上下文能力 |
| [SharedContracts](library/SharedContracts.md) | 公共概念、数据契约与兼容关系 |

## 5. Infrastructure

| 文档 | 管辖与职责 |
|---|---|
| [ArtifactStore](infrastructure/ArtifactStore.md) | Execution 管辖；不可变内容与保留原语 |
| [ModuleHost](infrastructure/ModuleHost.md) | Supervisor 管辖；装配、就绪与关闭 |
| [Fabric](infrastructure/Communication.md) | Core 管辖；通讯主体、通信、路由与事实交接 |
| [Persistence](infrastructure/Persistence.md) | ModuleHost 管理生命周期；各 Owner 保有数据权威 |

## 6. 权威与演进

Overall 定义系统级归属，专题文档展开职责，Protocol 统一协作语义。
“必须”和“不得”约束已开放能力，“可以”表示不破坏不变量的选择。

MVP 实践可以推动架构演进，但须显式调整受影响的职责、协作和安全约束。
历史讨论不覆盖当前架构，设计变化不等于实现已经完成。
