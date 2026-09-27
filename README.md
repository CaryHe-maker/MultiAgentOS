# MultiAgentOS M1

MultiAgentOS 是面向软件工程与知识工作的模块化 Agent 编排和执行系统。它将用户交互、业务图、执行准入、上下文构建、能力目录与基础设施分离，使模型和工具行为处于可验证、可恢复、可审计的运行闭环中。

## 架构

```text
Web / CLI / IDE
       |
UserInteraction -> Kernel Control -> Workflow
                                   -> AgentToolPool
Workflow -> UnitIntent -> Kernel Unit Admission
                              |-> ContextEngine
                              |-> Model / Tool
                              +-> Workspace / Sandbox / Git Execution
UnitResult / Event -> Workflow -> Kernel RuntimeProjection -> UserInteraction

Module Host · Shared Contracts · Persistence
Communication Fabric · Artifact Store
```

系统遵守以下核心约束：

- 每类领域状态只有一个写入 Owner。
- Workflow 决定业务推进与验收，Kernel 负责控制和执行准入。
- 模型只提出动作，不能绕过 Kernel 直接执行工具。
- Executor 返回物理执行事实，不判断 Task 或 Workflow 是否成功。
- ContextEngine 在 MissionScope、ACL、revision 和 token 预算内发布不可变 ContextPack。
- 跨模块数据经过运行时 Schema 校验，大对象通过 ArtifactRef 传递。
- 重复消息、迟到结果、进程崩溃和未知副作用必须有确定的处理语义。

完整设计从 [Architecture 指南](docs/Architecture/README.md) 开始阅读。

## 当前交付范围

项目只确定 M1：交付本地、单用户、单项目、单进程、单 Agent、单活动 Task 的只读 Repository Analysis Agent。系统接收仓库分析问题，通过受控的 tree/search/read 路径生成包含 repository revision、路径、行范围和 provenance 的结构化报告。

M1 不执行文件写入、项目命令、项目测试或其他副作用。其他交付目标只能在 M1 完成验收后另行定义。范围、接口和实时状态分别见：

- [M1Plan](docs/M1/M1Plan.md)
- [M1TechStack](docs/M1/M1TechStack.md)
- [M1Interface](docs/M1/M1Interface.md)
- [M1Process](docs/M1/M1Process.md)

CLI 入口和完整 Agent 循环仍在实现中，不应将架构文档中的长期能力理解为已经交付。

## 仓库结构

```text
apps/
  cli/                  UserInteraction 的 CLI Adapter
  control-plane/        唯一组合根
  executor/             Kernel 管辖的执行 Adapter
packages/
  contracts/            Shared Contracts
  user-interaction/     交互领域
  workflow/             业务图与运行语义
  kernel/               控制与执行准入
  context-engine/       检索与上下文构建
  agent-tool-pool/      DefinitionVersion 目录
  module-host/          生命周期与组合
  persistence/          Repository Adapter
  communication/        消息路由 Adapter
  artifacts/            Artifact Store
  testing/              Fakes、Contract tests 和 fixtures
docs/
  Architecture/         完整长期架构
  M1/                   当前交付范围、接口与进度
  Requirements/         当前依赖
  Meetings/             原始会议记录
  Style.md              工程协作规范
```

## 开发环境

- Node.js `24.19.0`，允许 `>=24.19.0 <25`
- pnpm `11.25.0`
- TypeScript `6.0.3`

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd run build
pnpm.cmd run check
```

精确依赖见 [Dependencies](docs/Requirements/Dependencies.md)。代码、文档、Commit、分支与 Pull Request 规则见 [Style](docs/Style.md)。

## 文档入口

- [总文档索引](docs/README.md)
- [Architecture 指南](docs/Architecture/README.md)
- [整体架构](docs/Architecture/Overall.md)
- [协议架构](docs/Architecture/Protocol.md)
- [运行实例](docs/Architecture/Instance.md)
- [M1 指南](docs/M1/README.md)

所有合并到 `feat/M1` 或 `main` 的变更都必须通过 Pull Request。
