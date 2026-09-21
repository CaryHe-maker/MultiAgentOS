# MultiAgentOS M1 / V1 目标设计

> 文档类型：当前首版的规范性目标设计  
> 当前里程碑：M1  
> 产品版本：V1 Agent MVP  
> 达成计划：`docs/DesignReport/M1AchievePlan.md`  
> 长期架构：`docs/DesignReport/TargetArchitecture.md`  
> Workflow 完整目标设计：`docs/DesignReport/WorkflowModuleReport.md`  
> 技术选型：`docs/TechStack.md`

## 1 文档权威与版本定义

本文定义 M1/V1 必须实现的系统边界、模块接口、执行路径和验收标准，是当前开发的范围权威。`TargetArchitecture.md` 和 `WorkflowModuleReport.md` 保存长期设计；其中未被本文明确引用的能力不得进入 M1 完成定义。

本文中的版本关系为：

| 名称 | 含义 |
|---|---|
| M1 / V1 | 当前首版：单 Agent 完成简单真实编码任务 |
| M2 | 持久化、幂等、取消和崩溃恢复 |
| M3 | 静态多任务图、多 Worker 与 Git 结果集成 |
| M4 | Checkpoint、审批、强执行隔离和完整可观测性 |
| M5 | 多租户、远程执行、生产运维和平台化扩展 |

公共契约在 M1 验收结束前使用 `v0/experimental`。只有经过固定任务集验证的字段和语义才能升级为稳定 `v1`。

## 2 M1 的目标

M1 要交付一个真正可以运行的 coding Agent，而不是先交付完整的可靠性平台。用户提交一个简单软件工程目标后，系统能够理解项目、调用模型、执行受控工具、修改隔离 workspace、运行测试并生成结果报告。

典型调用：

```bash
multiagent run --repo ./example --prompt "修复当前失败的计算器测试"
```

目标执行链：

```text
CLI
 |
 v
Workflow ── ContextRequest ──> ContextEngine
 |                               |
 |<──────── ContextPack ─────────+
 |
 +── ModelUnit / ToolUnit ─────> Kernel
 |                               |
 |<──────── UnitResult ──────────+
 |
 +── 下一轮 AgentStep 或完成验收
 |
 v
Git diff + test evidence + final report
```

M1 的核心证明是：同一个 Task 必须完整经过 Workflow、ContextEngine 和 Kernel，三个模块各自保持清晰所有权，同时在一个进程内完成端到端闭环。

## 3 M1 必须实现的能力

### 3.1 产品能力

1. 单用户、单项目、单进程、单 Agent、单活动 Task。
2. 接入一个模型 Provider，支持结构化 AgentAction。
3. Agent 可以请求搜索、读取文件、修改文件、执行允许的命令和运行测试。
4. ContextEngine 能生成仓库文件图、执行文本/符号名称搜索、按 token 预算构造 ContextPack。
5. Kernel 能校验 workspace、路径和命令，执行 ModelUnit 与 ToolUnit，并返回结构化结果。
6. Workflow 能控制 Agent 循环、最大步数、预算、终止条件、失败分类和最终验收。
7. 所有修改发生在隔离 Git worktree，不直接修改用户原始 checkout。
8. 最终输出 Git diff、测试结果、模型调用次数、token/耗时和失败原因。
9. 使用至少 5 个固定小型仓库任务建立首版成功率基线。

### 3.2 M1 非目标

M1 不实现：

- 多 Task 并行、复杂 DAG 或动态 replan；
- 多 Agent 协作、双 Worker 集成和 ChangeSet 合并；
- DBOS、Inbox/Outbox、Lease、fencing 和崩溃后自动续跑；
- WorkflowCheckpoint、SessionCheckpoint 和 RestorePlan；
- 完整 Human Review、多人审批和 Policy Engine；
- Web UI、SSE、多租户、远程 Worker、消息集群；
- MCP、语义向量检索、SCIP、reranker；
- 生产级容器隔离、自动 Artifact GC、备份和灾难恢复。

进程崩溃后允许本次运行失败或由用户重新开始。M1 可以保存步骤日志，但不承诺从中间步骤自动恢复。

## 4 三个模块的职责

三个模块是系统职责边界，不要求把一个简单用户目标人为拆成三个业务任务。同一个 Task 由三个模块协作完成。

| 模块 | M1 所有权 | 明确不负责 |
|---|---|---|
| Workflow | WorkflowRun、TaskRun、AgentRun、AgentStep、循环控制、预算、终止和结果验收 | 文件执行、模型网络调用、仓库检索实现 |
| Kernel | UnitAttempt、模型调用、工具执行、workspace/path/command 准入、超时和审计记录 | Task 依赖、上下文选择、业务完成判断 |
| ContextEngine | RepositorySnapshot、检索、分块、token 裁剪、ContextPack 和 provenance | 修改文件、执行命令、决定任务成功 |

M1 使用模块化单体：三个模块位于同一进程，通过 Port 和共享 Contract 通信，不拆成三个服务，不建立三套数据库，也不引入消息总线。

## 5 最小领域模型

即使 M1 只运行一个 Task，也必须保留未来可扩展的身份层级：

```text
WorkflowRun
  └── TaskRun
       └── TaskAttempt
            └── AgentRun
                 └── AgentStep
                      └── UnitIntent
                           └── UnitAttempt
```

M1 不要求每层都是独立数据库聚合，但日志、Artifact 和接口必须携带相应 ID。

### 5.1 状态机

```text
WorkflowRun / AgentRun:
CREATED -> RUNNING -> SUCCEEDED
                   -> FAILED
                   -> CANCELLED

AgentStep:
CONTEXT -> MODEL -> ACTION -> OBSERVATION
                         \-> FINAL

UnitAttempt:
PENDING -> RUNNING -> SUCCEEDED
                   -> FAILED
                   -> TIMED_OUT
```

### 5.2 TaskGraph 兼容结构

M1 虽然只允许一个 Task，但输入使用可扩展的图结构：

```ts
interface TaskGraph {
  schemaVersion: "v0";
  tasks: TaskDefinition[];
  edges: TaskEdge[];
}
```

M1 校验器要求 `tasks.length === 1` 且 `edges.length === 0`。M3 通过放宽能力校验支持多个 Task，而不是替换输入模型。

## 6 模块契约

### 6.1 Context Port

```ts
interface ContextPort {
  buildContext(request: ContextRequest): Promise<ContextPack>;
}

interface ContextRequest {
  workflowRunId: string;
  taskRunId: string;
  agentRunId: string;
  workspaceRef: string;
  objective: string;
  query?: string;
  previousObservationRefs: ArtifactRef[];
  tokenBudget: number;
}
```

`ContextPack` 必须是不可变输出，至少包含 `contextPackId`、`workspaceRef`、`repositoryRevision`、`items`、`tokenCount` 和 `provenance`。Workflow 不得直接读取 ContextEngine 内部缓存或索引。

### 6.2 Kernel Port

```ts
interface KernelPort {
  execute(intent: UnitIntent): Promise<UnitResult>;
}

interface UnitIntent {
  schemaVersion: "v0";
  unitIntentId: string;
  owner: UnitOwner;
  executionKind: "MODEL" | "FILE_READ" | "FILE_WRITE" | "COMMAND" | "TEST";
  input: unknown;
  outputContractRef: string;
  workspaceRef: string;
  timeoutMs: number;
  idempotencyKey: string;
}
```

Workflow 不得直接调用模型 SDK、文件系统或 shell。M1 的 Port 是进程内调用；M2/M3 可以在不改变调用者语义的前提下替换为 durable 或异步 adapter。

### 6.3 Envelope、Artifact 与错误

所有跨模块请求和结果包含：

```ts
interface Envelope<T> {
  schemaVersion: "v0";
  messageId: string;
  correlationId: string;
  causationId?: string;
  payload: T;
}

interface ArtifactRef {
  artifactId: string;
  mediaType: string;
  sha256: string;
  size: number;
}
```

错误必须结构化为 `VALIDATION`、`POLICY`、`TIMEOUT`、`RESOURCE`、`EXECUTION`、`CONTRACT` 或 `INTERNAL`，并包含 `retryable` 和可选 `diagnosticsRef`。模块边界不得只传递异常字符串。

## 7 M1 Agent 循环

```text
1. Workflow 创建 WorkflowRun、TaskRun、TaskAttempt 和 AgentRun。
2. Workflow 向 ContextEngine 请求初始 ContextPack。
3. Workflow 生成 MODEL UnitIntent，由 Kernel 调用模型。
4. Kernel 校验模型结构化输出并返回 AgentAction。
5. Workflow 根据 AgentAction：
   - 请求 ContextEngine 继续搜索；或
   - 请求 Kernel 读取、修改、执行命令或测试；或
   - 接受 FINAL 提案。
6. Observation 追加到 AgentRun，进入下一 AgentStep。
7. 达到成功、失败、取消、步数或预算上限后终止。
8. Workflow 验证测试证据和 workspace diff，生成最终报告。
```

模型不能直接执行工具。模型输出只是提案，必须经过 Workflow 解释和 Kernel 准入。

## 8 执行与安全边界

M1 可以使用本地 subprocess，但明确不构成生产安全沙箱。至少必须实现：

- 工作目录固定在隔离 worktree；
- 拒绝绝对路径、`..`、symlink/junction 逃逸；
- 命令 allowlist/denylist 和参数长度限制；
- 单次执行超时、输出大小上限和进程树终止；
- 默认禁止外部网络和用户目录访问；
- 最大 AgentStep、模型调用数和 token 预算；
- 不自动 commit、push、merge、部署或发送外部消息；
- 所有模型调用和工具执行生成审计步骤记录。

## 9 工程框架

建议 M1 包结构：

```text
apps/cli/                   CLI 入口和终端展示
packages/contracts/         Envelope、Task、Context、Unit、Artifact、Error schema
packages/workflow/          Run/Task/Agent 状态机、Agent loop、验收和报告
packages/kernel/            准入、Model/Tool adapter、workspace 与 subprocess
packages/context-engine/    repository snapshot、rg、chunk、token budget
packages/artifacts/         本地内容寻址或 run-scoped Artifact
packages/testing/           fakes、contract tests、fixture repositories
```

依赖方向固定为：三个领域模块只依赖 `contracts` 和自己的 Port；`apps/cli` 负责组装 adapter。Workflow 不得导入 Kernel 或 ContextEngine 的内部类。

M1 可以先将运行记录保存在 `.multiagent/runs/<run-id>/`，包括 `run.json`、`steps.jsonl`、`artifacts/`、`final.patch` 和 `report.json`。M2 再将 Repository Port 替换为 PostgreSQL 实现。

## 10 如何保证兼容后续升级

兼容目标不是保证未来零修改，而是让新增能力通过替换 adapter、放宽能力限制或增加版本完成，避免推翻 M1 主循环。

### 10.1 兼容规则

1. **模块化单体**：先保留代码和所有权边界，不提前服务化。
2. **Contract-first**：跨模块只使用 `packages/contracts` 中的运行时校验对象。
3. **稳定身份层级**：从 M1 起保留 run/task/attempt/agent/step/unit ID。
4. **不可变输出**：ContextPack、UnitIntent、UnitResult 和 Artifact 发布后不原地修改。
5. **Port/Adapter**：模型、工具、存储、检索和执行器都通过 Port 替换。
6. **能力协商**：M1 用 capability validator 拒绝多任务，而不是删除图字段。
7. **版本化 schema**：破坏性变化创建新 schemaVersion 和显式迁移，不静默改变含义。
8. **结构化错误**：未来 retry、审批和恢复依据错误类别，而不是解析日志文本。
9. **Contract tests**：每个 Port 同时提供 fake 和共享测试套件，所有 adapter 必须通过。
10. **真实任务验证后冻结**：M1 完成前允许修正抽象，避免把未经验证的设计永久化。

### 10.2 后续能力如何接入

| 后续能力 | 基于 M1 的扩展方式 |
|---|---|
| PostgreSQL | 替换 RunRepository/Artifact metadata adapter |
| DBOS | 包装 Workflow loop；外部动作仍保持 UnitIntent 边界 |
| 多 Task | 放宽 TaskGraph validator，增加 readiness 和 Join |
| 多 Agent | 一个或多个 TaskAttempt 创建多个 AgentRun |
| retry/cancel | 创建新的 Attempt，并扩展现有状态机 |
| 消息队列 | 将本地 Port adapter 换成异步 transport，复用 Envelope |
| 容器/远程执行 | 替换 Kernel Executor adapter |
| 语义检索 | 替换 ContextEngine retrieval pipeline，保持 ContextPack |
| 审批 | 在 Kernel 执行 UnitIntent 前插入 Review Gate |
| Checkpoint | 保存既有状态与 Artifact 引用，不发明第二套运行对象 |

## 11 M1 验收

### 11.1 固定任务类型

至少包含以下任务，不能只使用“修改已知文件中的常量”一类绕过 ContextEngine 的用例：

1. 根据失败测试，在未知文件中定位并修复一个逻辑错误。
2. 跨两个相关文件修复调用约定不一致。
3. 新增一个小功能，同时修改实现和测试。
4. 面对无关搜索结果，重新查询并找到正确实现。
5. 测试失败后读取 Observation、再次修改并通过测试。

### 11.2 完成定义

M1 完成必须同时满足：

1. 一个真实模型在固定任务集上完成至少一种简单编码任务。
2. 每个任务完整经过 Workflow、ContextEngine 和 Kernel。
3. Workflow 可限制步数、token 和时间，并能确定成功或失败。
4. ContextPack 具有来源、repository revision 和 token 统计。
5. 所有模型和工具副作用通过 Kernel Unit 执行。
6. 原始 checkout 不被修改，最终结果以 diff 和测试证据交付。
7. 三个模块分别有 fake、contract test 和至少一个集成测试。
8. 报告包含步骤、工具调用、模型用量、测试、diff、耗时和失败分类。

## 12 后续里程碑

### M2：持久化与基础可靠性

- PostgreSQL Repository、migration 和领域事务。
- DBOS 包装 Agent/Workflow loop。
- 幂等命令、有限 retry、cancel 和进程重启恢复。
- 最小 Inbox/Outbox 或经 ADR 证明的 DBOS 原生替代方案。
- Artifact CAS、运行审计和故障注入。
- 明确 DBOS retry、Kernel retry 和 Workflow retry 的唯一责任。

### M3：多任务与并行执行

- 静态 TaskGraph、多 Task、依赖和 `ALL` Join。
- 多 Worker/AgentRun 调度和并发上限。
- Lease、heartbeat、fencing 和迟到结果处理。
- 每个 Worker 独立 worktree。
- ChangeSet、确定性 IntegrationPlan、干净集成 workspace 和 QualityGate。
- 单 Agent 与多 Agent 的质量、成本、延迟和冲突基线。

### M4：长期恢复、安全与人类控制

- WorkflowCheckpoint 与用户可见 SessionCheckpoint。
- RestorePlan、跨模块恢复参与者和长期 Artifact retention。
- 单人 APPROVAL，再按需求扩展 INFORMATION/DECISION/ACCEPTANCE。
- rootless container 或远程 Sandbox、网络策略和 Secret 管理。
- OpenTelemetry、正式安全测试、备份恢复和性能基线。

### M5：平台化与生产能力

- 多租户、OIDC/RLS、配额、公平性和成本治理。
- 远程 Worker、多 Control Plane 和独立消息基础设施。
- S3-compatible Artifact Store、完整 GC、PITR 和灾难恢复。
- Web UI、SSE、组织级审核、供应链和发布治理。
- 根据实测数据评估 Restate/Temporal、NATS、gVisor 或 microVM。

每个里程碑必须以前一里程碑的固定任务集和回归测试为基础。不得为实现后续平台能力破坏 M1 的单 Agent 基本闭环。
