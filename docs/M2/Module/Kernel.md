# MultiAgentOS M2 Kernel（外部视角）

> 状态：草稿（阶段 1）。

## 1. 目的与范围

本文从 Workflow 与 UserInteraction 的视角说明 M2 Kernel 提供的能力：可以发起的请求、Kernel 返回的信息、Unit 清单、授权、额度与结束方式。
内部交互见 [Kernel/Interaction](../Kernel/Interaction.md)，字段见 [Interface](../Interface/README.md)，长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md)。

## 2. 运行边界（阶段 1）

| 维度 | 边界 |
|---|---|
| 运行组织 | 本地、单用户、单进程；进程绑定一个仓库；同一时刻打开一个 Session，Session 中的运行先后进行；同一 `dataDir` 只有一个进程 |
| 业务目标 | Turn-chat：用户与 main 多轮对话，main 只读仓库；`mas run analyze`：M1 的只读分析 |
| 执行 | 同一轮可提出多个工具调用，按 FIFO 串行执行（阶段 4 起按并发类别并行） |
| 只读约束 | 不修改被分析仓库，不执行项目命令，不调用 git（阶段 2、3 起分别开放写入、命令与只读 git） |
| 人类参与 | 开放输入（每条用户消息）与授权询问；阶段 5 起增加暂停、中止与局部询问 |
| 资源 | 运行、Turn 两级额度；每个 AgentRun 的工具次数与墙钟上限；额度不触发 Kernel 收敛 |
| 产物 | 工具结果的预览长期保留，完整输出与 ContextPack 7 天后回收；只有 ACTIVE 的 Session 的登记能让正文免于回收 |

## 3. 术语

| 术语 | 定义 |
|---|---|
| Session、Turn、开放输入 | 见 [M2Design](../M2Design.md) 第 2.1 节 |
| 运行状态 | RUNNING、AWAITING_INPUT、CONVERGING、CLOSED；阶段 5 增加 PAUSING、PAUSED、INTERRUPTING |
| `BudgetView` | AgentRun、Turn、运行三级账本各自的状态：NORMAL、WRAP_UP、EXHAUSTED |
| 受保护 Unit、Lease、准入封锁 | 与 M1 相同（归档的 [M1 Kernel（外部视角）](../../History/M1/Module/Kernel.md) 第 3 节）；阶段 2 起 Lease 的含义见 M2Design 第 5.1 节 |

控制语义（Syscall、Event、Interruption、Exception）与 M1 第 3.1 节相同。

## 4. 请求与事件

| 方向 | 定义 |
|---|---|
| Workflow 的 syscall 与 Session 命令的回复 | [Interface/WorkflowKernel](../Interface/WorkflowKernel.md) 第 2 节 |
| 发给 Workflow 的运行级、Session 级与系统级事件 | 同上，第 3 节 |
| UserInteraction 的请求 | [Interface/InteractionKernel](../Interface/InteractionKernel.md) 第 2 节 |
| 发给 UserInteraction 的运行级、Session 级与系统级事件 | 同上，第 3 节 |

各请求在不同运行状态下的处理见 [Kernel/Interaction](../Kernel/Interaction.md) 第 6.5 节。投递语义与 M1 相同：
每个序列按 `seq` 顺序投递，按 `eventId` 去重；`RunClosed`、`RunFinished` 是该运行发给接收方的最后一个事件，`SessionClosed`（失败时为 `SessionFailed`）是该 Session 序列的最后一个；
系统级事件（Session 列表、删除未打开的 Session）不属于任何 Session，按进程编号。

## 5. Unit（阶段 1）

| Unit | executionKind | 受保护能力 | 由谁执行 |
|---|---|---|---|
| `repository-orient`、`repository-search`、`file-read` | M1 原样 | `repo.read` | Supervisor（Executor） |
| `repository-list` | `REPOSITORY_LIST` | `repo.read` | Supervisor（Executor） |
| `context-assemble`、`model-call` | M1 原样 | — | Supervisor（Executor） |
| `report-publish`（`analyze`） | `REPORT_PUBLISH` | — | Execution（内建） |
| `message-publish` | `MESSAGE_PUBLISH` | — | Execution（内建） |

## 6. 授权（阶段 1）

| 能力 | 何时询问 | 结果 |
|---|---|---|
| `repo.read` | 运行开启后第一次需要时；同意后本运行内有效 | 拒绝在本运行内保留；超时只拒绝本次 |
| `project.instructions` | `readProjectFile('AGENTS.md')` 读到未被信任的内容时 | 信任记录跨 Session 有效，只决定 `AGENTS.md` 能否进入 system 段，不产生执行权限 |

授权只由 Kernel 在准入或读取项目文件时被动发起；Workflow 的人类请求与 UserInteraction 的回答都不产生授权（M2Design 第 4.1 节）。

## 7. 额度

- Workflow 只从 `UnitReport.budget`（`BudgetView`）得知额度状态，不持有 token 数值。
- AgentRun 级或 Turn 级为 WRAP_UP：该 AgentRun 进入最后一轮；运行级为 WRAP_UP（按本 Turn 结束时的余额判定，[Monitor](../Kernel/Monitor.md) 第 3.1 节）：
  本 Turn 的回复发布后由 Workflow `closeRun(BUDGET)`，用户确认后对当前 Session 再次 `openSession`，在同一 Session 中开启新的运行。
- `QUOTA_EXHAUSTED`：工具次数或墙钟触顶，该 AgentRun 后续的非收尾 Unit 被拒绝，进入收尾。
- 额度到达限制时 Kernel 只拒绝预留，不收敛运行；正常的额度触顶一律留下可交付的结果（M2Design 第 7.3 节）。

## 8. 结束方式

| closeReason | 发起方 | 用户看到的内容 |
|---|---|---|
| `COMPLETED` | Workflow | 运行结果（`analyze` 为报告）；Turn-chat 的回复已逐条发布 |
| `BUDGET` | Workflow | 回复或运行结果，注明因额度结束；Turn-chat 中提示是否在同一 Session 中继续 |
| `FAILED` | Workflow 或 Kernel | 失败说明（按原因码的文案） |
| `ENDED_BY_USER`、`SHUTDOWN` | Kernel | 无单独说明 |
| `VIOLATION` | Kernel | 安全违规说明 |
| `CANCELLED`、`TIMEOUT` | Workflow（阶段 5） | 中止或超时说明 |

`unknownEffects` 不为空时附"部分操作无法确认是否完成"（M1 原样）。

## 9. 原因码与 Workflow 的处理

M1 的原因码及其处理（M1 第 10 节）保留。阶段 1 新增：

| 原因码 | 出现位置 | Workflow 的处理 |
|---|---|---|
| `AGENT_RUN_ACTIVE`（`requestHuman`） | SyscallRejected | 内部错误：Workflow 只在静止时请求开放输入 |
| `NO_OPEN_TURN` | SyscallRejected | 内部错误 |
| `QUOTA_EXHAUSTED` | UnitReport | 进入收尾，`wrapUpReason` 为触顶项 |
| `LIMIT_EXCEEDED`（普通调用的 `context-assemble`） | UnitReport | 上下文超出窗口：进入收尾，main 的回复提示 `/new`（阶段 8 起由压缩避免，M2Design 第 9.3 节） |
| `ARTIFACT_EXPIRED` | UnitReport、`readArtifact` 的拒绝 | 正文已按保留期回收；Workflow 从不引用 `fullRef`，出现即内部错误 |

阶段 8 增加 `CONTEXT_COMPACTED`、`CONTEXT_OVERFLOW`（处理见 [Workflow](Workflow.md) 第 8.4 节）与 `COMPACTION_UNKNOWN`。

## 10. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 2–9 节 |
| 2 | 两步授权、写入 Unit、回退与差异、Fork |
| 3 | 命令与只读 git 的 Unit、沙盒、停机 |
| 4 | 多个 ACTIVE 的 AgentRun、委派、并行执行 |
| 5 | 暂停、中止、局部询问、`CANCELLED`、`TIMEOUT` |
| 6 | 网页 Unit |
| 8 | 上下文压缩：检查点、材料查询与写回确认、`/compact`（M2Design 第 9.6 节） |
