# MultiAgentOS

MultiAgentOS 是面向软件工程与知识工作的模块化 Agent 编排和执行系统，目标平台为 Ubuntu LTS，规范版本为 24.04。
长期文档定义概念、职责与安全边界，各 MVP 再明确实现和验收。

## 快速开始

M2 在开发中。当前可用的是 Turn-chat：在一个本地仓库上持续对话，main 可以读、写、运行命令（在沙盒中）、联网、派生 SubAgent，Session 可以保存、切换、回退和继续，长对话会自动压缩；写入、命令与联网都先询问。预置的编排工作流与使用者模板还没有做，见 [M2ReleasePlan](docs/M2/M2ReleasePlan.md)。
以下在 Ubuntu 24.04 上执行，需要 Node.js 24（`>=24.19.0 <25`）、pnpm 11.25.0 与 DeepSeek 的 API key。

```bash
# 1. 安装与构建（在 MultiAgentOS 目录下）
sudo apt-get install -y ripgrep          # 可选，有 rg 时检索更快
pnpm install --frozen-lockfile
pnpm run build

# 2. 提供 API key（只从环境变量或本目录下不入库的 .env 读取）
export DEEPSEEK_API_KEY=<你的 key>

# 3. 进入对话；--repo 是要处理的仓库，缺省为当前目录
node apps/control-plane/dist/bin.js --repo /home/me/projects/my-app

# 或者把一个目标作为长任务一直做到完成，结束后退出
node apps/control-plane/dist/bin.js run --repo /home/me/projects/my-app "给登录失败加上清楚的错误信息，并补上测试"
```

第一次需要读仓库时，终端会询问是否允许；`/help` 列出 `/new`、`/resume`、`/sessions`、`/undo`、`/compact` 等指令。

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

完整设计从 [Architecture 指南](docs/Architecture/README.md) 开始阅读。文档更新不表示对应能力已经实现。

## 当前交付范围

M1（只读仓库分析）已发布，文档归档在 [History/M1](docs/History/M1/README.md)。当前开发 M2：范围与设计见 [M2Design](docs/M2/M2Design.md)，
发布计划见 [M2ReleasePlan](docs/M2/M2ReleasePlan.md)，现状见 [M2Baseline](docs/M2/M2Baseline.md)。不应将架构文档中的长期能力理解为已经交付。

## 仓库结构

```text
apps/
  cli/                    UserInteraction 的 CLI Adapter
  control-plane/          唯一组合根与进程入口
packages/
  modules/
    kernel/               Kernel：Session actor、execution、monitor、scheduler、gateway、supervisor
    workflow/             Workflow
    user-interaction/     UserInteraction
  libraries/
    contracts/            SharedContracts：Schema、Port、Protocol Registry
    agent-tool-pool/      AgentToolPool：Agent、Unit、Tool、Model、Prompt 定义目录
    executor-set/         ExecutorSet：仓库访问、检索、文件读取、上下文组装与模型调用
  infrastructure/
    fabric/               Fabric：同进程通信、Inbox 与有序发送器
    module-host/          ModuleHost：装配与生命周期
    persistence/          Persistence：Session 存储与实例锁
    artifacts/            ArtifactStore：本地内容寻址存储
  testing/                Fakes、Contract tests、架构测试和 fixtures
docs/
  Architecture/         长期概念与架构
  M2/                   当前设计、发布计划、现状、机制与接口
  Requirements/         当前依赖
  Meetings/             原始会议记录
  History/              已归档的文档：M1，以及 M2 第一轮实现的旧计划与实测
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

**支持的平台只有 Linux（规范版本 Ubuntu 24.04 LTS）和 Windows 上的 WSL2（Ubuntu 24.04）。M2 不适配 Windows 原生**：命令的沙盒是 bubblewrap，只有 Linux 有，Windows 原生没有，按设计拒绝运行命令；符号链接、进程、实例锁等也按 Linux 的语义实现。在 Windows 上请进入 WSL2 里运行与开发（`scripts/wsl-gate.sh` 可以在 WSL 里检查某个提交）。最终验收在 Ubuntu 24.04 LTS 上执行。
检索在系统中有 `rg`（ripgrep）时使用它，否则使用内置扫描；本地运行全部测试需要安装 ripgrep，
Ubuntu 上为 `sudo apt-get install -y ripgrep`。

`pnpm run gate:phase` 在 Ubuntu 24.04 上运行冻结的系统测试（每个 phase 发布前必须通过，任何测试被跳过都算失败）；`pnpm run eval` 是评测体系（[Evaluation](docs/M2/Evaluation.md)），真实模型的评测需要 `--yes` 与请求预算。

精确依赖见 [Dependencies](docs/Requirements/Dependencies.md)。代码、文档、Commit、分支与 Pull Request 规则见 [Style](docs/Style.md)。

## 文档入口

- [总文档索引](docs/README.md)
- [Architecture 指南](docs/Architecture/README.md)
- [整体架构](docs/Architecture/Overall.md)
- [协议架构](docs/Architecture/Protocol.md)
- [运行实例](docs/Architecture/Instance.md)
- [M2 文档](docs/M2/README.md)
- [M1 归档](docs/History/M1/README.md)
- [M2 历史（旧计划与实测）](docs/History/M2/README.md)

所有合并到 `feat/M2` 或 `main` 的变更都必须通过 Pull Request。
