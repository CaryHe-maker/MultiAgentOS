# MultiAgentOS

MultiAgentOS 是一个面向软件工程任务的模块化 Agent 编排与执行系统。项目把任务/Agent 循环、上下文选择和真实副作用执行划分为 Workflow、ContextEngine 与 Kernel 三个边界，使系统可以先交付一个可运行的单 Agent，再逐步增加持久恢复、并行协作和生产治理能力。

当前仓库处于 M1/V1 设计基线阶段。

## M1 / V1 目标

首版交付一个本地、单用户、单项目、单 Agent 的 coding MVP：

- CLI 接收一个简单软件工程目标。
- Workflow 管理单 Task 的 Agent loop、步骤预算、终止和结果验收。
- ContextEngine 分析仓库、搜索相关代码并生成带来源的 ContextPack。
- Kernel 调用一个模型 Provider，受控执行文件、命令和测试工具。
- Agent 在隔离 Git worktree 中完成搜索、修改、测试和必要的再次修复。
- 最终输出 Git diff、测试证据、步骤记录、模型用量、耗时和失败原因。

M1 使用模块化单体，不以 DBOS、多任务并行、复杂恢复、Checkpoint 或多 Agent 为完成条件。

## 核心执行路径

```text
CLI
 |
 v
Workflow ── ContextRequest ──> ContextEngine
 |<──────── ContextPack ──────+
 |
 +── ModelUnit / ToolUnit ───> Kernel
 |<──────── UnitResult ───────+
 |
 +── next AgentStep / final validation
 |
 v
Git diff + tests + run report
```

三个模块共同处理同一个 Task：Workflow 不直接执行副作用，Kernel 不决定业务成功，ContextEngine 不修改 workspace。

## 文档入口

- [`TargetM1.md`](docs/DesignReport/TargetM1.md)：当前 M1/V1 的范围、框架、兼容规则、验收标准以及 M2–M5 路线图。
- [`M1AchievePlan.md`](docs/DesignReport/M1AchievePlan.md)：三个人四周的具体任务、依赖顺序、每周退出条件和交付物。
- [`TargetArchitecture.md`](docs/DesignReport/TargetArchitecture.md)：长期完整架构，不直接构成当前发布要求。
- [`WorkflowModuleReport.md`](docs/DesignReport/WorkflowModuleReport.md)：Workflow 完整目标设计；M1 只实现 `TargetM1.md` 规定的子集。
- [`TechStack.md`](docs/TechStack.md)：当前与目标技术选项、替代方案和验证项。

## 演进路线

1. **M1 / V1**：单 Agent、三模块、真实简单编码任务。
2. **M2**：PostgreSQL、DBOS、幂等、取消和崩溃恢复。
3. **M3**：静态多任务图、多 Worker、Lease/fencing、ChangeSet 和确定性 Git 集成。
4. **M4**：Checkpoint、审批、强执行隔离、Secret 和完整可观测性。
5. **M5**：多租户、远程执行、生产运维和平台化能力。

架构或公共契约发生变化时，应先更新当前目标文档，再同步达成计划、模块设计、技术栈和本 README。
