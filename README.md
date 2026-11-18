# MultiAgentOS

MultiAgentOS 是面向软件工程与知识工作的多 Agent 编排与执行系统。它像操作系统管理进程一样管理 Agent：模型只提出动作，由 Kernel 统一授权、调度、执行与计费；一个目标可以由一组 Agent 并行完成，也可以在对话中一步步推进，每一步都能回退。

> **版本**：M2 V1.1（2026-11-19）　**平台**：Ubuntu 24.04 LTS，或 Windows 上的 WSL2　**模型**：DeepSeek（`deepseek-flash`）

## 功能

- **两种模式，同一个系统**
  - **Turn-chat**（`mas`）：在一个本地仓库上持续对话。Agent 可以读、检索、写与编辑、运行命令（在沙盒中）、联网；把一件独立的事交给子任务（`subagent` 从它的提示开始，`subagent_fork` 从这段对话开始），把多部分的大目标交给 Mission。
  - **Mission**：把一个目标作为长任务做到交付。根任务规划，把可以并行的部分派给子任务（worker、lead、explorer 与专家），子任务之间可以发消息、等待彼此，检查结果后交付。在对话里用 `/mission <目标>`（chat 也可以自己决定）：Mission 代替 chat 工作直到它结束，期间你写的话交给它、它问的问题由你回答，它的答复就是这一轮的回答，之后 chat 带着它的结果接着谈；`mas run "<目标>"` 是给脚本与评测的入口，结束后退出。
- **安全**：命令在 bubblewrap 沙盒里运行；写入、命令、联网、读工作区之外的文件第一次需要时都先询问，拒绝绑定提出请求的 Agent；并行的子任务写入范围两两不相交，由 Kernel 强制；仓库里的 `AGENTS.md` 只有用户信任过的确切内容才当作项目指令。
- **额度**：运行、每次输入、每个任务三级账本；子任务开账时只拿最小份额、按需逐级向上补，不够时问用户要不要追加，结束时余额立即返还。
- **会话**：Session 保存在本地，可以切换、Fork、继续；每条输入是一个 checkpoint，`/undo` 回到它之前、`/diff` 看它改了什么；长任务暂停时可以回到运行中的 checkpoint，进程退出后可以从最近的 checkpoint 续跑；长对话自动压缩上下文。
- **可重建**：会话状态是只追加日志的投影，重复消息、迟到结果、进程崩溃都有确定的处理；跨模块的数据都经过运行时 Schema 校验。

## 安装

需要 Node.js `>=24.19.0 <25`、pnpm `11.25.0` 与 DeepSeek 的 API key；可选 ripgrep（有 `rg` 时检索更快）。**不支持 Windows 原生**：命令的沙盒只有 Linux 有，在 Windows 上请在 WSL2 里运行。

```bash
sudo apt-get install -y ripgrep          # 可选
pnpm install --frozen-lockfile
pnpm run build
export DEEPSEEK_API_KEY=<你的 key>      # 只从环境变量或本目录下不入库的 .env 读取
alias mas='node /path/to/MultiAgentOS/apps/control-plane/dist/bin.js'
```

## 使用

```bash
mas --repo /home/me/projects/my-app                 # 进入对话；--repo 缺省为当前目录，--readonly 只允许安全级能力
mas run --repo /home/me/projects/my-app "给登录失败加上清楚的错误信息，并补上测试"   # 一个长任务做到完成，结束后退出
mas log --repo /home/me/projects/my-app             # 查看一个对话的时间线
```

对话里常用的指令（`/help` 列出全部）：

| 指令 | 作用 |
|---|---|
| `/mission <目标>` | 把一个大目标交给 Mission |
| `/new`、`/sessions`、`/resume <n>`、`/fork` | 新建、列出、打开、分叉对话 |
| `/undo`、`/diff`、`/checkpoints`、`/rewind #N` | 回退文件改动、看差异、列出 checkpoint、暂停时回到第 N 个 |
| `/steer [@任务] <说明>`、`/continue [说明]` | 运行中插话；暂停（Ctrl+C）后继续 |
| `/compact`、`/recover`、`/exit` | 压缩上下文、续跑上次中断的长任务、退出 |

配置（`MULTIAGENTOS_CONFIG`）、数据目录与全部指令见 [M2Usage](docs/M2/M2Usage.md)。

## 实验结果

两种模式都与 DeepSeek Harness（`dsh`，单 Agent）对照：同一模型 `deepseek-flash`、同一镜像、同一判分、同一时间上限，每道各跑一次。`dsh` 用 `read_image` 看图的题（mas 没有图片输入）与 `dsh` 取了这道题自己的测试或参考解的题不计分（[TaskSet](docs/M2/TaskSet.md) 第 7 节）。大任务的成绩是 V1.0 测的（Mission 的规划、派生与检查规则在 V1.1 中没有改，仍是基线1.2），小任务的成绩是 V1.1 测的。

### Mission：大任务

在本项目设计的 5 道大任务（最终集：Lua 解释器、SQL 引擎、关系数据库、压缩与归档工具、三万字综述）上，Mission 与 DeepSeek Harness（`dsh`，单 Agent，同一模型 `deepseek-flash`、同一镜像、同一判分、同一时间上限）对照，每道各跑一次：

| | 总用时（分钟） | 平均分 | 费用（美元） | 缓存命中率 |
|---|---|---|---|---|
| **Mission（基线1.2）** | **87.8** | 0.917 | 1.76 | 98.6% |
| `dsh` | 126.6 | 0.931 | 1.07 | — |

5 道都比 `dsh` 快（4 道快 7–12 分钟，总用时少约 31%），2 道分数高于 `dsh`、1 道同为满分；费用约为 1.6 倍，主要来自多个 Agent 各自的思考与检查。pylua 取同一版本的重复运行：正式运行那一次 DeepSeek 两次断流，用时受环境影响（[experiments](docs/M2/experiments.md)）。

平均分低于 `dsh` 几乎全部来自 pyarchive 一道（0.903 对 1.000）。把它单独拿出来看：

| | 总用时（分钟） | 平均分 | 费用（美元） |
|---|---|---|---|
| 除 pyarchive 外的 4 道：Mission | **69.1** | **0.921** | 1.50 |
| 除 pyarchive 外的 4 道：`dsh` | 105.7 | 0.913 | 0.84 |
| 5 道，pyarchive 取同一版本的重复运行（1.000 / 12.8 分钟）：Mission | **81.9** | **0.936** | 1.85 |
| 5 道：`dsh` | 126.6 | 0.931 | 1.07 |

- 除 pyarchive 外的 4 道，Mission 总用时少 36.6 分钟（约 35%），平均分高 0.008。
- pyarchive 用同一版本重跑一次得满分、12.8 分钟（比 `dsh` 快 8.1 分钟）；换上这一次，5 道的平均分也高于 `dsh`（0.936 对 0.931），总用时少约 35%。

这说明系统存在偶然的低效：同一版本在同一道题上会拆出不同的方案，单次运行可能慢一倍或低一些分（[M2Limitations](docs/M2/M2Limitations.md) 第 7 条）。但在绝大部分任务上，Mission 相对 `dsh` 的优势是稳定的：用时都更少，分数持平或更高。上面第一张表是正式口径，这张表只用来说明这种偶然性，不替换正式成绩。开发集上的大任务（awk、Python 子集、GNU 文本工具）Mission 都不低于 `dsh` 的分数，用时少 20%–49%。

### Turn-chat：小任务

Turn-chat（M2 V1.1 的 chat）在 Terminal-Bench 2 与 SWE-Bench Pro 的小任务上，两边都没有派子任务（单 Agent 对单 Agent）；费用都按 DeepSeek 的低峰价格：

| 任务集 | 计分 | Turn-chat 通过 / 用时 / 费用 | `dsh` 通过 / 用时 / 费用 |
|---|---|---|---|
| 最终集小任务 | 8 道 | **8/8** / 27.9 分 / $0.149 | 8/8 / 22.9 分 / $0.140 |
| 最终集小任务，除 llm-inference-batching-scheduler | 7 道 | **7/7** / **19.4 分** / **$0.092** | 7/7 / 18.7 分 / $0.107 |
| 开发集小任务（每题最近一次运行） | 7 道 | **6/7** / **18.0 分** / $0.092 | 6/7 / 20.6 分 / $0.087 |

- 通过数与 `dsh` 相同。最终集 8 道里 4 道快于 `dsh`（都是改代码的题）；用时多出的部分几乎全在 llm-inference-batching-scheduler：一道优化题，过了阈值之后 mas 又把方案重写、扫了一遍参数，按测试的成本模型算的指标与 `dsh` 持平。
- 把 llm-inference-batching-scheduler 放在一边，最终集的 7 道用时与 `dsh` 持平、费用低 14%；开发集用时少 13%。
- mailman 要写 `/etc`、起服务：评测容器里没有 bwrap 时，mas 的未隔离命令只能写任务目录与临时目录（D79），`dsh` 用的是 `danger-full-access`，所以这一道以 `kernel.sandbox.unisolatedWrites = any` 运行（与 `dsh` 相同的写权限）。
- 这一版的工具优化（检索与列目录的文件集合、命令前后的扫描）不改变结果，在一万个文件的仓库上把每次检索与每条命令的固定开销各减少一半以上；chat 的提示里加了思考要简短的一句后，最慢的两道各快一倍。

任务集、规则与逐次结果见 [TaskSet](docs/M2/TaskSet.md) 与 [experiments](docs/M2/experiments.md)，已知限制见 [M2Limitations](docs/M2/M2Limitations.md)。

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

- Workflow 决定业务推进与验收，Kernel 负责授权、调度、执行、资源与监管；每类领域状态只有一个写入 Owner。
- 模型只提出动作，不能绕过 Kernel 直接执行工具；Lease 只存在于 Core，授权只由人类签发。
- Executor 在子进程中运行，只返回物理执行事实，不判断任务是否成功。
- 跨模块数据经过运行时 Schema 校验，契约（major 1）已冻结，大对象通过 ArtifactRef 传递；Agent、工具与提示词的定义已封存（`v1.0.0`、`v1.1.0`，带 digest）。

设计从 [M2 文档](docs/M2/README.md) 开始读：[M2Design](docs/M2/M2Design.md)（总体设计）、[Orchestration](docs/M2/Orchestration.md)（长任务与决定记录）、各模块与接口文档；长期架构见 [Architecture](docs/Architecture/README.md)（长期文档不表示对应能力已经实现）。

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
  M2/                   M2 V1.1 的设计、使用、限制、评测、机制与接口
  Requirements/         当前依赖
  Meetings/             原始会议记录
  History/              已归档的文档：M1，以及 M2 开发过程中的旧计划与实测
  Style.md              工程协作规范
```

## 开发

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run check        # 格式、lint、类型检查与全部测试
pnpm run gate:phase   # 冻结的系统测试（Ubuntu 24.04；每次发布前必须通过，任何测试被跳过都算失败）
pnpm run eval         # 评测体系；真实模型需要 --yes 与请求预算
```

Node.js `24.19.0`、pnpm `11.25.0`、TypeScript `6.0.3`；本地跑全部测试需要 ripgrep。在 Windows 上开发时，`scripts/wsl-gate.sh <提交> [补丁]` 在 WSL 的克隆里跑完整检查。精确依赖见 [Dependencies](docs/Requirements/Dependencies.md)，代码、文档、Commit、分支与 Pull Request 的规则见 [Style](docs/Style.md)；合并到 `main` 与 `feat/*` 的变更都经过 Pull Request。

## 已知限制

- 只接入了 DeepSeek；没有图片输入。
- Mission 比单 Agent 快，但更贵（大任务约 1.6 倍）；同一版本在同一道题上的拆分方式有随机性。
- 沙盒没有 CPU 与内存总量限制；使用者自己写的工作流模板、`/run` 没有做。

完整清单见 [M2Limitations](docs/M2/M2Limitations.md)。

## 版本

| 版本 | 日期 | 内容 |
|---|---|---|
| **M2 V1.1** | 2026-11-19 | chat 按单 Agent 的写法重写，派生改为 `subagent`、`subagent_fork` 与 `mission`；`/mission <目标>`，Mission 代替 chat 工作到它结束、拿 chat 这一轮的全部额度；派生时额度不够先问用户；工具的固定开销减半，结果不变；`kernel.sandbox.unisolatedWrites`（[Orchestration](docs/M2/Orchestration.md) D112–D115） |
| M2 V1.0 | 2026-11-18 | Turn-chat 与 Mission（Mission 基线1.2）两种模式：写入、命令与沙盒、联网、checkpoint 与回退、Session、上下文压缩、多 Agent 长任务 |
| M1 | 2026-10-25 | 只读的仓库分析（文档归档在 [History/M1](docs/History/M1/README.md)） |

