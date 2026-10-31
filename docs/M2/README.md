# MultiAgentOS M2 指南

## 1. 目的与范围

本目录定义 M2 的设计、交付阶段、各组件机制、跨模块接口与验收要求。
M2 的范围与设计以 [M2Design](M2Design.md)（已冻结，当前 v1.7）为准；本目录其余文档在它的基础上展开，
可以细化，不得与它矛盾。需要改变设计时，先在 M2Design 中发布新版本，再修改组件文档。

长期概念与安全边界见 [Architecture 指南](../Architecture/README.md)。
M1 已发布，其规范归档在 [History/M1](../History/M1/README.md)，只作为 M1 行为与回归基线的依据；
当前代码以本目录为准。

## 2. 目录组织

| 目录或文档 | 内容 |
|---|---|
| [M2Design](M2Design.md) | 总体设计：能力、机制与 Owner、不变量、验收、交付阶段 |
| [M2Plan](M2Plan.md) | 阶段、工作流、任务与依赖、分支、各阶段的门与退出条件 |
| `M2TechStack.md` | 阶段 0 的实测结果、运行环境、依赖与版本 |
| `M2Security.md` | 威胁模型、沙盒与授权的分层防护、C5 拦截矩阵 |
| `Interface/` | 字段级接口，按通讯边界拆分；M2 的 Schema 为 major 1，M1 的 major 0 冻结 |
| `Module/` | 三个 Module 的 M2 机制；Kernel 文档从外部视角描述 syscall 与事件 |
| `Kernel/` | Kernel 各组件的 M2 职责，以及 Session actor 中的内部交互 |
| `Library/` | 三个静态库：Agent、Unit、Tool、Prompt、模板定义，Executor，Schema |
| `Infrastructure/` | 四类基础设施的 M2 职责与边界 |
| `SystemFaultHandling.md` | 异常语义、停机与退出码 |
| `M2Usage.md`、`M2Limitations.md` | 发布前编写：运行说明与已知限制 |

验收证据与发布计划在发布阶段编写，放在 `docs/` 根目录，与 M1 的做法相同。

## 3. 组件文档的写法

每篇组件文档都是完整的：以对应的 M1 文档为底稿，按 M2Design 改写，读者不需要再对照 M1。
每篇使用相同的章节：

1. **定位**：职责边界，以及在 Architecture 中的对应位置；
2. **相对 M1 的变化**：逐条列出，并注明 M2Design 中的依据；
3. **职责与私有数据**；
4. **状态与流程**：状态机、处理顺序；
5. **接口**：只链接到 `Interface/` 中的定义，不重复字段；
6. **不变量与测试**：对应 M2Design 第 12 节的编号，写明由哪类测试保证；
7. **配置**：配置项、读取者、缺省值；
8. **阶段**：本文各部分在 M2Plan 的哪个阶段引入。

文档按 M2Plan 的阶段逐步编写：每个阶段开工之前，写完该阶段涉及的章节并评审；
后续阶段在同一篇文档中补充，不另开新文档。

## 4. 文档状态

| 文档 | 状态 | 首次涉及的阶段 |
|---|---|---|
| [M2Design](M2Design.md) | v1.7 定稿 | — |
| [M2Plan](M2Plan.md) | 草稿 | — |
| [M2TechStack](M2TechStack.md) | 草稿：阶段 0 实测待填 | 0 |
| [M2Security](M2Security.md) | 草稿（阶段 1 的部分） | 1 |
| [Interface](Interface/README.md)：[WorkflowKernel](Interface/WorkflowKernel.md)、[InteractionKernel](Interface/InteractionKernel.md)、[Persistence](Interface/Persistence.md)、[Definitions](Interface/Definitions.md) | 草稿（阶段 1 的部分） | 1 |
| Module：[Kernel](Module/Kernel.md)、[Workflow](Module/Workflow.md)、[UserInteraction](Module/UserInteraction.md) | 草稿（阶段 1） | 1 |
| Kernel：[Interaction](Kernel/Interaction.md)、[Core](Kernel/Core.md)、[Gateway](Kernel/Gateway.md)、[Execution](Kernel/Execution.md)、[Monitor](Kernel/Monitor.md) | 草稿（阶段 1） | 1 |
| Library：[AgentToolPool](Library/AgentToolPool.md)、[ExecutorSet](Library/ExecutorSet.md)、[SharedContracts](Library/SharedContracts.md) | 草稿（阶段 1） | 1 |
| Infrastructure：[Persistence](Infrastructure/Persistence.md)、[ArtifactStore](Infrastructure/ArtifactStore.md)、[ModuleHost](Infrastructure/ModuleHost.md)、[Fabric](Infrastructure/Fabric.md) | 草稿（阶段 1） | 1 |
| Kernel：Scheduler、Supervisor；SystemFaultHandling；`Interface/KernelSupervisor.md` | 未开始 | 2–4 |
| M2Usage、M2Limitations | 未开始 | 发布准备 |

状态取值：未开始、草稿、已评审、已实现。实现合入集成分支后，对应文档改为"已实现"。
