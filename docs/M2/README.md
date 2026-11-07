# MultiAgentOS M2 指南

## 1. 目的与范围

本目录定义 M2 的设计、计划、各组件机制、跨模块接口与验收要求。
M2 的范围与设计以 [M2Design](M2Design.md)（已冻结，当前 v1.34）为准；本目录其余文档在它的基础上展开，
可以细化，不得与它矛盾。需要改变设计时，先在 M2Design 中发布新版本，再修改组件文档。

当前的计划是 [M2ReleasePlan](M2ReleasePlan.md)（phase 0–3，从现在到发布）；已实现部分的现状是 [M2Baseline](M2Baseline.md)。
M2 第一轮实现期间的旧计划、决定记录与实测已冻结在 [History/M2](../History/M2/README.md)，不再是计划标准。

长期概念与安全边界见 [Architecture 指南](../Architecture/README.md)。
M1 已发布，其规范归档在 [History/M1](../History/M1/README.md)，只作为 M1 行为与回归基线的依据；
当前代码以本目录为准。

## 2. 目录组织

| 目录或文档 | 内容 |
|---|---|
| [M2Design](M2Design.md) | 总体设计：能力、机制与 Owner、不变量、验收 |
| [M2ReleasePlan](M2ReleasePlan.md) | 当前计划：发布标准、侧重点、phase 0–3 的任务与退出条件、待负责人决定的问题 |
| [M2Baseline](M2Baseline.md) | 现状基线：每项能力做到哪里、证据、已知缺口 |
| [M2Decisions](M2Decisions.md) | 仍然约束设计与实现的已定决定 |
| [Phase1Console](Phase1Console.md) | phase 1 控制台与流式输出：问题记录、流式的记录与删除规则、任务顺序 |
| [M2FrozenTests](M2FrozenTests.md) | 冻结的系统测试：不变量与阻断项的清点、被攻陷模型的对抗用例、phase 发布检查 |
| [Evaluation](Evaluation.md) | 评测体系：任务规格、度量、记录、对比，面向任何模式的任何测试集 |
| [M2TechStack](M2TechStack.md) | 实测结果、运行环境、依赖与版本 |
| [M2Security](M2Security.md) | 威胁模型、沙盒与授权的分层防护、C5 拦截矩阵 |
| `Interface/` | 字段级接口，按通讯边界拆分；发布版只有 major 1 一套 Schema |
| `Module/` | 三个 Module 的 M2 机制；Kernel 文档从外部视角描述 syscall 与事件 |
| `Kernel/` | Kernel 各组件的 M2 职责，以及 Session actor 中的内部交互 |
| `Library/` | 三个静态库：Agent、Unit、Tool、Prompt、模板定义，Executor，Schema |
| `Infrastructure/` | 四类基础设施的 M2 职责与边界 |
| [SystemFaultHandling](SystemFaultHandling.md) | 异常语义、停机与退出码 |
| `M2Usage.md`、`M2Limitations.md` | 发布前编写（phase 3）：运行说明与已知限制 |

验收证据在发布时编写，放在 `docs/` 根目录，与 M1 的做法相同。

## 3. 组件文档的写法

每篇组件文档都是完整的：以对应的 M1 文档为底稿，按 M2Design 改写，读者不需要再对照 M1。
每篇使用相同的章节：

1. **定位**：职责边界，以及在 Architecture 中的对应位置；
2. **相对 M1 的变化**：逐条列出，并注明 M2Design 中的依据；
3. **职责与私有数据**；
4. **状态与流程**：状态机、处理顺序；
5. **接口**：只链接到 `Interface/` 中的定义，不重复字段；
6. **不变量与测试**：对应 M2Design 第 12 节的编号，写明由哪类测试保证；
7. **配置**：配置项、读取者、缺省值。

文档描述的是当前的设计与实现，不记录"哪个阶段引入"。需要查某项机制的来由时，看 M2Design 的版本记录与 [History/M2](../History/M2/README.md)。

## 4. 文档状态

状态取值：草稿、已评审、已实现。实现合入集成分支后，对应文档改为"已实现"；以 M2ReleasePlan 为准，发布前全部应为"已实现"。

| 文档 | 状态 |
|---|---|
| [M2Design](M2Design.md) | v1.34 定稿 |
| [M2ReleasePlan](M2ReleasePlan.md)、[M2Baseline](M2Baseline.md)、[M2Decisions](M2Decisions.md)、[M2FrozenTests](M2FrozenTests.md)、[Evaluation](Evaluation.md) | 新（phase 0），待评审 |
| [M2TechStack](M2TechStack.md) | 实测已填 |
| [M2Security](M2Security.md) | 已实现部分已评审；phase 1–3 的对抗用例与审计后更新 |
| [Interface](Interface/README.md)：[WorkflowKernel](Interface/WorkflowKernel.md)、[InteractionKernel](Interface/InteractionKernel.md)、[Persistence](Interface/Persistence.md)、[Definitions](Interface/Definitions.md)、[KernelSupervisor](Interface/KernelSupervisor.md) | 已实现 |
| Module：[Kernel](Module/Kernel.md)、[Workflow](Module/Workflow.md)、[UserInteraction](Module/UserInteraction.md) | 已实现；Workflow 的使用者模板与预置工作流部分为设计（phase 2） |
| Kernel：[Interaction](Kernel/Interaction.md)、[Core](Kernel/Core.md)、[Gateway](Kernel/Gateway.md)、[Execution](Kernel/Execution.md)、[Monitor](Kernel/Monitor.md)、[Supervisor](Kernel/Supervisor.md) | 已实现 |
| Library：[AgentToolPool](Library/AgentToolPool.md)、[ExecutorSet](Library/ExecutorSet.md)、[SharedContracts](Library/SharedContracts.md) | 已实现；Agent 与 Prompt 模板库部分为设计（phase 2） |
| Infrastructure：[Persistence](Infrastructure/Persistence.md)、[ArtifactStore](Infrastructure/ArtifactStore.md)、[ModuleHost](Infrastructure/ModuleHost.md)、[Fabric](Infrastructure/Fabric.md) | 已实现 |
| [SystemFaultHandling](SystemFaultHandling.md) | 已实现 |
| M2Usage、M2Limitations | 未开始（phase 3） |
