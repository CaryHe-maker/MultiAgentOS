# MultiAgentOS M1 Kernel（外部视角）

## 1. 目的与范围

本文从 Workflow 与 UserInteraction 的视角说明 M1 Kernel 提供的能力：

- 外部模块可以发起的 syscall 与请求，以及 Kernel 返回的信息；
- M1 的 Unit 清单、授权询问、额度状态、原因码与结束方式。

Kernel 内部组件的职责与交互见 [Kernel/Interaction](../Kernel/Interaction.md)，长期规划见
[Kernel 架构](../../Architecture/Module/Kernel.md)。字段级接口见 [M1Interface](../M1Interface.md)。

## 2. 运行边界

M1 Kernel 采用最小可行子集：Gateway、Core、Scheduler、Execution、Supervisor、Monitor 均承担真实职责，
共同完成一条受控的串行执行闭环，不以空接口代替核心行为。

| 维度 | M1 边界 |
|---|---|
| 运行组织 | 本地、单用户、单项目、单进程、单活动 Task；一个进程只创建一个运行；Planner 与 CodeViewer 通过单向交接串行运行，同一时刻至多一个 ACTIVE 的 AgentRun |
| 业务目标 | 只读仓库分析，支持模型、仓库概览、搜索、文件读取、上下文组装与报告发布 |
| 执行顺序 | 同一轮可提出多个工具调用，所有 Unit 统一按 FIFO 串行执行 |
| 信任边界 | 只运行可信的内置模块与 Executor |
| 只读约束 | 不修改被分析仓库，不执行项目命令或项目测试，不调用 git |
| 必要系统操作 | 允许受控的系统状态、Artifact、审计写入，以及获准的模型 API 请求；系统数据目录必须位于被分析仓库之外 |
| 资源限制 | token 额度按 WorkflowRun 计，Planner 与 CodeViewer 共用；运行总时长设上限 |
| 控制能力 | 支持取消与最终收敛；不提供暂停/恢复与崩溃续跑 |
| 用户交互 | 单次目标输入与最终输出；运行中支持终止和必要授权，访问仓库前收集一次 Y/N |

## 3. 术语

| 术语 | 定义 |
|---|---|
| 受保护 Unit | 定义中 `protectedCapabilities` 含 `repo.read` 的 Unit，需要 Lease |
| 非受保护 Unit | 未声明受保护能力的 Unit，依据开发者授权执行，无需 Lease |
| Lease | Core 私有的运行时授权记录，只存在于 Core |
| 额度 | 一次 WorkflowRun 可消耗的 token 上限，账本归 Monitor |
| budgetState | 额度状态：NORMAL、WRAP_UP（应收尾）、EXHAUSTED（不再允许 model-call）；只能前进 |
| 运行状态 | RUNNING、CONVERGING（收敛中）、CLOSED（已结束）；只能前进 |
| 准入封锁 | 运行不为 RUNNING 时，Gateway 与 Core 拒绝开启新工作的请求 |

Round、final-call 等 Workflow 概念见 [Workflow](Workflow.md)；runEpoch、收敛等 Kernel 内部概念见
[Kernel/Interaction](../Kernel/Interaction.md)。

### 3.1 控制语义

Kernel 与外部 Module 之间的交互，以及 Kernel 对执行的控制，统一用以下四个词描述。
这是对现有交互的分类，不引入新的组件或传输机制；传输仍由 Gateway、Fabric、Outbox 与 Inbox 完成。

| 词 | 指什么 | 规则 |
|---|---|---|
| Syscall | 外部 Module 向 Kernel 发起的请求（第 4.1、4.2 节） | 必须有调用者；经 Gateway 进入；以 `requestId` 幂等；同步返回受理或拒绝 |
| Event | Kernel 发给外部 Module 的结果与事实通知（第 4.4 节） | 由 Core 经 Outbox 主动发出；有序、可去重；接收方不能拒绝，只据此更新自己的状态 |
| Interruption | Kernel 经 Supervisor 要求在途执行停止（取消、截止时间到达） | 由 Core 决定、Supervisor 执行；发出不等于已停止，以执行事实确认 |
| Exception | 无法正常继续的故障（第 11 节） | 不跨通讯主体抛出；由 Core 收敛并写入审计 |

三者有因果关系：Syscall 可以产生 Interruption（`cancelRun` 使在途执行被要求停止），
Interruption 在宽限期内未被确认时产生 Exception（`EXECUTION_STOP_UNCONFIRMED`）。

单说 Syscall 时指外部 syscall。Kernel 内其他组件向 Core 发起的请求称为内部 syscall，二者的区别：

| | 外部 syscall | 内部 syscall |
|---|---|---|
| 必须经 Core 裁决 | 是 | 是 |
| 经过 Gateway 与 Fabric | 是 | 否，同步函数调用 |
| 校验调用方身份 | 是 | 否，Kernel 内组件互相可信 |
| 带 `requestId` 幂等 | 是 | 否 |
| 受理与完成分两步 | 是 | 否，当场返回裁决 |

Kernel 内部各方向的叫法（内部 syscall、职责接口调用、执行事实上报）见
[Kernel/Interaction](../Kernel/Interaction.md) 3.3。

## 4. syscall 与请求

外部模块申请受保护系统服务、执行能力或提交 Kernel 控制请求时，以 Gateway 为唯一入口。
组合根只把 `WorkflowGatewayPort` 注入 Workflow、只把 `InteractionGatewayPort` 注入 UserInteraction，
Gateway 按调用方身份拒绝越权请求（`CALLER_FORBIDDEN`）。

### 4.1 Workflow 的 syscall

| syscall | 何时调用 | 主要参数 | 成功时的回应 |
|---|---|---|---|
| `registerAgentRun` | 创建 AgentRun 时（运行开始、交接之后） | `workflowRunId, agentRunId, agentRef, requestId` | SyscallAck |
| `submitUnit` | 提交每个 Unit | `workflowRunId, agentRunId, unitRef, input, requestId` | SyscallAck，之后恰好一个 UnitReport |
| `endAgentRun` | 交接或报告发布之后 | `workflowRunId, agentRunId, requestId` | SyscallAck |
| `closeRun` | 报告发布之后，或 Workflow 判定无法继续 | `workflowRunId, outcome, reportRef 或 failure, requestId` | SyscallAck，收敛完成后 RunClosed |

### 4.2 UserInteraction 的请求

| 请求 | 用途 | 成功时的回应 |
|---|---|---|
| `createRun` | 提交用户目标与仓库路径 | RunCreated（带 Gateway 生成的 `workflowRunId`） |
| `answerAuthorization` | 回答 Core 发起的 Y/N 询问 | SyscallAck |
| `cancelRun` | 用户终止运行 | SyscallAck，收敛完成后 RunFinished |
| `readArtifact` | 按 ArtifactRef 读取本运行的产物（报告、运行摘要） | ArtifactContent |
| `shutdown` | 结果展示完成后请求关闭系统；运行中调用时先按取消收敛 | SyscallAck |

全部请求以 `requestId` 幂等：重复提交返回同一结果；相同 `requestId` 但内容不同返回 `REQUEST_CONFLICT`。

### 4.3 运行状态与请求处理

| 请求 | RUNNING | CONVERGING | CLOSED |
|---|---|---|---|
| `registerAgentRun`、`submitUnit` | 处理 | `RUN_BLOCKED` | `RUN_BLOCKED` |
| `endAgentRun` | 处理 | SyscallAck，无效果 | SyscallAck，无效果 |
| `closeRun` | 开始收敛 | SyscallAck，无效果 | SyscallAck，无效果 |
| `cancelRun` | 开始收敛（CANCELLED） | SyscallAck，无效果 | SyscallAck，无效果 |
| `answerAuthorization` | 处理 | `QUESTION_NOT_PENDING` | `QUESTION_NOT_PENDING` |
| `readArtifact` | 处理 | 处理 | 处理，直到系统关闭 |
| `shutdown` | 先按取消收敛，再关闭 | 收敛完成后关闭 | 关闭 |
| `createRun` | — | — | 本进程已有运行时返回 `RUN_LIMIT` |

原则：开启新工作的请求在封锁后一律拒绝；结束运行、读取结果、关闭系统的请求一律放行。

### 4.4 Kernel 的回应

Kernel 用两种方式回应外部模块：请求的直接返回值，以及投递到接收方 Inbox 的事件（Event，第 4.5 节）。
所有跨通讯主体的消息共用同一个信封 `Envelope<T>`（[M1Interface](../M1Interface.md) 3.2），下表各项只是载荷不同。

| 信息 | 方式 | 接收方 | 何时发出 |
|---|---|---|---|
| SyscallAck、RunCreated、ArtifactContent | 返回值 | 调用方 | 请求被受理 |
| SyscallRejected | 返回值 | 调用方 | 请求被 Gateway 或 Core 拒绝，带原因码与 `issuer` |
| RunStart | 事件 | Workflow | 运行创建后，第一个事件 |
| UnitReport | 事件 | Workflow | 每个得到 SyscallAck 的 `submitUnit` 的最终结果 |
| RunClosed | 事件 | Workflow | 收敛完成，最后一个事件 |
| AuthorizationRequest | 事件 | UserInteraction | 第一个受保护 Unit 到达权限检查且尚无授权 |
| AuthorizationResolved | 事件 | UserInteraction | 询问得到同意、拒绝、超时或因收敛取消 |
| RunFinished | 事件 | UserInteraction | 收敛完成，最后一个事件，内容与 RunClosed 相同 |

规则：

1. 得到 SyscallAck 的 `submitUnit`，要么恰好收到一个 UnitReport，要么随 RunClosed 结束（运行先进入收敛）。
2. 得到 SyscallRejected 的请求不产生任何后续事件。
3. 一个 WorkflowRun 恰好有一个 RunClosed 与一个 RunFinished；收到后接收方不再等待任何事件。
4. Workflow 按 `requestId` 对应 UnitReport，不依赖到达顺序；UnitReport 可能先于对应请求的 SyscallAck 到达。
5. UnitReport 只携带 budgetState，不携带额度数值；Workflow 不持有任何 token 数值。

### 4.5 Inbox 投递

Workflow 与 UserInteraction 各自实现一个 Inbox（`WorkflowInboxPort`、`InteractionInboxPort`），Kernel 经 Fabric 投递，
只依赖 contracts 中的接口。M1 的 Outbox 与 Inbox 为内存实现，不持久化，进程退出时一起丢失。投递语义参照 io_uring 完成队列：

1. **单一出口**：所有事件由 Core 的 Outbox 发出；其他组件不直接向外部模块发送。
2. **有序**：每个运行、每个接收方的 `seq` 从 1 连续递增，Outbox 按 `seq` 依次投递，前一个投递返回后才发下一个。
3. **可去重**：每个事件有唯一 `eventId`，接收方按 `eventId` 去重。
4. **受理语义**：`deliver` 只做 Schema 校验与入队即返回，不表示已经处理。
5. **终结**：RunClosed（对 UserInteraction 为 RunFinished）是该运行发给该接收方的最后一个事件；之前入队的事件都先于它投递。
6. **串行消费**：接收方按 Inbox 顺序逐条处理事件，处理期间可以等待自己发起的请求的返回值。
7. **投递失败**：只可能是 Schema 不合法，属于契约缺陷，不重试：该事件写入审计并被跳过，后续事件照常投递，运行以 `FAILED(KERNEL_INTERNAL)` 收敛
   （经内部消息 `KERNEL_FAULT`，见 [Kernel/Interaction](../Kernel/Interaction.md) 4.4）；RunClosed、RunFinished 本身投递失败时只写入审计。
   接收方按 `eventId` 去重、按到达顺序处理，不因 `seq` 出现缺口而等待。

## 5. M1 的 Unit

### 5.1 清单

| Unit | executionKind | 受保护 | 暴露给模型 | 消耗 token | 计入 Round | 执行者 |
|---|---|---|---|---|---|---|
| `repository-orient` | `REPOSITORY_ORIENT` | 是 | 否（CodeViewer 的启动 Unit） | 否 | 否 | Supervisor |
| `repository-search` | `REPOSITORY_SEARCH` | 是 | 是（`search_repository`） | 否 | 否 | Supervisor |
| `file-read` | `FILE_READ` | 是 | 是（`read_file`） | 否 | 否 | Supervisor |
| `context-assemble` | `CONTEXT_ASSEMBLE` | 否 | 否 | 否 | 否 | Supervisor |
| `model-call` | `MODEL` | 否 | 否 | 是 | 是 | Supervisor |
| `report-publish` | `REPORT_PUBLISH` | 否 | 否 | 否 | 否 | Execution（内建） |

- 是否需要 Lease 只看 Unit 定义中的 `protectedCapabilities`，与是否关联面向模型的工具无关。
- model-call 的使用资格来自可信配置（Agent 定义声明的模型、`KernelConfig.provider`），不需要 Lease。
  仓库内容只能经受保护 Unit 进入系统，因此外发给模型的仓库内容已由 `repo.read` 的用户同意覆盖；
  Core 在登记 AgentRun 时核对模型的 provider 与询问中告知用户的 provider 相同。
- 每个 Agent 定义都包含 `context-assemble`、`model-call`、`report-publish`；只有 CodeViewer 包含受保护 Unit。
- 定义实例见 [AgentToolPool](../Library/AgentToolPool.md) 第 4 节。

### 5.2 输出与产物引用

| Unit | UnitReport.output | UnitReport.outputRef |
|---|---|---|
| `repository-orient` | `RepositoryOrientOutput`（快照、文件数、概览摘要） | ORIENT ContextPack，即 `orientPackRef` |
| `repository-search` | `RepositorySearchOutput`（命中的路径、行范围、得分） | SEARCH ContextPack |
| `file-read` | `FileReadOutput`（路径、行范围、内容 SHA-256） | 读取的文本 |
| `context-assemble` | `ContextAssembleOutput`（token 数、裁剪信息） | ASSEMBLE ContextPack，即 `contextPackRef` |
| `model-call` | `ModelCallOutput`（结束原因、工具调用） | 模型完整输出 |
| `report-publish` | `ReportPublishOutput`（结论数、未确认数、是否降级） | `reportRef` |

产物引用按 handle 模型使用，类似进程的文件描述符：引用只是名字，每次使用时由 Kernel 检查归属。

- Workflow 只从 UnitReport 获得 ArtifactRef，并在后续 Unit 输入的指定位置显式传递（M1Interface 6.1）；不按运行或 AgentRun 搜索产物。
  Workflow 的来源核验与降级报告只使用 UnitReport 中的结构化输出，不读取产物正文。
- Unit 输入中的引用不属于本运行或不存在时，统一返回 `INVALID_ARTIFACT_REF`，不区分两者。

## 6. 检查层次

| 层 | 执行者 | 对象 | 内容 | 不通过时 |
|---|---|---|---|---|
| Validation | Workflow | 模型返回的每个工具调用 | step1：工具属于该 Agent、参数合法、不超过 `maxToolCallsPerRound`；step2：额度状态、重复调用与无进展 | 反馈给模型，不进入 Kernel |
| 准入 | Gateway | 所有请求 | 调用方身份、Schema、运行存在、准入封锁 | SyscallRejected（GATEWAY） |
| 定义核验 | Core | `registerAgentRun`、`submitUnit` | 定义固定与 digest；AgentRun 状态；Unit 属于固定闭包；能力受支持；输入符合 `inputContract` | SyscallRejected（CORE） |
| 权限 | Core | 受保护 Unit | Lease 与用户授权（第 7 节） | UnitReport `USER_DECLINED` |
| 产物引用 | Execution | 输入中的 ArtifactRef | 归属与完整性；model-call 的 ContextPack 与 `final` 一致 | UnitReport `INVALID_ARTIFACT_REF`、`INVALID_INPUT` |
| 额度预留 | Core 调用 Scheduler、Monitor | model-call | final-call 唯一、调用机会、token 预留 | UnitReport `BUDGET_*`、`FINAL_CALL_USED` |
| 执行点检查 | Executor | 受保护 Unit、model-call | 开发者硬编码的防护检查（[ExecutorSet](../Library/ExecutorSet.md) 3.2） | 越界：UnitReport；违规：以 VIOLATION 收敛 |
| 结果检查 | Core | 进入执行的 Unit | 归属、运行状态、Lease 有效；model-call 结算 | 见 [Core](../Kernel/Core.md) 第 5 节 |

## 7. 仓库访问授权

- 询问发生在第一个受保护 Unit 到达权限检查时（CodeViewer 的 `repository-orient`），内容为仓库路径、排除规则，
  以及“读取的内容会发送至 <provider>”。
- 用户同意后，本运行内后续的 `repo.read` 申请不再询问。
- 询问期间到达的同类申请等待同一结果；拒绝或超时后，本运行内同类申请直接返回 `USER_DECLINED`。
- 越出仓库或命中排除规则的路径由 Executor 返回 `OUT_OF_SCOPE`，不升级为新的授权申请。

Lease 的范围与签发逻辑见 [Core](../Kernel/Core.md) 第 4 节。

## 8. 额度状态

- 只有 model-call 消耗 token；账本按 WorkflowRun 计，Planner 与 CodeViewer 共用。
- 每个 UnitReport 携带当前 budgetState，Workflow 据此收尾（见 [Workflow](Workflow.md) 第 8 节）：
  - `WRAP_UP`：执行完本轮剩余工具 Unit 后发起 final-call；
  - `EXHAUSTED`：不再发起 model-call，以已有材料生成降级报告。
- Kernel 为 final-call 保留额度：普通 model-call 不能使用这部分额度，因此进入 WRAP_UP 后 final-call 仍能发起。
  每个运行至多一次 final-call，第二次申请返回 `FINAL_CALL_USED`。
- 额度不足时 Kernel 只拒绝 model-call 的预留（`BUDGET_WRAP_UP` 或 `BUDGET_EXHAUSTED`），不停止运行；
  被拒的 model-call 没有发出，不消耗 token。运行仍为 RUNNING 时，已经发出的 model-call 结果照常交付。
- 运行超时时 Kernel 停止运行：Workflow 收到 `RunClosed(RUN_TIMEOUT)` 后停止推进，不发起 final-call。

预留、结算与阈值的计算见 [Monitor](../Kernel/Monitor.md)。

## 9. 结束方式与用户可见内容

无论哪种方式结束，Core 都先完成收敛，再把结束原因、失败信息、未知效果与运行摘要一并经 RunFinished 交给 UserInteraction。

| 方式 | 触发来源 | closeReason | failure | Workflow 业务终态 | 用户看到 |
|---|---|---|---|---|---|
| 正常结束 | Syscall | COMPLETED | — | COMPLETED | 结论、来源、未确认项 |
| final-call 收尾 | Syscall | COMPLETED | — | COMPLETED | 同上，附收尾原因 |
| 额度耗尽 | Syscall | COMPLETED | — | COMPLETED | 降级报告，附“已达到额度上限” |
| final-call 不合法或失败 | Syscall | COMPLETED | — | COMPLETED | 降级报告，附收尾原因 |
| Workflow 判定失败 | Syscall | FAILED | `source = WORKFLOW`，`code` 为导致失败的原因码 | FAILED | “运行失败”及按原因码给出的说明 |
| Kernel 异常 | Exception | FAILED | `source = KERNEL`（`EXECUTION_STOP_UNCONFIRMED`、`KERNEL_INTERNAL`） | FAILED | 同上 |
| 运行超时 | Exception | RUN_TIMEOUT | — | STOPPED(RUN_TIMEOUT) | “运行超时，已停止” |
| 用户终止 | Syscall | CANCELLED | — | CANCELLED | “已终止” |
| 安全停止 | Exception | VIOLATION | `source = KERNEL`，违规原因码 | STOPPED(VIOLATION) | “因安全原因停止” |

存在未知效果时，用户还会看到“部分操作无法确认是否完成”。用户默认只看到结果；
运行摘要（各 AgentRun 的 Round、Unit 与模型调用次数、token、耗时、失败分类）可通过 CLI 的 `--details` 选项在关闭前读取展示；
步骤数属于 Workflow 的运行记录（[Workflow](Workflow.md) 第 13 节），不在运行摘要中。

触发来源指使运行进入收敛的控制类别（第 3.1 节）：Syscall 为 `closeRun` 或 `cancelRun`，Exception 见第 11 节。
无论哪种来源，收敛时 Kernel 都对在途执行发出 Interruption；宽限期内未确认停止的执行按 Exception 处理。

## 10. 原因码与 Workflow 处理

原因码的完整枚举与含义见 [M1Interface](../M1Interface.md) 3.4。Workflow 的处理方式：

| 来源 | 原因码 | Workflow 处理 |
|---|---|---|
| SyscallRejected | `RUN_BLOCKED` | 停止推进，等待 RunClosed |
| SyscallRejected | 其他全部原因码 | `closeRun(FAILED)`，`failure.code` 为该原因码 |
| UnitReport | 任意 `REJECTED`、`FAILED` 的原因码 | 按该 Unit 定义的 `failurePolicy` 处理（[Workflow](Workflow.md) 第 7 节）；未列出的按 `FATAL`；final-call 的 model-call 失败一律生成降级报告 |
| RunClosed | 任意 closeReason | 停止推进，记录业务终态 |

Validation 失败（`INVALID_ACTION`、`UNKNOWN_TOOL`、`INVALID_ARGUMENTS`、`TOO_MANY_TOOL_CALLS`、`DUPLICATE_CALL`）
是 Workflow 内部的反馈码（`FeedbackCode`），不是 Kernel 原因码。Round 上限与 WRAP_UP 不对应原因码。

## 11. Exception 规则

1. 正常业务结果不进入 Exception：Validation 失败、Round 达到上限、WRAP_UP、额度耗尽、权限拒绝、执行点正常越界。
2. 以下由 Core 按 Exception 收敛：运行超时（Core 计时）、安全违规（经 Supervisor、Execution）、执行停止未确认、Kernel 内部错误。
3. 请求被拒（SyscallRejected）不停止运行，由 Workflow 按第 10 节处理；Core 拒绝的请求写入审计，Gateway 拒绝的请求写入 Gateway 的结构化日志。
4. 重复结算的数值冲突由 Monitor 按较大值记账，并由 Core 写入审计，不停止运行。
5. 每个被受理的 `submitUnit` 要么收到 UnitReport，要么随 RunClosed 结束。
6. 仅凭 Executor 自报不升级为 panic。
