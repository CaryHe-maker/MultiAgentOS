# MultiAgentOS

MultiAgentOS 是一个面向 coding-agent 工作流的本地优先编排内核。它尝试解决的不是“如何多开几个 Agent”，而是如何把多个 Agent 的不确定行为放进一个**可控制、可恢复、可审计**的执行系统。

给定一个软件开发目标，系统最终应能将目标拆成带依赖和验收条件的任务图，让可独立的任务在隔离工作区中并行执行，并保留每一次状态变化、代码改动、测试结果、权限决策和失败恢复的证据。

> 当前仓库仍处于 MVP 内核阶段：已实现结构化 Plan、DAG 与文件所有权校验，以及 SQLite checkpoint。尚未接入 LLM、真实 Worker、Git worktree、Docker 沙盒或代码集成。请以“当前已实现”一节为准，不要把目标架构当作现有功能。

## 为什么需要它

单个 Agent 完成简单任务很直接；任务一旦跨越多个模块、需要多轮工具调用或允许并行，就会出现工程问题：

- 哪些任务可以并行，哪些必须等待前置结果？
- 两个 worker 同时改代码时，如何避免覆盖和冲突？
- 模型、工具、文件和网络操作由谁授权、如何限额？
- worker 崩溃、重复回调、旧结果迟到或用户修改目标时，如何保证状态正确？
- 怎样证明最终结果真的完成，而不是只得到一段自然语言回答？

MultiAgentOS 的答案是：以结构化任务图、隔离执行、可验证 Artifact 和明确的状态边界来管理这些问题；只有收益大于协调成本时才并行。

## 项目理念

1. **工作流优先于自由对话**：Agent 可以提出计划、派生任务或工具调用建议，但系统状态只能由受控工作流推进。
2. **默认隔离，显式共享**：每个 worker 最终应在独立 worktree/sandbox 中工作；跨任务传递契约、Artifact 引用和经验证的结果，而不是完整聊天记录。
3. **数据优先于自然语言**：Plan、TaskCard、事件、权限和结果使用版本化的结构化契约；文本只承担解释作用。
4. **恢复建立在已提交事实之上**：checkpoint 保存任务状态和不可变 Artifact 引用，而不是依赖进程内存。重复消息、失败重试和迟到结果都必须可安全处理。
5. **权限、执行和审计分离**：Agent 无权自行扩大权限；高风险动作需要策略检查和人工批准。
6. **证据优先于共识**：测试、类型检查、契约校验、diff 和审计记录决定完成度，不以多个模型“投票”代替验证。

## 目标架构

完整愿景将领域拆为四个并列模块，并以独立基础设施承载跨模块能力：

```text
用户目标
  ↓
Workflow ── 任务图、依赖、重规划、恢复、验收
  ↓ UnitIntent
Kernel ──── 权限、资源、Lease、调度、执行准入
  ↓ ExecutionPermit
Model / Tool / Sandbox / Context Executor
  ↓ AttemptResult + ArtifactRef
Workflow ── 验收结果，推进、重试、补偿或完成
```

| 模块 | 核心职责 | 不负责 |
|---|---|---|
| Workflow | 用户目标、TaskGraph、任务尝试、并行 Join、重规划、补偿和最终验收 | 直接执行模型、工具或 shell |
| Kernel | 身份、策略、资源、配额、Lease、fencing、sandbox 和执行准入 | 决定任务的业务含义 |
| ContextEngine | 代码/文档检索、版本与 ACL 过滤、ContextPack 组装 | 绕过 Kernel 直接给 Agent 访问数据 |
| AgentToolPool | Agent、模型、工具、Prompt 和 Contract 的版本化定义目录 | 保存运行中的 Agent、会话或密钥 |

基础设施包括 Module Host、Shared Contracts、Persistence Platform、Communication Fabric 和 Artifact Store。它们提供通用能力，但不拥有任务、权限或检索的业务决策。

### 核心对象

| 对象 | 含义 |
|---|---|
| `WorkflowRun` | 一次用户目标的完整运行 |
| `TaskGraph` | 任务及依赖、Join 和版本修订 |
| `ProcessScope` | 目标、预算、权限上限、工作区和取消范围组成的监督边界 |
| `TaskRun` / `TaskAttempt` | 稳定的逻辑任务，以及该任务的一次执行尝试 |
| `AgentRun` | 某个 Agent 的上下文、推理和工具循环 |
| `Unit` / `UnitAttempt` | 一次独立受控的物理操作及其实际执行，例如模型调用、检索或命令运行 |
| `ArtifactRef` | 指向不可变 diff、日志、测试报告、ContextPack 或快照的引用 |

这些对象不是同一个大状态机：Workflow 管理总体流程，Kernel 管理执行准入，TaskAttempt 管理任务重试，UnitAttempt 管理一次物理执行。这样才能让失败、取消和恢复保持可追踪。

## 当前已实现

当前实现是一个可验证的本地编排骨架：

- `Plan` 与 `TaskCard` 的 Pydantic schema；
- 任务 ID、依赖存在性、依赖环和无依赖任务之间文件 ownership 重叠校验；
- 初始 `pending` / `ready` / `blocked` 状态计算；
- 使用 SQLite WAL 的 Run 与任务 checkpoint 持久化；
- `maos validate`、`maos run` 与 `maos report` 命令。

未实现：Planner/LLM 调用、实际 worker 执行、Git worktree、沙盒、权限审批、Artifact Store、集成器、费用与遥测采集。

## 快速开始

需要 Python 3.12 或更高版本。

```bash
cd MultiAgentOS
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'

# 校验一个计划
maos validate examples/todo-login-plan.json

# 创建带 SQLite checkpoint 的运行
maos run examples/todo-login-plan.json

# 查看运行摘要；将 <run-id> 替换为上一命令输出的 ID
maos report <run-id>

# 运行质量检查
pytest
ruff check .
mypy src
```

默认状态数据库为 `.multiagentos/state.db`。可使用 `--database PATH` 指定其他位置。

## 一个 Plan 示例

```json
{
  "goal": "Add login to the Todo application",
  "tasks": [
    {
      "id": "contract.auth",
      "title": "Define the login API contract",
      "role": "contract",
      "owned_paths": ["contracts/**"],
      "acceptance": ["Contract is reviewed"]
    },
    {
      "id": "backend.auth",
      "title": "Implement the login endpoint",
      "role": "backend",
      "owned_paths": ["server/**"],
      "dependencies": ["contract.auth"],
      "acceptance": ["pytest tests/auth"]
    }
  ]
}
```

`role` 只描述任务职责，不授予权限。无依赖任务若声明重叠的 `owned_paths`，验证器会拒绝该 Plan，避免把潜在写冲突伪装成并行任务。

## 演进路线

V1 不追求一次实现企业级 AgentOS，而是逐层验证：

1. **协议与 checkpoint**：完成并稳定 Plan、任务图、ownership 校验和状态持久化。
2. **受控执行**：接入获批 subprocess、Git worktree 和结果采集。
3. **隔离与证据**：加入 sandbox、Artifact Store、审批和测试质量门。
4. **可恢复编排**：接入 durable workflow、结构化事件和恢复/补偿机制。
5. **检索与观测**：增加代码检索、成本/延迟评测和 OpenTelemetry。

每一阶段都应以固定任务集与单 Agent 基线比较质量、墙钟时间、token 成本、冲突率和恢复表现；并行不是默认目标。

## 文档导航

- [MVP 范围](docs/mvp-scope.md)：当前完成标准与明确不做的事。
- [架构](docs/architecture.md)：当前仓库组件边界与实施状态。
- [协议规范](docs/protocols.md)：`Plan`、`TaskCard` 和后续对象的契约约定。
- [开发流程](docs/workflow.md)：运行状态、并行规则和质量门。
- [安全策略](docs/security.md)：权限与审批边界。
- [评测方案](docs/evaluation.md)：如何验证系统是否比单 Agent 更有价值。
- [贡献指南](CONTRIBUTING.md)：协作约定。
- [Agent 开发指南](AGENTS.md)：修改仓库前必须遵守的规则。

## 非目标

- 不保证所有任务并行，也不宣称并行必然更快或更省 token。
- 不允许 Agent 自动发布、删除、修改权限、读取用户密钥或扩大网络/文件系统权限。
- 不以多个模型的自由讨论替代结构化任务契约和质量验证。
- 当前不实现生产多租户、远程 worker、Dashboard 或“通用自主软件公司”。
