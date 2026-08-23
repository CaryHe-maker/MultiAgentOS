# MultiAgentOS

MultiAgentOS 是一个面向全栈开发的 coding agent：用户只需描述目标，系统负责把目标拆成可验证的任务图，按依赖关系并行调用多个 coding agent/API，在隔离的工作区中执行，并通过契约、测试和人工审批完成集成。

它不是简单地“打开多个聊天窗口”。核心目标是让并行工作可控、可恢复、可审计，同时尽量减少重复上下文和协调 token。

## 可行性结论

项目在工程上可实现，建议分阶段落地：

1. **MVP**：单机 CLI + Python 调度器 + `asyncio` 并发 + Git worktree + LiteLLM + SQLite。先支持“规划 → 后端/前端并行 → 集成测试”。
2. **Beta**：引入 LangGraph/Temporal 风格的持久化 DAG、Redis/Postgres、Docker 沙箱、OpenTelemetry、预算与速率控制。
3. **Production**：多租户权限、远程 worker、故障恢复、策略引擎、gVisor/Firecracker 隔离、可观测性和评测集。

开源项目已经分别验证了这条路线：MCO 验证了 CLI-first 的多 provider 并行与显式确认；Pane 验证了 worktree/终端会话管理；multi-agent-shogun 验证了层级式 manager-worker；Maestro 验证了分阶段工作流、持久状态和质量门；LangGraph 与 Temporal 验证了长任务的状态持久化和恢复；LiteLLM 验证了多模型统一网关。**但没有证据表明“并行必然比单 agent 更省 token”**，因此 MultiAgentOS 必须内置 token/延迟/质量基准，并根据收益动态决定是否并行。

## 解决的问题

- **安全性**：最小权限、工作区白名单、容器/沙箱、命令审批、密钥隔离、完整审计日志。
- **并行冲突**：任务 DAG、文件/模块 ownership、每个 worker 独立 worktree、结构化接口契约、合并前测试和冲突回退。
- **token 成本**：只传任务卡、接口契约、摘要和 diff；不广播完整对话；设置每任务 token/美元预算；按任务路由模型。
- **完成速度**：只有无依赖节点并行；集成节点在前置任务完成后自动触发；失败任务可重试或降级为串行。
- **上下文过长**：短期上下文、持久化摘要、文件索引和按需检索；每个阶段可新建会话而不丢失结构化状态。
- **资源堵塞**：监控 CPU、内存、GPU、队列、API 延迟和速率限制；根据资源和预算动态限流。

## 典型流程

```text
用户目标
  ↓
Planner：生成架构、接口契约、任务 DAG、预算
  ↓
Scheduler：按依赖和资源选择并行度
  ├─ Backend worker（独立 worktree/容器）
  ├─ Frontend worker（独立 worktree/容器）
  └─ Contract/Test worker（只读或低权限）
  ↓
Artifact Bus：传递契约、摘要、diff、测试报告
  ↓
Integrator：合并、解决冲突、运行端到端测试
  ↓
Reviewer + Human Gate：高风险操作需批准
  ↓
交付 PR/补丁/报告
```

## 当前文档

- [初始设计方案](docs/InitialPlan.md)：架构、技术栈、阶段计划和借鉴项目。
- [难点与实现路径](docs/Difficulty.md)：安全、冲突、token、恢复和性能方面的风险与验证方法。

## 设计原则

1. **Planner 不直接修改代码**：规划结果先落为版本化的 `TaskCard`、`Contract` 和 `Policy`。
2. **默认隔离，显式共享**：worker 默认只能看到自己的 worktree；共享内容通过 artifact 引用传递。
3. **数据优先于自然语言**：跨 agent 通信使用 JSON Schema/Pydantic 对象，文本仅用于解释。
4. **可恢复而非一次性脚本**：每个节点有输入快照、输出摘要、重试策略和幂等键。
5. **高风险动作必须停下来**：删除、发布、改权限、读取密钥、联网写操作等进入人工审批。
6. **自调用权限集中管理**：只有 Orchestrator 能创建 worker/API 调用；worker 不能递归生成新 agent，所有调用受预算、并发和策略限制。

## 调研依据（访问：2026-08-23）

| 项目 | 可借鉴能力 | 对 MultiAgentOS 的启示 |
|---|---|---|
| [openai/codex](https://github.com/openai/codex) | 本地终端 coding agent | 作为 CLI/会话和权限模型的参考基线 |
| [mco-org/mco](https://github.com/mco-org/mco) | 多 provider 并行、原始答案留存、显式选择与确认 | 不隐式猜测 agent 团队；保留可审计证据 |
| [dcouple/Pane](https://github.com/dcouple/Pane) | worktree、终端 pane、跨会话上下文 | 并行隔离和人机协作 UX |
| [yohey-w/multi-agent-shogun](https://github.com/yohey-w/multi-agent-shogun) | tmux 层级 manager-worker、实时 dashboard | 层级调度可行，但要避免 shell/tmux 强耦合 |
| [josstei/maestro-orchestrate](https://github.com/josstei/maestro-orchestrate) | Express/Standard 分流、39 个 specialist、质量门、持久 session | 采用“短任务快速路径 + 复杂任务标准路径” |
| [OpenHands/OpenHands](https://github.com/All-Hands-AI/OpenHands) | 本地/远程/Docker/VM backend、自动化和 ACP | 执行后端可插拔；默认使用沙箱，避免直接暴露主机 |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | durable execution、HITL、memory、trace | 用状态图表达 DAG、暂停/恢复和人工介入 |
| [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | role-based Crews、event-driven Flows | 角色协作与事件驱动可作为上层 API |
| [temporalio/temporal](https://github.com/temporalio/temporal) | 重试、持久化、故障恢复 | 生产版可替换自研调度器的可靠性底座 |
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | 100+ provider 统一接口、预算、负载均衡、guardrails | 统一 API、成本控制和 provider 故障转移 |
| [microsoft/autogen](https://github.com/microsoft/autogen) | 多 agent 对话模式 | 当前处于 maintenance mode，不作为核心依赖；关注其迁移到 Microsoft Agent Framework 的经验 |

## 非目标（首版）

- 不承诺所有任务都并行；有写冲突或强顺序依赖的任务必须串行。
- 不允许 agent 自行扩大文件系统、网络、云账号或发布权限。
- 不把多个模型的回答简单拼接成“共识”；质量由测试、diff 和 reviewer 决定。

## 下一步

先实现一个可测的纵向切片：`plan` 生成任务图，`run` 并行执行两个 worktree，`integrate` 合并并运行测试，`report` 输出 token、延迟、失败和冲突指标。然后用同一组前后端样例与“手工两个窗口”基线比较，而不是凭感觉判断收益。

## 本地开发（进行中）

当前仓库已具备 Phase 1 的编排内核：稳定的 `TaskCard`/`Plan` schema、DAG 与文件 ownership 校验，以及 SQLite checkpoint。模型调用、worktree runtime 与集成器将在后续模块接入。

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'

maos validate examples/todo-login-plan.json
maos run examples/todo-login-plan.json
maos report <run-id>
pytest
```
