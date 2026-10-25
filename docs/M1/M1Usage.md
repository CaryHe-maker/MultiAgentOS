# M1 运行说明

本文说明如何在 Ubuntu 24.04 LTS 上安装、配置并运行 M1：对一个本地仓库提出问题，得到带来源的分析报告。
已知限制见 [M1Limitations](M1Limitations.md)，配置项的含义见 [M1TechStack](M1TechStack.md) 第 4 节。

## 1. 安装

需要 Node.js `>=24.19.0 <25`（仓库的 `.node-version` 为 `24.19.0`）与 pnpm `11.25.0`；建议安装 ripgrep。

```bash
sudo apt-get install -y ripgrep        # 可选：有 rg 时检索更快
pnpm install --frozen-lockfile
pnpm run build
```

构建后的入口是 `apps/control-plane/dist/bin.js`（包内命令名 `multiagentos`）。

## 2. API key

M1 只接入 DeepSeek。API key 只从环境变量 `DEEPSEEK_API_KEY` 读取：

```bash
export DEEPSEEK_API_KEY=<key>
```

本地开发时也可以写在 MultiAgentOS 自身工作目录下的 `.env` 中（已被 `.gitignore` 忽略）。
系统从不读取被分析仓库里的 `.env`，key 也不会写入配置、日志、运行记录或报告。

## 3. 分析一个仓库

```bash
node apps/control-plane/dist/bin.js analyze --repo <仓库绝对路径> [--details] "<问题>"
```

1. 系统先解析仓库的真实路径，列出将要排除的路径，询问是否允许读取（`y`/`n`）。拒绝或 5 分钟内未回答时不读取仓库，
   运行以失败结束（退出码 1）。
2. 同意后，Planner 把问题整理成任务交给 CodeViewer；CodeViewer 检索、读取文件并写出报告。
3. 报告包含结论（每条附读取过的文件路径与行范围）、未确认项，以及提前收尾时的原因。
4. `--details` 额外展示运行摘要：各 Agent 的轮数、Unit 统计与 token 用量。

按一次 Ctrl+C 取消运行，系统收敛后退出；再按一次立即退出。

问题与报告使用同一种语言；CLI 的提示与错误信息为中文。

## 4. 配置

系统配置写在 JSON 文件中，由环境变量 `MULTIAGENTOS_CONFIG` 指定；文件只需写要改动的项，其余使用内置默认值。
出现未知的键、类型不符或 `dataDir` 不是绝对路径时系统不启动。

```json
{
  "dataDir": "/home/me/.multiagentos",
  "kernel": {
    "repositoryExclusions": ["**/fixtures/**"],
    "budget": { "tokenLimit": 300000 }
  }
}
```

| 常用配置 | 默认值 | 说明 |
|---|---|---|
| `dataDir` | `~/.multiagentos` | 运行记录、报告与产物的目录 |
| `kernel.budget.tokenLimit` | 300000 | 单次运行的 token 额度，不能小于收尾所需的保留额度（启动时检查） |
| `kernel.runTimeoutMs` | 1800000 | 运行超时（30 分钟） |
| `kernel.authorizationTimeoutMs` | 300000 | 授权询问的期限（5 分钟） |
| `kernel.repositoryExclusions` | `[]` | 追加的排除规则（写法见 M1Interface 3.5），不能删除默认规则 |
| `kernel.maxSnapshotFiles` | 20000 | 快照的文件数上限 |

全部配置项见 [Kernel/Interaction](Kernel/Interaction.md) 第 9 节、[Monitor](Kernel/Monitor.md) 第 4 节与
[Workflow](Module/Workflow.md) 第 12 节。

## 5. 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 运行完成并展示了报告（包括提前收尾的降级报告） |
| 1 | 运行失败（含拒绝授权、报告无法读取） |
| 2 | 运行超时 |
| 3 | 安全违规，运行被停止 |
| 4 | 运行没有被创建（如仓库路径无效） |
| 64 | 命令行参数错误 |
| 70 | 系统故障 |
| 130 | 被用户取消 |

## 6. 演示与验收

| 命令 | 作用 |
|---|---|
| `pnpm run check` | 构建、lint、全部测试与格式检查；包含离线的固定任务集 F1–F5 与安全陷阱 S1–S5 |
| `pnpm run demo:fake` | 用 fake 运行整条装配链路，回复是固定值，只用于演示接线 |
| `pnpm run acceptance -- [F1 … \| all] [--runs N] [--yes]` | 用真实模型运行固定任务集；不加 `--yes` 时只列出运行次数与费用上限，不发请求。记录写入 `.multiagentos/acceptance/`（不入库） |

验收结果与基线见 [M1 验收证据](../M1AcceptanceEvidence.md)。
