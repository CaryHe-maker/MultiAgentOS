# MultiAgentOS M1 指南

## 1. 目的与范围

本目录定义 M1 的交付目标、技术选择、机制、跨模块接口和验收要求。任务进度与验证证据由 GitHub Issues 跟踪。
M1 面向本地、单用户、单项目、单进程、单活动 Task 的只读仓库分析，由 Planner 与 CodeViewer
两个 Agent 单向交接完成，输出包含仓库快照摘要（`snapshotId`）、路径、行范围和 provenance 的结构化报告。
M1 的验收平台为 Ubuntu LTS；开发平台不限，但代码必须能在 Ubuntu LTS 上运行。

长期概念、模块职责与安全边界见 [Architecture 指南](../Architecture/README.md)。
本目录说明这些能力在 M1 中的具体交付范围，不将长期架构中的全部能力视为 M1 要求。
其他 MVP 的范围与排期单独评审。

## 2. 目录组织

M1 的机制文档按 Architecture 的分类组织：

| 目录 | 内容 |
|---|---|
| `Module/` | 三个 Module 的 M1 机制。其中 Kernel 文档从 Workflow 与 UserInteraction 的外部视角描述 syscall、返回信息、授权、额度状态与结束方式 |
| `Kernel/` | Kernel 内部六组件的 M1 职责，以及组件之间的内部交互 |
| `Library/` | 三个静态库的 M1 实现说明 |
| `Infrastructure/` | 四类基础设施的 M1 职责与边界 |

ArtifactStore、ModuleHost、Fabric、Persistence 保持独立基础设施地位，由 Kernel 承担相应管理职责，
但不成为 Kernel 内部组件。基础设施提供技术机制，领域 Owner 保留业务决定权与状态所有权。

## 3. 阅读顺序

1. [M1Plan](M1Plan.md)：目标、范围、分工、任务、固定任务集和完成定义。
2. [Kernel（外部视角）](Module/Kernel.md)：syscall、返回信息、Unit 清单、授权、原因码与结束方式。
3. [Workflow](Module/Workflow.md)：模型返回的解释、Validation、失败处理、Round、final-call、交接与报告。
4. [Kernel 内部交互](Kernel/Interaction.md)：运行 actor、内部接口、执行路径、收敛、关闭与 panic。
5. [M1Interface](M1Interface.md)：全部跨模块类型与 Port 的字段级定义。
6. [SharedContracts](Library/SharedContracts.md)、[AgentToolPool](Library/AgentToolPool.md)：Schema 清单、定义实例。
7. [M1TechStack](M1TechStack.md)：运行环境、技术选择、允许依赖与明确排除项。

| 分类 | 文档 |
|---|---|
| Module | [Kernel](Module/Kernel.md)、[Workflow](Module/Workflow.md)、[UserInteraction](Module/UserInteraction.md) |
| Kernel 组件 | [Interaction](Kernel/Interaction.md)、[Gateway](Kernel/Gateway.md)、[Core](Kernel/Core.md)、[Scheduler](Kernel/Scheduler.md)、[Monitor](Kernel/Monitor.md)、[Supervisor](Kernel/Supervisor.md)、[Execution](Kernel/Execution.md) |
| 静态库 | [SharedContracts](Library/SharedContracts.md)、[AgentToolPool](Library/AgentToolPool.md)、[ExecutorSet](Library/ExecutorSet.md) |
| Infrastructure | [Fabric](Infrastructure/Fabric.md)、[ModuleHost](Infrastructure/ModuleHost.md)、[Persistence](Infrastructure/Persistence.md)、[ArtifactStore](Infrastructure/ArtifactStore.md) |

依赖版本见 [Dependencies](../Requirements/Dependencies.md)，
代码、文档、Git 和评审规范见 [Style](../Style.md)。

## 4. 文档职责

| 文档 | 负责内容 | 边界 |
|---|---|---|
| M1Plan | 交付范围、任务、验收和降级策略 | 不重新定义长期模块所有权 |
| M1Interface | 每个跨模块类型与 Port 的名称、字段与语义 | 不因长期设计存在某能力就自动纳入交付 |
| Library/SharedContracts | Schema ID、文件位置、owner、迁移与测试 | 字段以 M1Interface 为准 |
| Library/AgentToolPool | 目录机制、加载校验与全部定义实例 | 字段以 M1Interface 为准 |
| Module/ | 各 Module 的 M1 机制；Kernel 的对外行为 | 不重复定义字段 |
| Kernel/ | Kernel 组件职责、私有接口与内部交互 | 不定义 Workflow 业务逻辑 |
| Library/ExecutorSet、Infrastructure/ | 静态库与基础设施的 M1 实现说明 | 不替代长期架构 |
| M1TechStack | M1 使用的技术、版本用途和引入限制 | 不替代依赖 manifest |

## 5. 权威关系

- 长期模块边界和安全约束由 Architecture 定义。
- M1 的范围和完成条件以 M1Plan 为准。
- 跨模块字段以 M1Interface 为准；SharedContracts 与 AgentToolPool 必须与其一致，代码中的 Schema 是已实现协议的可执行事实源。
- Kernel 对外行为以 Module/Kernel 为准，Kernel 组件职责与内部交互以 Kernel/ 下的文档为准。
- 目标与实现的差距在 GitHub Issues 中跟踪，完成状态应有测试、报告或 PR 证据。

## 6. 维护要求

- 范围变化同步检查计划、接口、任务和验收条件。
- 协议变化同时修改 M1Interface、SharedContracts、AgentToolPool（涉及定义时）、Schema、兼容说明及生产者与消费者的契约测试。
- 任务完成时在对应 GitHub Issue 中关联 PR 与验证证据。
- Architecture 记录概念与方向；M1 的机制调整影响长期概念时，同步修改 Architecture，并在第 7 节记录仍存在的差异。

## 7. 与 Architecture 的关系

M1 与 Architecture 当前没有语义差异：结果统一由 Core 经 Outbox 交付、Inbox 事件投递、运行 actor 与收敛、
额度达到上限时只拒绝新的消耗型预留、Monitor 只由 Core 调用、产物发布由 Execution 完成等机制，已由 Architecture 采纳。

M1 只实现长期组织的一个子集：

| 长期组织 | M1 的取舍 |
|---|---|
| 通讯主体：Kernel 核心、Supervisor、Gateway、Workflow、UserInteraction | 主体划分相同，全部位于同一进程，主体之间仍只经 Fabric 交换可序列化数据 |
| Kernel 核心是模块化单体，组件数据按模块隔离 | 照常实现，并以目录边界、导入规则与架构测试强制 |
| Kernel 核心按 WorkflowRun 分片 | 单个 Kernel 核心实例，一个进程只有一个运行，不需要分片租约与路由 |
| 一次消息处理中的状态变化先持久化、再经 Outbox 发出 | 不按消息持久化运行状态；Outbox 与 Inbox 为内存实现，进程退出即丢失 |
| Supervisor 独立成进程，Executor 在子进程中运行（可信进程池、不可信按次进程） | Supervisor 与 Kernel 核心同进程，只运行可信的内置 Executor；`rg` 以子进程运行 |
| 运行 actor 按顺序处理，执行可以并行 | 运行 actor 与控制通道优先照常实现；执行按 FIFO 串行 |
| Kernel 核心与 Supervisor 的心跳、子进程健康判断 | 不实现 |
| 仓库版本来自版本控制系统 | 不调用 git；来源以仓库快照摘要 `snapshotId` 标识 |
