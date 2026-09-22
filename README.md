# MultiAgentOS

MultiAgentOS 是一个面向软件工程任务的模块化 Agent 编排与执行系统。项目从 M1 起保留 UserInteraction、Workflow、Kernel、ContextEngine、AgentToolPool 五个 Module，以及 Module Host、Shared Contracts、Persistence、Communication、Artifact Store 五项 Infrastructure；首版先以薄实现交付一个可运行的单 Agent，再在既有协议槽位中增加持久恢复、并行协作和生产治理能力。

当前仓库处于 M1/V1 设计基线阶段。

## M1 / V1 目标

首版交付一个本地、单用户、单项目、单 Agent 的 coding MVP：

- UserInteraction 的 CLI adapter 接收目标并创建 WorkSession、PromptRevision 与 UserIntent。
- AgentToolPool 通过内置只读目录固定 Agent/Model/Tool/Prompt 的 DefinitionVersion。
- Workflow 管理单 Task 的 Agent loop、步骤预算、终止和结果验收。
- ContextEngine 分析仓库、搜索相关代码并生成带来源的 ContextPack。
- Kernel 调用一个模型 Provider，受控执行文件、命令和测试工具。
- Agent 在隔离 Git worktree 中完成搜索、修改、测试和必要的再次修复。
- 最终输出 Git diff、测试证据、步骤记录、模型用量、耗时和失败原因。

M1 使用模块化单体，不以 DBOS、多任务并行、复杂恢复、Checkpoint 或多 Agent 为完成条件。

## 核心执行路径

```text
CLI -> UserInteraction -> Kernel -> Workflow
                                  |-> AgentToolPool (fix DefinitionVersion)
                                  +-> UnitIntent -> Kernel
                                                    |-> ContextEngine
                                                    +-> Model/Tool/Workspace Executor
ContextEngine/Executor -> UnitResult/Event -> Kernel -> Workflow
Workflow/Event + execution state -> Kernel RuntimeProjection -> UserInteraction -> CLI
```

五个 Module 共同处理同一个 Task：CLI 不绕过 UserInteraction，Workflow 不直连 ContextEngine 或执行器，Kernel 不决定业务成功，ContextEngine 不修改 workspace，AgentToolPool 不执行 Unit。

## 文档入口

- [`M1RequirementsSpecification.md`](docs/Requirements/M1RequirementsSpecification.md)：M1 软件需求规格、需求编号、验收标准和追踪矩阵。
- [`TargetM1.md`](docs/M1Plan/TargetM1.md)：当前 M1/V1 的范围、框架、兼容协议、验收标准以及 M2–M5 路线图。
- [`M1AchievePlan.md`](docs/M1Plan/M1AchievePlan.md)：三个人四周的具体任务、依赖顺序、每周退出条件和交付物。
- [`TargetArchitecture.md`](docs/DesignReport/TargetArchitecture.md)：长期完整架构，不直接构成当前发布要求。
- [`WorkflowModuleReport.md`](docs/DesignReport/WorkflowModuleReport.md)：Workflow 完整目标设计；M1 只实现 `TargetM1.md` 规定的子集。
- [`TechStack.md`](docs/TechStack.md)：当前与目标技术选项、替代方案和验证项。

## 演进路线

1. **M1 / V1**：五 Module/五 Infrastructure 完整插槽、单 Agent、真实简单编码任务。
2. **M2**：PostgreSQL、DBOS、幂等、取消和崩溃恢复。
3. **M3**：静态多任务图、多 Executor Process、Lease/fencing、ChangeSet 和确定性 Git 集成。
4. **M4**：Checkpoint、审批、强执行隔离、Secret 和完整可观测性。
5. **M5**：多租户、远程执行、生产运维和平台化能力。

架构或公共契约发生变化时，应先更新当前目标文档，再同步达成计划、模块设计、技术栈和本 README。

## 本地开发环境

仓库使用 Node.js LTS 与 pnpm workspace。推荐 Node.js 24 LTS；最低版本由根 `package.json` 的 `engines` 声明。安装 Node.js 与 pnpm 后，在仓库根目录运行 `pnpm install` 下载已登记依赖。当前骨架尚未预装运行库；M1 应先安装 TypeScript/测试工具、协议校验库、CLI 和一个模型 Provider，暂不安装 DBOS、PostgreSQL、MCP、Playwright、容器或完整可观测平台依赖。
