# MultiAgentOS M2 指南

## 1. 目的与范围

本目录定义 M2 的设计、各组件机制、跨模块接口、评测与验收要求，描述的是 **M2 V1.0** 的实现。
M2 的范围与设计以 [M2Design](M2Design.md) 为准，编排（Mission）的机制以 [Orchestration](Orchestration.md) 为准；本目录其余文档在它们的基础上展开，可以细化，不得与它们矛盾。

怎么用见 [M2Usage](M2Usage.md)，已知限制见 [M2Limitations](M2Limitations.md)，评测任务集与结果见 [TaskSet](TaskSet.md)。
M2 开发过程中的旧计划、决定记录与实测已冻结在 [History/M2](../History/M2/README.md)，不是现行规范。
长期概念与安全边界见 [Architecture 指南](../Architecture/README.md)；M1 已发布，其规范归档在 [History/M1](../History/M1/README.md)。

## 2. 目录组织

| 目录或文档 | 内容 |
|---|---|
| [M2Design](M2Design.md) | 总体设计：能力、机制与 Owner、不变量、验收 |
| [Orchestration](Orchestration.md) | 编排架构：MissionTree、后台命令、休眠与唤醒、跨任务消息、checkpoint；第 1 节是全部机制的决定记录（D1–D111） |
| [M2Usage](M2Usage.md) | 使用说明：平台、两种模式（Turn-chat、Mission）、指令、配置、检查与评测 |
| [M2Limitations](M2Limitations.md) | 已知限制 |
| [M2Decisions](M2Decisions.md) | 仍然约束设计与实现的已定决定 |
| [Console](Console.md) | 控制台与流式输出：界面、日志查看器 `mas log`、思考的流式显示 |
| [Evaluation](Evaluation.md) | 评测体系：任务规格、度量、记录、对比 |
| [TaskSet](TaskSet.md) | M2 的评测任务集（开发集、最终集）、运行规则、`dsh` 对照与最终集的结果 |
| [experiments](experiments.md) | 每次真实模型运行的目的、参数、结果与随后的改动 |
| [M2FrozenTests](M2FrozenTests.md) | 冻结的系统测试：不变量与阻断项的清点、被攻陷模型的对抗用例、发布检查 |
| [M2TechStack](M2TechStack.md) | 实测结果、运行环境、依赖与版本 |
| [M2Security](M2Security.md) | 威胁模型、沙盒与授权的分层防护、C5 拦截矩阵 |
| [SystemFaultHandling](SystemFaultHandling.md) | 异常语义、停机与退出码 |
| `Interface/` | 字段级接口，按通讯边界拆分；只有 major 1 一套 Schema |
| `Module/` | 三个 Module 的 M2 机制；Kernel 文档从外部视角描述 syscall 与事件 |
| `Kernel/` | Kernel 各组件的 M2 职责，以及 Session actor 中的内部交互 |
| `Library/` | 三个静态库：Agent、Unit、Tool、Prompt、模板定义，Executor，Schema |
| `Infrastructure/` | 四类基础设施的 M2 职责与边界 |

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

文档描述的是当前的设计与实现，不记录"哪个阶段引入"。需要查某项机制的来由时，看 M2Design 的版本记录、Orchestration 的决定记录与 [History/M2](../History/M2/README.md)。

## 4. 版本

**M2 V1.0**（2026-11-18）：Turn-chat 与 Mission 两种模式；Mission 即 Mission 基线1.2（Orchestration D110、D111，git 标签 `mission-baseline-1.2`），在最终集的 5 道大任务上与 `dsh` 对照：总用时 103.8 对 126.6 分钟，平均分 0.917 对 0.931，费用 $1.79 对 $1.07（[TaskSet](TaskSet.md) 第 6 节）。本目录全部文档描述的机制都已实现。
