# MultiAgentOS

MultiAgentOS 是面向软件工程与知识工作的模块化 Agent 编排和执行系统，目标平台为 Ubuntu LTS，规范版本为 24.04。
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
- 上下文与检索由 ExecutorSet 中的 Executor 完成，ContextPack 不可变并带仓库快照摘要、provenance 与 token 预算。
- 跨模块数据经过运行时 Schema 校验，大对象通过 ArtifactRef 传递。
- 重复消息、迟到结果、进程崩溃和未知副作用必须有确定的处理语义。

完整设计从 [Architecture 指南](docs/Architecture/README.md) 开始阅读。
M1 与 Architecture 的关系列于 [M1 指南](docs/M1/README.md) 第 7 节。文档更新不表示对应能力已经实现。

## 当前交付范围

项目只确定 M1：交付本地、单用户、单项目、单进程、单活动 Task 的只读仓库分析系统，由 Planner 与 CodeViewer 两个 Agent 单向交接完成。系统接收仓库分析问题，通过受控的概览、搜索与读取路径生成包含仓库快照摘要（`snapshotId`）、路径、行范围和 provenance 的结构化报告。

M1 不执行文件写入、项目命令、项目测试或其他副作用。其他交付目标只能在 M1 完成验收后另行定义。范围、机制和接口见 [M1 指南](docs/M1/README.md)，任务进度由 GitHub Issues 跟踪：

- [M1Plan](docs/M1/M1Plan.md)
- [M1TechStack](docs/M1/M1TechStack.md)
- [M1Interface](docs/M1/M1Interface.md)

M1 的全部产品部件已经实现，正在进行真实模型联调与发布验收，进度见
[M1 发布工作计划](docs/M1ReleasePlan.md)。不应将架构文档中的长期能力理解为已经交付。

## 仓库结构

```text
apps/
  cli/                    UserInteraction 的 CLI Adapter
  control-plane/          唯一组合根与进程入口
packages/
  modules/
    kernel/               Kernel：core、execution、monitor、scheduler、gateway、supervisor
    workflow/             Workflow
    user-interaction/     UserInteraction
  libraries/
    contracts/            SharedContracts：Schema、Port、Protocol Registry
    agent-tool-pool/      AgentToolPool：Agent、Unit、Tool、Model、Prompt 定义目录
    executor-set/         ExecutorSet：仓库访问、检索、文件读取、上下文组装与模型调用
  infrastructure/
    fabric/               Fabric：同进程通信、Inbox 与有序发送器
    module-host/          ModuleHost：装配与生命周期
    persistence/          Persistence：运行目录文件存储
    artifacts/            ArtifactStore：本地内容寻址存储
  testing/                Fakes、Contract tests、架构测试和 fixtures
docs/
  Architecture/         长期概念与架构
  M1/                   当前交付范围、机制与接口
  Requirements/         当前依赖
  Meetings/             原始会议记录
  History/              已归档的阶段工作文档
  M1ReleasePlan.md      M1 发布工作计划
  M1AcceptanceEvidence.md  M1 验收证据（草稿）
  Style.md              工程协作规范
```

## 开发环境

以下是仓库现有工程环境；项目规范平台为 Ubuntu 24.04 LTS。

- Node.js `24.19.0`，允许 `>=24.19.0 <25`
- pnpm `11.25.0`
- TypeScript `6.0.3`

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
```

开发平台不限，最终验收在 Ubuntu 24.04 LTS 上执行，CI 的兼容矩阵见 [M1TechStack](docs/M1/M1TechStack.md) 第 11 节。
检索在系统中有 `rg`（ripgrep）时使用它，否则使用内置扫描；本地运行全部测试需要安装 ripgrep，
Ubuntu 上为 `sudo apt-get install -y ripgrep`。

Kernel、四类基础设施、Workflow、UserInteraction、CLI、ExecutorSet 与 AgentToolPool 均已实现，
可以组成完整系统。固定任务集（F1–F5）与 #6 的安全陷阱已能离线通过；真实模型下的运行与发布验收尚未完成，
Prompt 与工具说明仍是 `PLACEHOLDER` 草稿。进度见 [M1 验收证据（草稿）](docs/M1AcceptanceEvidence.md)。

### 运行

```bash
pnpm run build
export DEEPSEEK_API_KEY=<key>
node apps/control-plane/dist/bin.js analyze --repo <仓库绝对路径> "<问题>"
```

- API key 只从环境变量读取（也可以写在 MultiAgentOS 自身工作目录下不入库的 `.env` 中），不读取被分析仓库的文件。
- 开始读取仓库前会询问授权（`y`/`n`）；按一次 Ctrl+C 取消运行，再按一次立即退出。
- `--details` 额外展示运行摘要（轮次、Unit 统计、token 用量）。
- 系统配置写在 JSON 文件中，由环境变量 `MULTIAGENTOS_CONFIG` 指定，只需写要改动的项；数据目录缺省为 `~/.multiagentos`。
  可配置项见 [M1TechStack](docs/M1/M1TechStack.md) 第 4 节。

| 退出码 | 含义 |
|---|---|
| 0 | 运行完成并展示了报告 |
| 1 | 运行失败（含拒绝授权、报告无法读取） |
| 2 | 运行超时 |
| 3 | 安全违规，运行被停止 |
| 4 | 运行没有被创建（如仓库路径无效） |
| 64 | 命令行参数错误 |
| 70 | 系统故障 |
| 130 | 被用户取消 |

### 演示与验收

- `pnpm run demo:fake` 用 `packages/testing` 的 fake 运行整条装配链路，回复全部是固定值，只用于演示接线。
- 离线的 F1–F5 与安全陷阱 S1–S5 包含在 `pnpm run test` 中（`apps/control-plane/test/acceptance/`）。
- `pnpm run acceptance -- [F1 … | all] [--runs N] --yes` 用真实模型运行固定任务集；不加 `--yes` 时只列出次数与费用上限，不发起请求。

Kernel 与 Infrastructure 的实现、验收矩阵和已知边界见已归档的
[M1 Kernel 与 Infrastructure 总实现报告](docs/History/M1KernelImplementationReport.md)。

精确依赖见 [Dependencies](docs/Requirements/Dependencies.md)。代码、文档、Commit、分支与 Pull Request 规则见 [Style](docs/Style.md)。

## 文档入口

- [总文档索引](docs/README.md)
- [Architecture 指南](docs/Architecture/README.md)
- [整体架构](docs/Architecture/Overall.md)
- [协议架构](docs/Architecture/Protocol.md)
- [运行实例](docs/Architecture/Instance.md)
- [M1 指南](docs/M1/README.md)
- [M1 发布工作计划](docs/M1ReleasePlan.md)
- [M1 验收证据（草稿）](docs/M1AcceptanceEvidence.md)
- [M1 Kernel 与 Infrastructure 总实现报告](docs/History/M1KernelImplementationReport.md)

所有合并到 `feat/M1` 或 `main` 的变更都必须通过 Pull Request。
