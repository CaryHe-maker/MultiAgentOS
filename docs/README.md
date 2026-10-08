# MultiAgentOS 文档索引

## 1. 文档分区

| 目录 | 内容 |
|---|---|
| [Architecture](Architecture/README.md) | 长期规划：概念、模块职责、协作与安全约束 |
| [M1](M1/README.md) | M1 交付范围、机制设计、接口与进度 |
| [Requirements](Requirements/Dependencies.md) | 仓库实际依赖及迁移边界 |
| [Meetings](Meetings/) | 历史讨论，不覆盖当前规范 |
| [Style](Style.md) | 工程与文档协作规范 |

目标平台为 Ubuntu LTS。Architecture 只描述长期规划，不穷尽实现；各 MVP 的具体机制在对应目录中明确。

## 2. 推荐阅读路线

1. [Overall](Architecture/Overall.md)：整体职责、对象与执行闭环。
2. [Kernel](Architecture/module/Kernel.md)：六组件、syscall、Lease 与额度。
3. [Execution](Architecture/kernel/Execution.md)：Kernel 内的尝试、执行与产物发布。
4. [Protocol](Architecture/Protocol.md)：请求、事实、结果与恢复的共同语义。
5. [Instance](Architecture/Instance.md)：运行、控制与恢复示例。
6. [Architecture 指南](Architecture/README.md)：全部长期文档入口。
7. [M1 指南](M1/README.md)：M1 的范围、机制与接口。

## 3. 模块、静态库与基础设施

| 文档 | 内容 |
|---|---|
| [UserInteraction](Architecture/module/UserInteraction.md) | 会话、意图、审核交互与展示 |
| [Workflow](Architecture/module/Workflow.md) | 业务图、AgentRun、验收、恢复与补偿 |
| [Kernel](Architecture/module/Kernel.md) | Gateway、Core、Scheduler、Execution、Supervisor、Monitor |
| [Execution](Architecture/kernel/Execution.md) | Kernel 内的尝试、步骤、效果与产物发布 |
| [AgentToolPool](Architecture/library/AgentToolPool.md) | Agent、Unit、Tool 等模板定义 |
| [ExecutorSet](Architecture/library/ExecutorSet.md) | Executor 行为代码 |
| [SharedContracts](Architecture/library/SharedContracts.md) | 公共数据、版本及兼容验证 |
| [ModuleHost](Architecture/infrastructure/ModuleHost.md) | Supervisor 管理的装配与生命周期 |
| [Fabric](Architecture/infrastructure/Communication.md) | Core 管理的通信与事实交接 |
| [Persistence](Architecture/infrastructure/Persistence.md) | 分属各 Owner 的状态保存与恢复原语 |
| [ArtifactStore](Architecture/infrastructure/ArtifactStore.md) | 不可变大对象、访问与保留 |
| [TechStack](Architecture/TechStack.md) | 长期目标技术栈 |

## 4. 如何判断文档状态

Architecture 是长期规划，不代表某个 MVP 必须全部实现。
M1 目录定义 M1 的范围与机制；与 Architecture 存在差异时，以 M1 文档对 M1 的规定为准，
但 M1 不得违反 Architecture 的安全约束与状态所有权。
代码 Schema 说明已实现接口，M1Process 说明进度证据，文档更新不代表实现已经完成。
