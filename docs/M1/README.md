# MultiAgentOS M1 指南

## 1. 目的与范围

本目录定义 M1 的交付目标、技术选择、跨模块接口、任务进度和验收要求。
M1 面向本地、单用户、单项目、单进程、单活动 Task 的只读仓库分析，由 Planner 与 CodeViewer
两个 Agent 单向交接完成，输出包含 repository revision、路径、行范围和 provenance 的结构化报告。
M1 的验收平台为 Ubuntu LTS；开发平台不限，但代码必须能在 Ubuntu LTS 上运行。

长期概念、模块职责与安全边界见 [Architecture 指南](../Architecture/README.md)。
本目录说明这些能力在 M1 中的具体交付范围，不将长期架构中的全部能力视为 M1 要求。
其他 MVP 的范围与排期单独评审。

## 2. 目录组织

M1 的机制文档按 Architecture 的分类组织：

| 目录 | 内容 |
|---|---|
| `module/` | 三个 Module 的 M1 机制。其中 Kernel 文档从 Workflow 与 UserInteraction 的外部视角描述 syscall、返回信息、授权、额度状态与结束方式 |
| `kernel/` | Kernel 内部六组件的 M1 职责，以及组件之间的内部交互逻辑 |
| `library/` | 静态库的 M1 实现说明 |
| `infrastructure/` | 四类基础设施的 M1 职责与边界 |

ArtifactStore、ModuleHost、Fabric、Persistence 保持独立基础设施地位，由 Kernel 承担相应管理职责，
但不成为 Kernel 内部组件。基础设施提供技术机制，领域 Owner 保留业务决定权与状态所有权。

## 3. 阅读顺序

1. [M1Plan](M1Plan.md)：目标、范围、分工、任务、固定任务集和完成定义。
2. [Kernel（外部视角）](module/Kernel.md)：syscall、返回信息、Unit 清单、授权、原因码与结束方式。
3. [Workflow](module/Workflow.md)：Validation、Round、final-call 与 FINISH 后的结束路径。
4. [Kernel 内部交互](kernel/Interaction.md)：内部 syscall、执行路径、停止、收敛与 panic。
5. [M1TechStack](M1TechStack.md)：运行环境、技术选择、允许依赖与明确排除项。
6. [M1Interface](M1Interface.md)：公开 Port、Schema、消息与错误协议。
7. [M1Process](M1Process.md)：任务状态、实现差距与验证证据。

| 分类 | 文档 |
|---|---|
| Module | [Kernel](module/Kernel.md)、[Workflow](module/Workflow.md)、[UserInteraction](module/UserInteraction.md) |
| Kernel 组件 | [Interaction](kernel/Interaction.md)、[Gateway](kernel/Gateway.md)、[Core](kernel/Core.md)、[Scheduler](kernel/Scheduler.md)、[Monitor](kernel/Monitor.md)、[Supervisor](kernel/Supervisor.md)、[Execution](kernel/Execution.md) |
| 静态库 | [AgentToolPool](library/AgentToolPool.md)、[ExecutorSet](library/ExecutorSet.md) |
| Infrastructure | [Communication](infrastructure/Communication.md)、[ModuleHost](infrastructure/ModuleHost.md)、[Persistence](infrastructure/Persistence.md)、[ArtifactStore](infrastructure/ArtifactStore.md) |

依赖版本见 [Dependencies](../Requirements/Dependencies.md)，
代码、文档、Git 和评审规范见 [Style](../Style.md)。

## 4. 文档职责

| 文档 | 负责内容 | 边界 |
|---|---|---|
| M1Plan | 交付范围、任务、验收和降级策略 | 不重新定义长期模块所有权 |
| module/ | 各 Module 的 M1 机制；Kernel 的对外行为 | 不规定具体 Schema 字段 |
| kernel/ | Kernel 组件职责与内部交互 | 不定义 Workflow 业务逻辑 |
| library/、infrastructure/ | 静态库与基础设施的 M1 实现说明 | 不替代长期架构 |
| M1TechStack | M1 使用的技术、版本用途和引入限制 | 不替代依赖 manifest |
| M1Interface | M1 具体接口与兼容约定 | 不因长期设计存在某能力就自动纳入交付 |
| M1Process | 状态、日期、证据、PR 和阻塞原因 | 不改变范围、接口或完成定义 |

## 5. 权威关系

- 长期模块边界和安全约束由 Architecture 定义。
- M1 的范围和完成条件以 M1Plan 为准。
- M1Interface 定义交付接口要求，代码中的 Schema 是已实现协议的可执行事实源。
- Kernel 对外行为以 module/Kernel 为准，Kernel 组件职责与内部交互以 kernel/ 下的文档为准。
- 目标与实现的差距在 M1Process 中记录，完成状态应有测试、报告或 PR 证据。

## 6. 维护要求

- 范围变化同步检查计划、接口、任务和验收条件。
- 协议变化同步更新 Schema、兼容说明及生产者与消费者的契约测试。
- 任务完成时更新对应进度、日期和验证证据。
- 架构调整应评估 M1 的范围与接口影响，不以文档描述代替实现验证。
