# MultiAgentOS 参考项目调研

> 调研日期：2026-08-23
>
> “尚未实现”指这些仓库的公开文档没有承诺，或从公开架构中可以明确看出的缺口，并不代表完整源码审计结论。

## 推荐的三个项目

| 项目 | 定位 | 推荐理由 |
|---|---|---|
| [mco-org/mco](https://github.com/mco-org/mco) | CLI-first 多 coding agent 编排层 | 最适合作为 MultiAgentOS 的底层调度参考 |
| [OpenHands/OpenHands](https://github.com/All-Hands-AI/OpenHands) | 自托管 coding agent 控制中心 | 最接近完整产品平台，支持本地、远程、Docker、VM 和多种 agent |
| [josstei/maestro-orchestrate](https://github.com/josstei/maestro-orchestrate) | 面向开发流程的专家型多 agent 工作流 | 最适合参考“规划—实现—审查—质量门”的完整协作流程 |

## 1. MCO

仓库：[mco-org/mco](https://github.com/mco-org/mco)

### 已完成

MCO 是一个轻量级、CLI-first 的 AI coding agent 编排层，主要能力包括：

- 并行调用 Claude、Codex、Gemini、OpenCode、Qwen、Copilot、Pi 等多个 provider。
- 支持代码审查、架构分析、实现任务和 CI 检查。
- 支持并行执行、顺序 chain、文件拆分、多维度 review、多模型对比和 JSON/JSONL/Markdown 结果输出。
- 保留每个 agent 的完整原始回答和运行状态。
- 提供 `read_only`、`write`、`yolo` 等执行权限模式。
- 支持 dry-run、provider/model 显式选择和调用前确认。
- 可以被另一个 coding agent 作为 CLI 调用。

### 尚未实现或不适合直接解决的部分

- 不负责创建和管理 Git worktree。
- 不提供完整的文件 ownership 管理。
- README 明确提示：并行写入时需要用户自行划分非重叠路径。
- 不自动进行真正的语义级代码冲突解决。
- 不会自动把多个 agent 的自然语言回答转换成可信的共识、置信度或最终决策。
- 更像“并行调用器”，而不是完整的全栈项目生命周期管理系统。
- 没有把 CPU/GPU 资源调度作为核心能力。

### 为什么难

MCO 采用的是“薄编排层”设计，因此它避免了很多复杂性，但也把难题留给了上层：

- 不同 CLI 的权限模型和参数格式不同。
- 不同 agent 输出格式、错误处理、流式协议不同。
- 并发调用容易触发 provider rate limit。
- 并行修改代码时，文本冲突可以通过 Git 发现，但接口语义冲突很难自动发现。
- 如果自动判断哪个 agent 正确，就必须引入测试、代码审查、证据聚合和风险评分，而不是简单投票。

### 对 MultiAgentOS 的借鉴

MCO 最适合作为 MultiAgentOS 的底层 `Provider Adapter + Dispatch Layer` 参考：

```text
Orchestrator
    ↓
MCO 类 provider adapter
    ↓
Codex / Claude / Gemini / Qwen / OpenCode
```

MultiAgentOS 应该在 MCO 之上增加 DAG、worktree、契约、冲突管理和资源调度。

## 2. OpenHands Agent Canvas

仓库：[OpenHands/OpenHands](https://github.com/All-Hands-AI/OpenHands)

当前主仓库 README 的重点是 Agent Canvas，定位为“自托管的 coding agent 和自动化控制中心”。

### 已完成

- 可以运行 OpenHands、Claude Code、Codex、Gemini 以及 ACP-compatible agent。
- 支持本地进程、Docker、VM、远程服务器和云端/企业环境等多种 agent backend。
- 可以在同一个前端控制多个 backend。
- 支持长期运行和后台任务。
- 支持 GitHub、Slack、Linear 等自动化集成。
- 支持通过 webhook 或计划任务触发 agent。
- 支持 Docker sandbox、自托管部署和任意 LLM。
- 具有更完整的前端控制中心和自动化产品形态。

### 尚未实现或仍有明显边界的部分

- Agent Canvas 当前公开标注为 beta，说明平台稳定性和 API 仍可能变化。
- 公开文档没有明确承诺面向前后端开发的确定性 DAG 调度、自动文件 ownership 分配、并行 worker 的语义级 merge、token 成本最小化策略或根据 CPU/GPU/API 资源动态决定并发度。
- 它可以触发多个 agent，但不等于已经解决了“多个 coding agent 如何安全协同修改同一个项目”。
- 不使用 sandbox 时，agent-server 对本机文件系统拥有完整访问权限，官方 README 也明确给出了安全警告。
- Docker 隔离解决的是执行边界，不自动解决 API 契约、数据库迁移、依赖文件和全局配置冲突。

### 为什么难

OpenHands 的难点主要在“平台级安全与多后端一致性”：

- 本地、Docker、VM、远程机器的权限和网络环境不同。
- 一个 agent 在本机运行，另一个 agent 在远程容器运行时，文件、日志和会话状态如何一致。
- ACP 只解决 agent 通信协议，不解决任务拆解、文件所有权和代码集成。
- 后台长期运行需要处理断线、重启、重复执行、任务租约和状态恢复。
- 集成 Slack、GitHub、Linear 等外部系统后，权限管理和敏感数据泄露风险显著增加。

### 对 MultiAgentOS 的借鉴

OpenHands 最适合作为 MultiAgentOS 的 Worker Runtime 抽象、Docker/VM/远程 backend、自托管控制中心、自动化触发层和 ACP 兼容层参考。

MultiAgentOS 需要在其之上补充：

```text
Task DAG
Contract Registry
File Ownership
Merge Coordinator
Token Budget Manager
Resource-aware Scheduler
```

## 3. Maestro

仓库：[josstei/maestro-orchestrate](https://github.com/josstei/maestro-orchestrate)

### 已完成

Maestro 是三个项目里最接近“完整软件开发流程编排”的一个。公开 README 显示它已经实现：

- 39 个专业角色/专家 agent。
- Express 快速路径，适合简单任务。
- Standard 四阶段流程，适合中大型任务。
- 持久化 session state。
- 独立的 review、debug、security、performance、SEO、accessibility、compliance 入口。
- 支持 Gemini CLI、Claude Code、Codex、Qwen Code。
- 支持 Codex plugin。
- 支持任务分类、设计问题澄清、实现计划生成、specialist delegation、quality gate、session archive 和 resume。
- 支持最大重试次数、最大并发数、parallel/sequential 执行模式和禁用 specialist 等配置。

典型流程类似：

```text
需求
  ↓
任务分类
  ↓
设计问题澄清
  ↓
实现计划
  ↓
专家 agent 执行
  ↓
质量门
  ↓
归档和恢复
```

### 尚未实现或存在边界的部分

- 主要面向 Gemini CLI、Claude Code、Codex、Qwen Code，不是任意 provider 的统一 API 网关。
- 公开文档没有明确证明它拥有完整分布式任务队列、跨机器 worker 调度、自动 Git worktree 生命周期管理、语义级跨 agent merge、GPU/CPU 感知调度或细粒度 token 成本优化。
- Codex runtime 文档显示它主要通过 plugin skill 和 `spawn_agent` 工作，不一定拥有完整底层运行时控制权。
- 多个 specialist 参与后，流程可能变得 token-heavy。
- 角色越多，协调消息、重复上下文和最终收敛成本越高。

### 为什么难

Maestro 的难点是“工作流完整性和多 runtime 兼容”：

- 同一套流程要适配多个 coding CLI。
- 不同 CLI 的 subagent、hook、权限和 session API 不一致。
- 39 个 specialist 并不代表任务一定更快，过多角色可能增加协调成本。
- 设计、实现、审查、修复之间需要共享状态，但共享过多会造成上下文膨胀。
- 质量门必须真正执行测试和静态检查，而不能只让 agent 自己报告“完成”。

### 对 MultiAgentOS 的借鉴

Maestro 最值得借鉴的是高层流程：

- 简单任务走快速路径。
- 复杂任务走标准工作流。
- 专家角色根据任务类型选择，而不是随意创建。
- 每个阶段有清晰输入、输出和质量门。
- 失败后可以恢复，而不是从头开始。

MultiAgentOS 可以采用类似结构：

```text
Express:
需求 → 单 agent → 测试 → 交付

Standard:
需求 → 架构 → 契约 → 前后端并行 → 集成 → 审查 → 交付
```

## 三个项目的差异

| 能力 | MCO | OpenHands Agent Canvas | Maestro |
|---|---:|---:|---:|
| 多 provider 并行调用 | 强 | 中到强 | 中 |
| coding agent 控制中心 | 弱 | 强 | 中 |
| 完整开发流程 | 弱 | 中 | 强 |
| Docker/VM/远程 backend | 弱 | 强 | 弱到中 |
| 角色化专家协作 | 弱 | 中 | 强 |
| worktree/代码隔离 | 有限 | backend 相关 | 未明确完整支持 |
| 任务 DAG | 有限 | 未明确完整支持 | 工作流式 |
| 持久化恢复 | 有限 | 强 | 强 |
| token 成本优化 | 基础 | 未明确 | 未明确 |
| CPU/GPU 动态调度 | 未实现 | 未明确 | 未明确 |
| 适合直接作为 MultiAgentOS 核心 | 底层调度 | 执行平台 | 上层流程 |

## 三者组合为 MultiAgentOS 的建议

不要直接复制其中一个项目，更合理的是组合三者：

```text
OpenHands Agent Canvas
    = 执行环境、远程 backend、Docker/VM、控制中心

MCO
    = 多 provider 调用、并行 dispatch、权限确认、结果留存

Maestro
    = 任务分类、专家角色、阶段流程、质量门、session 恢复

MultiAgentOS 自己补充
    = DAG 调度、worktree、契约、冲突管理、token 优化、资源监控
```

这三个项目已经证明“多 coding agent 协作”可行，但都没有完整解决以下五个核心目标：

1. 自动安全地决定哪些任务可以并行。
2. 防止前后端和多个 worker 产生代码冲突。
3. 让协调 token 低于人工多窗口方案。
4. 让总完成时间稳定下降。
5. 在上下文过长、API 限流或进程失败时自动恢复。

这正是 MultiAgentOS 最有价值、但也最难形成差异化的部分。
