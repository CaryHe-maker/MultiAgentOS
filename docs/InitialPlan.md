# MultiAgentOS 初始设计方案

## 1. 目标与边界

MultiAgentOS 的最小承诺是：给定一个全栈目标，能够生成可审计的任务图，安全地并行运行多个 coding agent，并在契约和测试通过后集成结果。并行是调度策略，不是对每个请求的硬编码行为。

### 成功标准（MVP）

- 对一个前后端示例项目，自动生成 API 契约和至少两个互不阻塞的任务。
- backend/frontend worker 使用独立 Git worktree；同一文件默认不能被两个 worker 写入。
- worker 之间只传结构化任务卡、契约、摘要、diff 和测试报告。
- 任意节点失败、超时或进程重启后可从最近检查点恢复。
- 高风险命令进入审批队列；所有调用有 trace、成本和审计记录。
- 与“用户手工打开两个窗口”的基线相比，报告总 token、墙钟时间、返工次数和测试通过率；不预设并行一定更省 token。

## 2. 总体架构

```text
CLI/Web UI
   │
API Gateway / Auth / Policy
   │
Orchestrator（Planner + DAG Scheduler + Budget Manager）
   ├── State Store（SQLite → Postgres）
   ├── Event Bus（asyncio → Redis Streams/NATS）
   ├── Artifact Store（本地 blob → S3/MinIO）
   ├── Worker Runtime（subprocess → Docker/Podman → VM）
   ├── LLM Gateway（LiteLLM）
   └── Observability（OpenTelemetry + Prometheus/Grafana）
```

### 核心对象

- `Run`：一次用户目标执行，含全局预算、策略和状态。
- `TaskCard`：`id/title/role/inputs/owned_paths/dependencies/acceptance/budget/retry_policy`。
- `Contract`：OpenAPI/JSON Schema/事件 schema、版本和兼容性规则。
- `Artifact`：摘要、文件快照、diff、测试报告或日志；大对象只传引用和 hash。
- `Policy`：允许的路径、命令、网络域名、最大并发、需要人工批准的动作。
- `Checkpoint`：节点输入快照、provider/model、token 用量、输出 artifact 和状态。

## 3. 任务生命周期

1. **收集与澄清**：解析用户目标；只有会改变架构或权限的缺失信息才请求用户确认。
2. **规划**：Planner 生成架构摘要、接口契约、DAG、文件 ownership、验收条件和预算。
3. **静态检查**：Schema 校验、依赖无环检查、ownership 重叠检查、策略检查。
4. **调度**：Scheduler 只释放入度为零且资源可用的节点；根据预计收益决定并行或串行。
5. **执行**：每个 worker 在隔离 worktree/容器中运行；工具调用经过 Policy Engine。
6. **汇报**：worker 返回结构化结果（状态、摘要、diff、测试、阻塞原因），不是整段聊天记录。
7. **集成**：Integrator 按顺序 rebase/cherry-pick；遇到重叠或测试失败，创建冲突修复任务，必要时请求人工介入。
8. **质量门**：运行 lint、类型检查、单测、契约测试、端到端测试和安全扫描。
9. **交付**：输出变更摘要、证据链接、成本/时间指标和未解决风险。

## 4. 并行与通信设计

### 并行规则

- 无依赖且 `owned_paths` 不重叠的节点可以并行。
- 共享接口先由 Contract 节点产出；实现节点读取契约版本，不共享 Planner 全上下文。
- 生成/迁移数据库、锁文件、全局配置等高冲突资源默认串行。
- 资源阈值、provider 限流、预算不足或失败率过高时自动降低并发度。

### 通信格式

使用 Pydantic 模型和 JSON Schema；典型消息只包含：

```json
{
  "task_id": "backend.auth",
  "contract_refs": ["artifact://contracts/openapi@sha256:..."],
  "owned_paths": ["server/**"],
  "acceptance": ["pytest tests/auth", "openapi-compat"],
  "context_summary": "实现 JWT 登录，不改数据库迁移",
  "budget": {"max_input_tokens": 8000, "max_output_tokens": 12000}
}
```

### 上下文压缩

- 会话分层：短期对话、任务摘要、项目事实库、长期偏好。
- 每个 checkpoint 记录“已知事实/决策/未决问题/证据”，新会话按需检索。
- 只传相关文件片段和 diff；大日志先本地聚合，失败时再展开。
- 以 hash 去重相同契约和文件内容；达到阈值时自动新建会话。

## 5. 安全设计

1. **权限**：每个 worker 使用短期身份和最小权限；默认无云凭据、无主机 secrets、无任意网络。
   Orchestrator 的“自我调用多个 API”权限是一个受策略控制的能力，不是给每个 worker 的无限递归权限；worker 只能请求已声明的后续任务。
2. **文件系统**：项目目录白名单；worktree 映射为只允许的子目录；禁止访问 `.ssh`、凭据目录和工作区外路径。
3. **执行隔离**：MVP 可用受限 subprocess；Beta 使用 Docker/Podman；高风险环境使用 rootless、seccomp、cap-drop、只读根文件系统，必要时 gVisor/Firecracker。
4. **命令策略**：命令 allowlist/denylist、超时、资源配额、输出截断；删除、发布、权限变更和联网写操作需要人工批准。
5. **模型与数据**：API key 存本地密钥环或 secret manager；日志脱敏；默认不把整个仓库发送给 provider。
6. **供应链**：锁定依赖和镜像 digest；工具/MCP server 需显式信任；执行前记录版本和 hash。
7. **审计**：保存 prompt hash、provider、模型、工具调用、文件 diff、审批者和最终状态；日志 append-only。

## 6. 推荐技术栈

### MVP

- Python 3.12、`asyncio`、Typer、Rich、Pydantic v2、FastAPI。
- 自研轻量 DAG scheduler（便于验证调度策略），SQLite/WAL 保存状态。
- Git CLI + worktree；subprocess worker。
- LiteLLM 作为统一 provider 适配层；支持 OpenAI、Anthropic、Gemini 等。
- `psutil` 监控 CPU/内存/进程；`pynvml` 可选监控 NVIDIA GPU。
- pytest、Ruff、mypy、OpenTelemetry SDK。

### Beta/Production

- LangGraph 风格的状态图或 Temporal 作为 durable workflow 底座。
- Postgres（状态/审计）+ Redis Streams 或 NATS（事件）+ MinIO/S3（artifact）。
- Docker/Podman rootless，按风险选择 gVisor/Firecracker；远程 worker 使用 mTLS。
- Prometheus/Grafana + OpenTelemetry；可选 LangSmith/Jaeger 做轨迹分析。
- React/Next.js dashboard；CLI 保持一等公民。

## 7. 阶段计划

### Phase 0：实验基线

建立 5–10 个固定全栈任务，记录单 agent、手工双窗口和 MultiAgentOS 的 token、墙钟时间、返工和测试结果。

### Phase 1：纵向 MVP

实现 `plan/run/integrate/report`、TaskCard/Contract、worktree 隔离、LiteLLM、SQLite checkpoint 和审批 CLI。

### Phase 2：可靠性与安全

加入 Docker 沙箱、策略引擎、重试/超时/取消、资源监控、结构化日志和端到端测试。

### Phase 3：可扩展平台

加入 Postgres/Redis、远程 worker、Temporal/LangGraph durable execution、Web dashboard、模型路由和多项目并发。

## 8. 借鉴项目与取舍

- **Codex CLI**：借鉴本地 coding agent 的终端体验和会话边界，不复制其内部实现。
- **MCO**：借鉴显式 provider 选择、并行 dispatch、原始结果留存和确认机制。
- **Pane**：借鉴 worktree 生命周期和跨终端协作；MultiAgentOS 将其抽象为 runtime 接口。
- **multi-agent-shogun**：借鉴 manager/worker 层级和实时状态；不把 tmux 作为唯一运行时。
- **Maestro**：借鉴快速路径/标准路径、专家角色、质量门和持久 session。
- **OpenHands Agent Canvas**：借鉴多 backend、Docker/VM 和 ACP 适配；明确默认沙箱。
- **LangGraph/CrewAI**：分别借鉴低层状态图和高层角色/事件 API；核心协议仍保持自有 TaskCard/Artifact schema。
- **Temporal**：当需要跨机器、长时间运行和强恢复保证时采用，而不是在 MVP 一开始引入完整服务集群。
- **LiteLLM**：统一模型调用、预算、重试和负载均衡；敏感数据策略由 MultiAgentOS 自己控制。
- **AutoGen**：仅作为历史设计参考；其仓库已标明 maintenance mode，新代码不以它为核心依赖。

## 9. 验收与评测

每次 run 输出：总/分任务 input-output token、估算费用、墙钟时间、排队时间、并发峰值、冲突次数、重试次数、测试通过率、人工介入次数和安全拒绝次数。只有在固定任务集上同时改善质量与时间，且 token 增幅可接受时，才扩大并行度。
