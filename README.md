# MultiAgentOS

MultiAgentOS 是一个面向软件工程任务的模块化 Agent 编排与执行系统。项目从 M1 起保留 UserInteraction、Workflow、Kernel、ContextEngine、AgentToolPool 五个 Module，以及 Module Host、Shared Contracts、Persistence、Communication、Artifact Store 五项 Infrastructure；首版先以薄实现交付一个可运行的单 Agent，再在既有协议槽位中增加持久恢复、并行协作和生产治理能力。

当前仓库处于 M1（产品版本 `0.1.0`）实现阶段。M1–M5 是开发里程碑；M5 完成并通过生产验收后发布首个完整产品版本 V1.0。

## M1 / 0.1 目标

首版交付一个本地、单用户、单项目、单 Agent 的只读 Repository Analysis MVP；Coding Agent 从 M2 开始：

- UserInteraction 的 CLI adapter 接收目标并创建 WorkSession、PromptRevision 与 UserIntent。
- AgentToolPool 通过内置只读目录固定 Agent/Model/Tool/Prompt 的 DefinitionVersion。
- Workflow 管理单 Task 的只读分析 loop、步骤预算、终止和来源完整性验收。
- ContextEngine 分析仓库、搜索相关代码并生成带来源的 ContextPack。
- Kernel 调用一个模型 Provider，只准入 tree/search/read 等只读工具，并拒绝写入、命令和测试。
- Agent 对陌生仓库执行多轮检索和读取，形成带 revision、path/line 与 provenance 的结论。
- 最终输出 AnalysisReport、未确认项、步骤记录、模型用量、耗时和失败原因。

M1 使用模块化单体，不以 DBOS、多任务并行、复杂恢复、Checkpoint 或多 Agent 为完成条件。

## 核心执行路径

```text
CLI -> UserInteraction -> Kernel -> Workflow
                                  |-> AgentToolPool (fix DefinitionVersion)
                                  +-> UnitIntent -> Kernel
                                                    |-> ContextEngine
                                                    +-> Model/Tool/Workspace Executor
ContextEngine/Executor -> UnitResult/Event -> Kernel -> Workflow
Workflow Event + execution state -> Kernel RuntimeProjection -> UserInteraction -> CLI
```

五个 Module 共同处理同一个 Task：CLI 不绕过 UserInteraction，Workflow 不直连 ContextEngine 或执行器，Kernel 不决定业务成功，ContextEngine 不修改 workspace，AgentToolPool 不执行 Unit。同进程同步协作使用公开、运行时校验的 Port；Event、Signal、异步 Command、durable boundary 和跨进程调用必须使用 Envelope 与 Communication Fabric。

## 文档入口

- [`M1RequirementsSpecification.md`](docs/Requirements/M1RequirementsSpecification.md)：M1 软件需求规格、需求编号、验收标准和追踪矩阵。
- [`M1DependencyBaseline.md`](docs/Requirements/M1DependencyBaseline.md)：M1 精确运行时/npm 版本、依赖所有权、安装规则和后续阶段排除项。
- [`M1ProtocolSpecification.md`](docs/Protocols/M1ProtocolSpecification.md)：跨模块协议、版本兼容、身份链、错误与后续能力插槽的规范性定义。
- [`TargetM1.md`](docs/M1Plan/TargetM1.md)：当前 M1/0.1 的范围、框架、兼容协议、验收标准以及 M2–M5 路线图。
- [`M1AchievePlan.md`](docs/M1Plan/M1AchievePlan.md)：三个人四周的具体任务、依赖顺序、每周退出条件和交付物。
- [`M1Process.md`](docs/M1Plan/M1Process.md)：M1 顺序任务的实时完成表、验证证据和阶段退出状态。
- [`AchievePlan.md`](docs/DesignReport/AchievePlan.md)：从 M1 到 M5 的五阶段产品化路线、技术栈、发布门和验收任务。
- [`TargetArchitecture.md`](docs/DesignReport/TargetArchitecture.md)：长期完整架构，不直接构成当前发布要求。
- [`WorkflowModuleReport.md`](docs/DesignReport/WorkflowModuleReport.md)：Workflow 完整目标设计；M1 只实现 `TargetM1.md` 规定的子集。
- [`TechStack.md`](docs/TechStack.md)：当前与目标技术选项、替代方案和验证项。

## 演进路线

1. **M1 / 0.1**：五 Module/五 Infrastructure 稳定边界、单只读 Repository Analysis Agent。
2. **M2 / 0.2**：先建立安全的单 Coding Agent 与本地确认，再分阶段加入 PostgreSQL、DBOS、幂等、取消和崩溃恢复。
3. **M3**：静态多任务图、多 Executor Process、Lease/fencing、ChangeSet 和确定性 Git 集成。
4. **M4**：Checkpoint、审批、强执行隔离、Secret 和完整可观测性。
5. **M5 / V1.0**：多租户、远程执行、生产运维和平台化能力；通过完整生产验收后发布 V1.0。

架构或公共契约发生变化时，应先更新当前目标文档，再同步达成计划、模块设计、技术栈和本 README。

## 本地开发环境

仓库当前固定 Node.js `24.19.0`、pnpm `11.25.0` 和 TypeScript `6.0.3`，采用 3 个 app、11 个 package 的 pnpm workspace。Windows PowerShell 使用 `pnpm.cmd install` 安装依赖；提交前运行 `pnpm.cmd run check`。精确版本、依赖所有权及 M1 暂不安装的后续技术以 [`M1DependencyBaseline.md`](docs/Requirements/M1DependencyBaseline.md) 为准。
