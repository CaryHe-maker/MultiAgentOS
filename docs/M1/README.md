# MultiAgentOS M1 指南

## 1. 目的与范围

本目录定义 M1 的交付目标、技术选择、跨模块接口、任务进度和验收要求。
M1 面向本地、单用户、单项目、单进程、单 Agent、单活动 Task 的只读仓库分析，
输出包含 repository revision、路径、行范围和 provenance 的结构化报告。

长期概念、模块职责与安全边界见 [Architecture 指南](../Architecture/README.md)。
本目录说明这些能力在 M1 中的具体交付范围，不将长期架构中的全部能力视为 M1 要求。
其他 MVP 的范围与排期单独评审。

## 2. 阅读顺序

1. [M1Plan](M1Plan.md)：目标、范围、分工、任务、固定任务集和完成定义。
2. [M1TechStack](M1TechStack.md)：运行环境、技术选择、允许依赖与明确排除项。
3. [M1Interface](M1Interface.md)：公开 Port、Schema、消息与错误协议。
4. [M1Process](M1Process.md)：任务状态、实现差距与验证证据。

模块的 M1 实现说明放在 `docs/M1/<module>/` 下，例如 [AgentToolPoolM1](agent-tool-pool/AgentToolPoolM1.md)。

依赖版本见 [Dependencies](../Requirements/Dependencies.md)，
代码、文档、Git 和评审规范见 [Style](../Style.md)。

## 3. 文档职责

| 文档 | 负责内容 | 边界 |
|---|---|---|
| M1Plan | 交付范围、任务、验收和降级策略 | 不重新定义长期模块所有权 |
| M1TechStack | M1 使用的技术、版本用途和引入限制 | 不替代依赖 manifest |
| M1Interface | M1 具体接口与兼容约定 | 不因长期设计存在某能力就自动纳入交付 |
| M1Process | 状态、日期、证据、PR 和阻塞原因 | 不改变范围、接口或完成定义 |

## 4. 权威关系

- 长期模块边界和安全约束由 Architecture 定义。
- M1 的范围和完成条件以 M1Plan 为准。
- M1Interface 定义交付接口要求，代码中的 Schema 是已实现协议的可执行事实源。
- 目标与实现的差距在 M1Process 中记录，完成状态应有测试、报告或 PR 证据。
- 跨文档契约差异集中见 [架构衔接清单](../Architecture/README.md#6-文档衔接清单)。

## 5. 维护要求

- 范围变化同步检查计划、接口、任务和验收条件。
- 协议变化同步更新 Schema、兼容说明及生产者与消费者的契约测试。
- 任务完成时更新对应进度、日期和验证证据。
- 架构调整应评估 M1 的范围与接口影响，不以文档描述代替实现验证。
