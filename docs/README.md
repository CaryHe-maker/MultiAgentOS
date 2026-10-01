# MultiAgentOS 文档索引

## 1. 文档分区

| 目录 | 内容 |
|---|---|
| [Architecture](Architecture/README.md) | 长期概念、模块职责、协作与安全约束 |
| [M1](M1/README.md) | 现有交付范围、契约与进度；新架构映射待详细设计 |
| [Requirements](Requirements/Dependencies.md) | 仓库实际依赖及迁移边界 |
| [Meetings](Meetings/) | 历史讨论，不覆盖当前规范 |
| [DesignReport](DesignReport/KernelModuleReport_Draft.md) | 早期设计推导和历史方案，不是当前实施要求 |
| [Style](Style.md) | 工程与文档协作规范 |

目标平台为 Ubuntu LTS。长期文档不穷尽实现，具体机制在各 MVP 明确。

## 2. 推荐阅读路线

1. [Overall](Architecture/Overall.md)：整体职责、对象与执行闭环。
2. [Kernel](Architecture/module/Kernel.md)：五个主组件、租约及调用/中断/异常。
3. [Execution](Architecture/module/Execution.md)：UnitAttempt、Tool 序列和执行状态。
4. [Instance](Architecture/Instance.md)：首次调用、租约复用、取消和恢复示例。
5. [Protocol](Architecture/Protocol.md)：跨模块语义。
6. [架构指南与衔接清单](Architecture/README.md)：所有文档入口和明确保留的差异。
7. [M1 指南](M1/README.md)：区分长期目标、现有接口和实际进度。

## 3. 模块与基础设施

| 文档 | 内容 |
|---|---|
| [UserInteraction](Architecture/module/UserInteraction.md) | 会话、请求、审核响应和状态/流式展示 |
| [Workflow](Architecture/module/Workflow.md) | 业务图、AgentRun、验收、checkpoint 和补偿 |
| [Kernel](Architecture/module/Kernel.md) | Gateway、Core、Scheduler、Monitor、Supervisor |
| [Execution](Architecture/module/Execution.md) | 独立执行模块、Attempt 和模型网关 |
| [ContextEngine](Architecture/module/ContextEngine.md) | 上下文、检索与来源 |
| [AgentToolPool](Architecture/module/AgentToolPool.md) | 不可变静态定义 |
| [ModuleHost](Architecture/infrastructure/ModuleHost.md) | Supervisor 管辖的模块装配与生命周期 |
| [Communication](Architecture/infrastructure/Communication.md) | Kernel 管辖的通信及 IPC 基础设施 |
| [SharedContracts](Architecture/infrastructure/SharedContracts.md) | 公共数据、版本及兼容验证 |
| [Persistence](Architecture/infrastructure/Persistence.md) | 分属各 Owner 的运行时状态及恢复原语 |
| [ArtifactStore](Architecture/infrastructure/ArtifactStore.md) | 不可变大对象、访问与保留 |
| [TechStack](Architecture/TechStack.md) | 已确定工程基础和待 MVP 选择的技术方向 |

## 4. 如何判断文档状态

Architecture 是新的长期设计；M1 保留既有交付基线，不自动升级为完整目标实现。
代码 Schema 说明已实现接口，M1Process 说明进度证据，二者不会因本轮文档更新自动完成迁移。
模块契约的差异统一见 [衔接清单](Architecture/README.md#6-文档衔接清单)，
需要负责人协同的事项明确保留，不宣称全库已经无冲突。
