# MultiAgentOS M2 使用说明

> 适用于 M2 V1.1。机制见 [M2Design](M2Design.md) 与 [Orchestration](Orchestration.md)，已知限制见 [M2Limitations](M2Limitations.md)。

## 1. 平台与准备

- 平台：Linux（规范版本 Ubuntu 24.04 LTS）或 Windows 上的 WSL2（Ubuntu 24.04）。**不支持 Windows 原生**：命令的沙盒是 bubblewrap，只有 Linux 有（[M2Decisions](M2Decisions.md) 2a）。
- Node.js `>=24.19.0 <25`、pnpm `11.25.0`；可选 ripgrep（`sudo apt-get install -y ripgrep`），有 `rg` 时检索更快。
- 模型：DeepSeek（`deepseek-flash`），API key 只从环境变量 `DEEPSEEK_API_KEY` 或仓库目录下不入库的 `.env` 读取。

```bash
pnpm install --frozen-lockfile
pnpm run build
export DEEPSEEK_API_KEY=<你的 key>
alias mas='node /path/to/MultiAgentOS/apps/control-plane/dist/bin.js'
```

## 2. 两种模式

| 命令 | 模式 | 做什么 |
|---|---|---|
| `mas [--repo <路径>] [--readonly]` | Turn-chat | 在一个本地仓库上持续对话：读、检索、写与编辑、运行命令（沙盒中）、联网；把独立的一件事交给子任务（`subagent` 从提示开始、`subagent_fork` 从这段对话开始），把多部分的大目标交给 Mission（`mission`）；Session 可以保存、切换、回退、Fork 与继续，长对话自动压缩 |
| `mas run [--repo <路径>] [--readonly] "<目标>"` | Mission | 把一个目标作为长任务做到交付：根任务规划、把可以并行的部分派给子任务（worker、lead、explorer 与专家）、检查结果后交付，结束后退出；中途不等用户（[Orchestration](Orchestration.md) 第 10.1 节） |
| `mas log [--repo <路径>] [<session>] [--input <n>] [--full] [--json] [--list]` | 日志查看 | 一个对话的时间线：用户说了什么、模型调用了什么、得到了什么（[Console](Console.md) 第 3 节） |

`--repo` 缺省为当前目录；`--readonly` 只允许安全级能力，项目指令文件一律不信任。写入、命令与联网第一次需要时都先询问。

## 3. 对话里的指令

`/help` 列出全部指令。常用的：

| 指令 | 作用 |
|---|---|
| `/new`、`/sessions`、`/resume <n>`、`/delete <n>`、`/fork` | 新建、列出、打开、删除、分叉对话 |
| `/undo`、`/diff`、`/checkpoints`、`/rewind #N` | 回退文件改动、看差异、列出 checkpoint、暂停时回到第 N 个 |
| `/compact` | 立即压缩上下文 |
| `/status`、`/timeline`、`/output <编号>`、`/think <N>` | 状态、时间线、被截断的工具输出、某段思考的全文 |
| `/steer [@任务] <说明>`、`/continue [@任务] [说明]` | 运行中插话（不暂停）；暂停后继续，可附加一句说明 |
| `/recover` | 续跑上次进程退出时中断的长任务（打开对话后、输入任何内容之前） |
| `/exit` | 退出 |

快捷键：`Ctrl+O` 折叠或展开正在显示的思考块。

## 4. 配置与数据

- 数据目录缺省为 `~/.multiagentos`（对话日志、快照、产物）。
- `MULTIAGENTOS_CONFIG` 指向一个 JSON 文件，覆盖内置的缺省值（数据目录、额度、Workflow 与 Kernel 的上限等，见 `apps/control-plane/src/config/system-config.ts`）。`workflow.chatAgent` 选 Turn-chat 运行的 Agent：缺省 `chat`；`main` 是 Mission 的根任务，用 `run_subagents` 派出 worker、explorer、lead 与专家。
- 界面：`MAS_AMBIGUOUS_WIDTH=narrow|wide` 覆盖歧义宽度字符的测量；`NO_COLOR`、`FORCE_COLOR` 照常生效。

## 5. 检查与评测

```bash
pnpm run check        # 构建、格式、lint、全部测试
pnpm run gate:phase   # 冻结的系统测试（Ubuntu 24.04；任何测试被跳过都算失败）
pnpm run eval         # 评测体系（Evaluation）；真实模型需要 --yes 与请求预算
```

在 Windows 上开发时，`scripts/wsl-gate.sh <提交> [补丁]` 在 WSL 的克隆里跑完整检查。与 DeepSeek Harness（`dsh`）对照的任务集、运行脚本与规则见 [TaskSet](TaskSet.md)。
