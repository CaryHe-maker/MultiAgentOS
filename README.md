# MultiAgentOS

MultiAgentOS 是面向软件工程与知识工作的模块化 Agent 编排和执行系统，目标平台为 Ubuntu LTS。
长期文档定义概念、职责与安全边界，各 MVP 再明确实现和验收。

## 架构

```text
CLI
 |
UserInteraction -> Kernel.Gateway -> Workflow
Workflow -> submitUnit -> Gateway 准入 -> Core（定义核验、Lease、额度）
Kernel 核心（模块化单体）: Core · Scheduler · Execution · Monitor；Supervisor 独立；Gateway 逻辑独立
Execution -> Supervisor -> Executor 子进程运行 ExecutorSet 中的 Executor
执行事实 -> Core 结果检查 -> Outbox -> Workflow 验收 -> 用户视图

静态库：AgentToolPool · ExecutorSet · SharedContracts
基础设施：ArtifactStore · ModuleHost · Fabric · Persistence
```

系统遵守以下核心约束：

- 每类领域状态只有一个写入 Owner。
- Workflow 决定业务推进与验收，Kernel 负责授权、调度、执行、资源和监管。
- 每个 WorkflowRun 由一个 Kernel 核心实例按顺序处理；Executor 子进程中的执行可以并行。
- Kernel 核心内的组件只读写自己的数据，Lease 只由 Core 维护和使用。
- Lease 只存在于 Core，其他组件只取得裁决与派生的范围约束。
- Syscall、Interruption 与 Exception 由 Core 统一处理。
- 模型只提出动作，不能绕过 Kernel 直接执行工具。
- Executor 返回物理执行事实，不判断 Task 或 Workflow 是否成功。
- 上下文与检索由 ExecutorSet 中的 Executor 完成，ContextPack 不可变并带 revision、provenance 与 token 预算。
- 跨模块数据经过运行时 Schema 校验，大对象通过 ArtifactRef 传递。
- 重复消息、迟到结果、进程崩溃和未知副作用必须有确定的处理语义。

完整设计从 [Architecture 指南](docs/Architecture/README.md) 开始阅读。
M1 与 Architecture 的关系列于 [M1 指南](docs/M1/README.md) 第 7 节。文档更新不表示代码已完成迁移。

## 当前交付范围

项目只确定 M1：交付本地、单用户、单项目、单进程、单活动 Task 的只读仓库分析系统，由 Planner 与 CodeViewer 两个 Agent 单向交接完成。系统接收仓库分析问题，通过受控的概览、搜索与读取路径生成包含 repository revision、路径、行范围和 provenance 的结构化报告。

M1 不执行文件写入、项目命令、项目测试或其他副作用。其他交付目标只能在 M1 完成验收后另行定义。范围、机制和接口见 [M1 指南](docs/M1/README.md)，任务进度由 GitHub Issues 跟踪：

- [M1Plan](docs/M1/M1Plan.md)
- [M1TechStack](docs/M1/M1TechStack.md)
- [M1Interface](docs/M1/M1Interface.md)

CLI 入口和完整 Agent 循环仍在实现中，不应将架构文档中的长期能力理解为已经交付。

## 仓库结构

```text
apps/
  cli/                  UserInteraction 的 CLI Adapter
  control-plane/        唯一组合根
  executor/             现有 file-read 实现；目标归 ExecutorSet
packages/
  contracts/            Shared Contracts
  user-interaction/     交互领域
  workflow/             业务图与运行语义
  kernel/               Kernel 六组件
  context-engine/       现有检索与上下文代码；目标归 ExecutorSet
  agent-tool-pool/      DefinitionVersion 目录
  module-host/          生命周期与组合
  persistence/          Repository Adapter
  communication/        消息路由 Adapter
  artifacts/            Artifact Store
  testing/              Fakes、Contract tests 和 fixtures
docs/
  Architecture/         长期概念与架构
  M1/                   当前交付范围、机制与接口
  Requirements/         当前依赖
  Meetings/             原始会议记录
  Style.md              工程协作规范
```

## 开发环境

以下是仓库现有工程环境，不代表已经完成 Ubuntu LTS 部署验证。

- Node.js `24.19.0`，允许 `>=24.19.0 <25`
- pnpm `11.25.0`
- TypeScript `6.0.3`

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
```

开发平台不限，最终验收在 Ubuntu LTS 上执行；具体 LTS 版本与系统依赖由交付设计确认。

精确依赖见 [Dependencies](docs/Requirements/Dependencies.md)。代码、文档、Commit、分支与 Pull Request 规则见 [Style](docs/Style.md)。

## 文档入口

- [总文档索引](docs/README.md)
- [Architecture 指南](docs/Architecture/README.md)
- [整体架构](docs/Architecture/Overall.md)
- [协议架构](docs/Architecture/Protocol.md)
- [运行实例](docs/Architecture/Instance.md)
- [M1 指南](docs/M1/README.md)

所有合并到 `feat/M1` 或 `main` 的变更都必须通过 Pull Request。
