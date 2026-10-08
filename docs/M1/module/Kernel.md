# MultiAgentOS M1 Kernel（外部视角）

## 1. 目的与范围

本文从 Workflow 与 UserInteraction 的视角说明 M1 Kernel 提供的能力，包括：

- 外部模块可以发起的 syscall 与请求，以及 Kernel 返回的信息；
- M1 的 Unit 清单、授权询问、额度状态、原因码与结束方式。

Kernel 内部组件的职责与交互见 [kernel/Interaction](../kernel/Interaction.md)，长期规划见
[Kernel 架构](../../Architecture/module/Kernel.md)。字段级接口见 [M1Interface](../M1Interface.md) §5。

## 2. 运行边界

M1 Kernel 采用最小可行子集：Gateway、Core、Scheduler、Execution、Supervisor、Monitor 均承担真实职责，
共同完成一条受控的串行执行闭环，不以空接口代替核心行为。

| 维度 | M1 边界 |
|---|---|
| 运行组织 | 本地、单用户、单项目、单进程、单活动 Task；Planner 与 CodeViewer 通过单向 handoff 串行交接 |
| 业务目标 | 只读仓库分析，支持模型、仓库概览、搜索、文件读取、上下文组装与报告发布所需的执行能力 |
| 执行顺序 | 同轮可提出多个工具调用，所有 Unit 不区分是否涉及 API，统一按 FIFO 串行执行；不引入并行 Agent 调度 |
| 信任边界 | 仅开放可信内置模块和 Executor，不加载任意不可信执行代码 |
| 只读约束 | 不修改被分析仓库，不执行项目命令或项目测试 |
| 必要系统操作 | 允许受控的系统状态、Artifact、审计写入，以及获准的模型 API 请求 |
| 资源限制 | token 额度按 WorkflowRun 计，Planner 与 CodeViewer 共用；运行总时长设上限 |
| 控制能力 | 支持取消、停止和最终收敛；不提供暂停/恢复与崩溃续跑 |
| 用户交互 | 单次目标输入与最终输出；运行中支持终止和必要授权，访问仓库前收集一次 Y/N |

系统自身写入与被分析仓库写入必须明确区分；模型 API 访问不构成任意网络访问权限。
两个 Agent 均属于 M1 交付，Kernel 支持其执行归属与资源交接，业务 handoff 由 Workflow 管理。

## 3. 术语

| 术语 | 定义 |
|---|---|
| 受保护 Unit | Unit 定义中声明了受保护能力（M1 为 `repo.read`）的 Unit，需要 Lease |
| 非受保护 Unit | 未声明受保护能力的 Unit，依据开发者授权执行，无需 Lease |
| Lease | Core 私有的运行时授权记录，只存在于 Core |
| 用户授权记录 | Core 保留的用户同意或拒绝结果 |
| 额度 | 一次 WorkflowRun 可消耗的 token 上限，账本归 Monitor |
| budgetState | 额度状态：NORMAL、WRAP_UP（应收尾）、EXHAUSTED（不再允许 model-call）；只能前进 |
| 准入封锁 | Core 对某个 WorkflowRun 设置的禁止准入状态，由 Gateway 检查，设置后不解除 |

Round、final-call 等 Workflow 概念见 [Workflow](Workflow.md)；runEpoch、终止信号等 Kernel 内部概念见
[kernel/Interaction](../kernel/Interaction.md)。

## 4. syscall 与请求

外部 syscall 指 Workflow、UserInteraction 经 Gateway 向 Core 发起的请求。
外部模块申请受保护系统服务、执行能力或提交 Kernel 控制请求时，以 Gateway 为唯一入口。

### 4.1 Workflow 的 syscall

| syscall | 何时调用 | 主要参数 | Kernel 的回应 | 准入封锁期间 |
|---|---|---|---|---|
| `registerAgentRun` | 创建 AgentRun 时（运行开始、HANDOFF 之后） | `workflowRunId, agentRunId, agentRef@digest, requestId` | SyscallAck | 拒绝 |
| `submitUnit` | 提交每个 unitIntent | `workflowRunId, agentRunId, unitRef, input, requestId` | 受理时 SyscallAck，最终 UnitReport | 拒绝 |
| `endAgentRun` | HANDOFF 或报告发布之后 | `agentRunId, requestId` | SyscallAck | 允许 |
| `closeRun` | 报告发布之后，或 Workflow 自身无法继续 | `workflowRunId, outcome: COMPLETED \| FAILED, reportRef?, requestId` | SyscallAck，收敛完成后 RunClosed | 允许 |

4 种 syscall 均以 `requestId` 幂等：重复提交返回同一结果；相同 `requestId` 但内容不同按冲突处理。

### 4.2 UserInteraction 的请求

| 请求 | 用途 | 准入封锁期间 |
|---|---|---|
| 创建运行 | 提交用户目标与仓库路径，返回 Gateway 生成的 `workflowRunId` | — |
| 授权回答 | 回答 Core 发起的 Y/N 询问 | 允许 |
| 取消 | 用户终止运行（Interruption） | 允许 |
| 读取产物 | 按 ArtifactRef 读取本运行的产物（如最终报告） | 允许 |
| 关闭系统 | 结果展示完成后请求关闭 | 允许 |

取消、授权回答与关闭系统属于控制类请求，Kernel 优先于业务请求处理
（见 [kernel/Interaction](../kernel/Interaction.md) 3.2）。

### 4.3 Kernel 返回给 Workflow 的信息

Kernel 用两种方式回应外部模块：syscall 的直接返回值，以及投递到接收方 Inbox 的事件（第 4.5 节）。

| 信息 | 方式 | 发出者 | 何时发出 | 内容 |
|---|---|---|---|---|
| SyscallAck | 返回值 | Core | `registerAgentRun`、`endAgentRun` 处理完成；`submitUnit`、`closeRun` 被受理 | 是否受理 |
| AdmissionException | 返回值 | Gateway | 任一 syscall 在准入被拒 | 拒绝原因 |
| RunStart | 事件 | Core | 用户创建运行后 | `workflowRunId`、用户目标 |
| UnitReport | 事件 | Core | 每个被受理的 `submitUnit` 的最终结果 | 状态（OK / REJECTED / FAILED）、原因码、输出或 Artifact 引用、budgetState |
| RunClosed | 事件 | Core | `closeRun` 收敛完成；或超时、取消、违规导致停止 | 结束来源、控制终态、用量摘要、未知效果 |

规则：

1. 被 Gateway 受理的 `submitUnit`，要么恰好收到一个 UnitReport，要么随 RunClosed 结束。
2. 被 Gateway 拒绝的 syscall 只收到 AdmissionException。
3. 一个 WorkflowRun 恰好收到一个 RunClosed，收到后 Workflow 不再等待任何 UnitReport。
4. Workflow 按 `requestId` 对应结果，不依赖到达顺序；一轮的 UnitReport 全部收齐后才进入下一轮。
5. UnitReport 只携带 budgetState，不携带额度数值。Workflow 在 M1 中不读取 token 数。

### 4.4 Kernel 发给 UserInteraction 的事件

| 事件 | 何时发出 | 内容 |
|---|---|---|
| AuthorizationRequest | 第一个受保护 Unit 到达权限检查且尚无授权时 | `questionId`、仓库路径、排除规则、外发目标 provider、回答期限 |
| RunFinished | RunClosed 发出时 | 结束来源、`reportRef`（正常结束时）、未知效果 |

### 4.5 Inbox 投递

Workflow 与 UserInteraction 各自提供一个 Inbox，由组合根注入 Kernel；Kernel 只依赖 contracts 中定义的
Inbox 接口，不依赖 Workflow 或 UserInteraction 的实现。投递语义参照 io_uring 完成队列与 Actor 邮箱：

1. **单一出口**：所有事件由 Core 的 Outbox 发出；Execution、Monitor 等组件不直接向外部模块发送。
2. **有序**：每个 WorkflowRun、每个接收方有从 1 递增的 `seq`，Outbox 按 `seq` 顺序投递。
3. **可去重**：每个事件有唯一 `eventId`，接收方按 `eventId` 去重。
4. **受理语义**：投递返回只表示事件已进入接收方 Inbox，不表示已经处理。
5. **终结**：RunClosed（对 UserInteraction 为 RunFinished）是该运行发给该接收方的最后一个事件；
   之前入队的 UnitReport 都先于它投递。
6. **串行消费**：接收方按 Inbox 顺序逐条处理事件，不并发处理同一运行的事件。

字段级定义见 [M1Interface](../M1Interface.md) 第 4、5 节。

## 5. M1 的 Unit

| Unit | executionKind | 受保护 | 暴露给模型 | 消耗 token | 计入 Round |
|---|---|---|---|---|---|
| repository-orient | `REPOSITORY_ORIENT` | 是（`repo.read`） | 否（CodeViewer 的 startUnit） | 否 | 否 |
| repository-search | `REPOSITORY_SEARCH` | 是（`repo.read`） | 是 | 否 | 否 |
| file-read | `FILE_READ` | 是（`repo.read`） | 是 | 否 | 否 |
| context-assemble | `CONTEXT_ASSEMBLE` | 否 | 否 | 否 | 否 |
| model-call | `MODEL` | 否 | 否 | 是 | 是 |
| report-publish | `REPORT_PUBLISH` | 否 | 否 | 否 | 否 |

- 是否需要 Lease 只看 Unit 定义中声明的受保护能力，与是否关联面向模型的 Tool 描述无关。
- model-call 的使用资格来自可信配置（Agent 定义声明的模型、配置的 provider），不需要 Lease。
  仓库内容只能经受保护 Unit 进入系统，因此外发给模型的仓库内容已由 `repo.read` 的用户同意覆盖。
- Planner 与 CodeViewer 的 Agent 定义都必须包含 `report-publish`、`context-assemble`、`model-call`；
  只有 CodeViewer 包含受保护 Unit。

Unit 与 Executor 的对应关系及执行点检查见 [ExecutorSet](../library/ExecutorSet.md)。

### 5.1 输出与产物引用

| Unit | UnitReport 中的小型结构化输出 | 产物引用 |
|---|---|---|
| repository-orient | 仓库概览摘要、`repositoryRevision`、`snapshotId` | `orientPackRef`（ORIENT ContextPack） |
| repository-search | 命中条目（路径、行范围、得分） | 检索 ContextPack |
| file-read | 路径、行范围、内容 SHA-256 | 读取结果 |
| context-assemble | `tokenCount`、`truncated`、`droppedCount` | `contextPackRef`（ASSEMBLE ContextPack） |
| model-call | 结构化动作（AnalysisAction） | 完整模型输出 |
| report-publish | — | `reportRef` |

产物引用按 handle 模型使用，类似进程的文件描述符：引用只是名字，每次使用时由 Kernel 检查归属。

- Workflow 只从 UnitReport 获得 ArtifactRef，并在后续 Unit 的输入中显式传递；不按运行或 AgentRun 搜索产物。
  Workflow 的来源核验与降级报告只使用 UnitReport 中的结构化输出，不读取产物正文。
- Agent 指令与工具 Schema 不作为 Workflow 传递的产物：context-assemble 由 Execution 依据该 AgentRun 登记的
  固定定义（`agentRef@digest`）解析。
- Unit 输入中的每个 ArtifactRef 必须属于同一 WorkflowRun；不属于本运行或不存在时，统一返回
  `OUT_OF_SCOPE`，不区分两者，以免泄露其他运行的产物是否存在。

## 6. 检查层次

| 层 | 执行者 | 对象 | 内容 | 不通过时 |
|---|---|---|---|---|
| Validation | Workflow | modelReturn 中的每个工具调用 | step1：属于 Agent 定义、参数合法、不超过 maxToolCallsPerRound；step2：软限制 | 交还模型（不进入 Kernel） |
| 准入 | Gateway | 所有 syscall | 来源、契约、准入封锁 | AdmissionException |
| 定义核验 | Core | 所有 Unit | AgentRun 已登记且为 ACTIVE、属于该运行；Unit 属于该 Agent 定义闭包 | Core 交付 UnitReport |
| 权限 | Core | 受保护 Unit | Lease 与用户授权（第 7 节） | Core 交付 UnitReport |
| 额度预留 | Core 调用 Scheduler、Monitor | model-call | 调用机会、token 预留 | Core 交付 UnitReport（第 8 节） |
| 执行点检查 | Executor | 受保护 Unit、model-call | 开发者硬编码的防护检查（见 [ExecutorSet](../library/ExecutorSet.md)） | 越界：UnitReport；违规：停止运行 |
| 结果检查 | Core | 进入执行的 Unit | 结果归属、运行状态、Lease 有效；model-call 结算 | 见 [Core](../kernel/Core.md) |

## 7. 仓库访问授权

- 询问发生在第一个受保护 Unit 到达权限检查时（CodeViewer 的 `repository-orient`），内容须说明仓库路径、
  排除规则，以及“读取的内容会发送至 <provider>”。
- 用户同意后，属于已同意范围的后续申请不再询问。
- 询问期间到达的同类申请等待同一结果；拒绝或超时后，本运行内同类申请直接返回 `USER_DECLINED`。
- 明确越界的请求直接返回 `OUT_OF_SCOPE`，不升级为新的授权申请。

Lease 的范围与签发逻辑见 [Core](../kernel/Core.md)。

## 8. 额度状态

- 只有 model-call 消耗 token；账本按 WorkflowRun 计，Planner 与 CodeViewer 共用。
- 每个 UnitReport 携带当前 budgetState，Workflow 据此收尾（见 [Workflow](Workflow.md) 第 6 节）：
  - `WRAP_UP`：执行完本轮剩余工具 Unit 后发起 final-call；
  - `EXHAUSTED`：不再发起 model-call，以已有材料生成降级报告。
- Kernel 为 final-call 保留额度：普通 model-call 不能使用这部分额度，因此进入 WRAP_UP 后 final-call 仍能发起。
- 额度不足时 Kernel 只拒绝 model-call 的预留（`BUDGET_WRAP_UP` 或 `BUDGET_EXHAUSTED`），不停止运行；
  被拒的 model-call 没有发出，不消耗 token。运行未被停止时，已经发出的 model-call 结果照常交付。
- 运行超时时 Kernel 停止运行：Workflow 收到 `RunClosed(RUN_TIMEOUT)` 后停止推进，不发起 final-call。

预留、结算与阈值的计算见 [Monitor](../kernel/Monitor.md)。

## 9. 结束方式与用户可见内容

| 方式 | 控制类别 | 控制终态 | Workflow 业务终态 | 用户看到 |
|---|---|---|---|---|
| 正常结束 | Syscall | CLOSED(COMPLETED) | COMPLETED | 结论、来源、未确认项 |
| final-call 收尾 | Syscall | CLOSED(COMPLETED) | COMPLETED | 同上，附收尾说明 |
| Workflow 失败 | Syscall | CLOSED(FAILED) | FAILED | 运行失败及原因 |
| 额度耗尽 | Syscall | CLOSED(COMPLETED) | COMPLETED | 结论或降级报告，附"已达到额度上限" |
| 运行超时 | Exception | CLOSED(RUN_TIMEOUT) | STOPPED(RUN_TIMEOUT) | "运行超时，已停止" |
| 用户终止 | Interruption | CLOSED(CANCELLED) | CANCELLED | 已终止 |
| 安全停止 | Exception | CLOSED(VIOLATION) | STOPPED(VIOLATION) | 因安全原因停止 |

用户默认只看到结果；步骤、Round 数、token、provider 请求次数、耗时与失败分类写入运行记录，
供评测与排查使用，用户可通过查看命令调出。

## 10. 原因码

| 原因码 | 出现在 | 含义 | Workflow 处理 |
|---|---|---|---|
| INVALID_ACTION | Workflow 内部 | Validation step1 失败 | 交还模型 |
| TOO_MANY_TOOL_CALLS | Workflow 内部 | 超过 maxToolCallsPerRound | 超出部分交还模型 |
| INVALID_REQUEST | AdmissionException | 契约不合法 | closeRun(FAILED) |
| RUN_TIMEOUT / CANCELLED / CLOSING / VIOLATION | AdmissionException | 处于准入封锁 | 停止推进，等待 RunClosed |
| AGENT_RUN_NOT_FOUND | UnitReport 或 SyscallAck（Core） | AgentRun 未登记或不属于该运行 | closeRun(FAILED) |
| AGENT_RUN_ENDED | UnitReport 或 SyscallAck（Core） | AgentRun 已结束后仍提交 | closeRun(FAILED) |
| FORBIDDEN | UnitReport（Core） | 不在定义闭包内或能力不可申请 | closeRun(FAILED) |
| USER_DECLINED | UnitReport（Core） | 用户拒绝或超时 | 交还模型，进入 final-call |
| BUDGET_WRAP_UP | UnitReport（Core） | 普通 model-call 的预留会占用 final-call 保留额度，未发出 | 发起 final-call |
| BUDGET_EXHAUSTED | UnitReport（Core） | 额度已不足以发起任何 model-call，未发出 | 以已有材料生成降级报告 |
| OUT_OF_SCOPE | UnitReport（权限检查、产物归属或执行点检查） | 越界、命中排除规则 | 交还模型 |
| LIMIT_EXCEEDED | UnitReport（执行点检查） | 输出超限 | 交还模型 |
| UNAVAILABLE / INTERNAL | UnitReport（执行失败，FAILED） | 技术重试后仍失败 | 交还模型或按业务处理 |

Round 上限与 WRAP_UP 不对应原因码。

运行处于收敛中时，Gateway 先以准入封锁拒绝请求，因此 AGENT_RUN_NOT_FOUND 与 AGENT_RUN_ENDED
只表示 Workflow 自身的状态错误。表中每种处理都以 closeRun 结束，或等待必然到来的 RunClosed，
见 [Workflow](Workflow.md) 第 10 节。

## 11. Exception 规则

1. 正常业务结果不提交 Exception：Validation 失败、Round 达到上限、WRAP_UP、额度耗尽、权限拒绝、执行点正常越界。
2. 以下由 Core 按 Exception 停止运行：运行超时（Core 计时）、安全违规（经 Supervisor、Execution）。
3. 以下只记入审计，不停止运行，由 Workflow 按原因码处理：契约错误（Gateway 报告）、定义核验失败与
   AgentRun 状态不符（Core）。重复结算数值冲突（Monitor）同样只记入审计，并按较大值记账。
4. 每个被受理的 `submitUnit` 要么收到 UnitReport，要么随 RunClosed 结束；Kernel 内部等待中的调用由 Core 以终止信号结束。
5. 仅凭 Executor 自报不升级为 panic。
