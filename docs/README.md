# MultiAgentOS 文档索引

## 1. 文档分区

| 目录 | 内容 |
|---|---|
| [Architecture](Architecture/README.md) | 长期规划：概念、模块职责、协作与安全约束 |
| [M2](M2/README.md) | 当前里程碑：总体设计 [M2Design](M2/M2Design.md)（v1.3）、阶段计划与各组件文档 |
| [Requirements](Requirements/Dependencies.md) | 仓库实际依赖及迁移边界 |
| [Meetings](Meetings/) | 历史讨论，不覆盖当前规范 |
| [History](History/) | 已归档的文档，不作为当前规范；其中 [M1](History/M1/README.md) 是已发布的 M1 的规范、发布计划与验收证据 |
| [Style](Style.md) | 工程与文档协作规范 |

目标平台为 Ubuntu LTS，规范版本为 24.04（M1 起）。Architecture 只描述长期规划，不穷尽实现；各 MVP 的具体机制在对应目录中明确。
M1 已发布，其文档归档在 [History/M1](History/M1/README.md)；当前开发以 [M2](M2/README.md) 为准。

## 2. 推荐阅读路线

1. [Overall](Architecture/Overall.md)：整体职责、对象与执行闭环。
2. [Kernel](Architecture/Module/Kernel.md)：六组件、通讯主体、运行组织、syscall、Lease 与额度。
3. [Execution](Architecture/Kernel/Execution.md)：Kernel 内的尝试、执行与产物发布。
4. [Supervisor](Architecture/Kernel/Supervisor.md)：系统生命周期、Executor 子进程与执行事实。
5. [Protocol](Architecture/Protocol.md)：请求、事实、结果、事件与恢复的共同语义。
6. [Instance](Architecture/Instance.md)：运行、控制与恢复示例。
7. [Architecture 指南](Architecture/README.md)：全部长期文档入口。
8. [M2 指南](M2/README.md)：M2 的设计、阶段计划与组件文档。

## 3. 模块、静态库与基础设施

| 文档 | 内容 |
|---|---|
| [UserInteraction](Architecture/Module/UserInteraction.md) | 意图、审核交互与展示；不保存 Session 信息 |
| [Workflow](Architecture/Module/Workflow.md) | 业务图、AgentRun、会话日志与 Session 列表、验收、恢复与补偿 |
| [Kernel](Architecture/Module/Kernel.md) | Gateway、Core、Scheduler、Execution、Supervisor、Monitor |
| [Execution](Architecture/Kernel/Execution.md) | Kernel 内的尝试、步骤、效果与产物发布 |
| [Supervisor](Architecture/Kernel/Supervisor.md) | 独立的通讯主体：系统生命周期、Executor 子进程、派发与监管 |
| [AgentToolPool](Architecture/Library/AgentToolPool.md) | Agent、Unit、Tool 等模板定义 |
| [ExecutorSet](Architecture/Library/ExecutorSet.md) | Executor 行为代码 |
| [SharedContracts](Architecture/Library/SharedContracts.md) | 公共数据、版本及兼容验证 |
| [ModuleHost](Architecture/Infrastructure/ModuleHost.md) | Supervisor 管理的装配与生命周期 |
| [Fabric](Architecture/Infrastructure/Fabric.md) | 通讯主体，以及 Core 管理的通信与事实交接 |
| [Persistence](Architecture/Infrastructure/Persistence.md) | 分属各 Owner 的状态保存与恢复原语 |
| [ArtifactStore](Architecture/Infrastructure/ArtifactStore.md) | 不可变大对象、访问与保留 |
| [TechStack](Architecture/TechStack.md) | 长期目标技术栈 |

## 4. 如何判断文档状态

Architecture 是长期规划，不代表某个 MVP 必须全部实现。
M2 目录定义当前里程碑的范围与机制；与 Architecture 存在差异时，以 M2 文档对 M2 的规定为准，
但 M2 不得违反 Architecture 的安全约束与状态所有权，偏离之处必须登记在 M2Design 第 14.1 节。归档的 M1 文档只描述已发布的 M1。
代码 Schema 说明已实现接口，GitHub Issues 跟踪进度与证据，文档更新不代表实现已经完成。
